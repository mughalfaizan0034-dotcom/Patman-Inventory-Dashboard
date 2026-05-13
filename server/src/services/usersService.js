import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { AppError } from '../utils/errors.js';

const BCRYPT_ROUNDS = 12;
const VALID_ROLES   = ['admin', 'manager', 'staff', 'viewer'];

export function createUsersService({ usersRepo, membershipsRepo, usernameService }) {

  // List members of a given organization (via memberships join).
  async function list(organizationId) {
    return membershipsRepo.getMembersByOrg(organizationId);
  }

  // Find global user by username — used by the "add existing user" flow.
  async function findByUsername(username) {
    const user = await usersRepo.findByUsernameGlobal(username);
    if (!user) return null;
    return {
      user_id:      user.user_id,
      username:     user.username,
      display_name: user.display_name,
      is_active:    user.is_active,
    };
  }

  // Create a new global user AND one or more memberships.
  //
  // Inputs:
  //   display_name      — required, shown in UI
  //   username          — required, globally unique; admin verified availability via /users/check-username
  //   password          — required, min 8 chars
  //   role              — required, one of VALID_ROLES (applied to every assigned org membership)
  //   organization_ids  — required, non-empty array of org UUIDs to assign membership in
  //
  // Settings is treated as outside any org context — the admin's "current
  // workspace" is irrelevant here. They explicitly choose the orgs for the
  // new user. No automatic injection.
  // eslint-disable-next-line no-unused-vars
  async function create(_creatingOrgId, { display_name, username, password, role, organization_ids }) {
    if (!display_name?.trim()) throw new AppError(400, 'display_name is required');
    if (!username?.trim())     throw new AppError(400, 'username is required');
    if (!password || password.length < 8) throw new AppError(400, 'Password must be at least 8 characters');
    if (!role || !VALID_ROLES.includes(role)) {
      throw new AppError(400, `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
    }

    const orgIds = Array.isArray(organization_ids) ? [...new Set(organization_ids.filter(Boolean))] : [];
    if (!orgIds.length) throw new AppError(400, 'organization_ids must include at least one organization');

    const normalized = usernameService.normalize(username);
    if (!usernameService.isValid(normalized)) {
      throw new AppError(400, 'Username must be 2–32 characters, lowercase letters / numbers / underscores only');
    }
    if (!await usernameService.isAvailable(normalized)) {
      throw new AppError(409, `Username "${normalized}" is already taken`);
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId       = randomUUID();

    await usersRepo.insert({
      user_id:       userId,
      username:      normalized,
      display_name:  display_name.trim(),
      password_hash: passwordHash,
      is_active:     true,
    });

    const memberships = [];
    for (const orgId of orgIds) {
      const membershipId = randomUUID();
      await membershipsRepo.createMembership({
        membership_id:   membershipId,
        user_id:         userId,
        organization_id: orgId,
        role,
      });
      memberships.push({ membership_id: membershipId, organization_id: orgId, role });
    }

    return { user_id: userId, username: normalized, display_name: display_name.trim(), role, memberships };
  }

  // Live username availability check used by the Add User form.
  // Returns { username, valid, available, suggestions }.
  // suggestions[] is populated only when the requested username is unavailable.
  async function checkUsername(username) {
    const normalized = usernameService.normalize(username || '');
    if (!usernameService.isValid(normalized)) {
      return { username: normalized, valid: false, available: false, suggestions: [] };
    }
    const available = await usernameService.isAvailable(normalized);
    if (available) return { username: normalized, valid: true, available: true, suggestions: [] };
    const suggestions = await usernameService.suggest(normalized, 5);
    return { username: normalized, valid: true, available: false, suggestions };
  }

  // Update membership and/or user profile.
  // Accepted fields: role, is_active (membership) | display_name, password (user profile).
  async function updateUser(membershipId, organizationId, updates) {
    const membership = await membershipsRepo.getMembershipById(membershipId);
    if (!membership || membership.organization_id !== organizationId) {
      throw new AppError(404, 'Membership not found');
    }

    const membershipUpdates = {};
    if (updates.role !== undefined) {
      if (!VALID_ROLES.includes(updates.role)) {
        throw new AppError(400, `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
      }
      membershipUpdates.role = updates.role;
    }
    if (updates.is_active !== undefined) membershipUpdates.is_active = updates.is_active;

    if (Object.keys(membershipUpdates).length > 0) {
      await membershipsRepo.updateMembership(membershipId, membershipUpdates);
    }

    if (updates.display_name !== undefined) {
      await usersRepo.update(membership.user_id, { display_name: updates.display_name.trim() });
    }

    if (updates.password !== undefined) {
      if (updates.password.length < 8) throw new AppError(400, 'Password must be at least 8 characters');
      const hash = await bcrypt.hash(updates.password, BCRYPT_ROUNDS);
      await usersRepo.updatePasswordHash(membership.user_id, hash);
    }
  }

  // Kept for backwards-compat with existing route (membership-only updates).
  async function updateMembership(membershipId, organizationId, updates) {
    return updateUser(membershipId, organizationId, updates);
  }

  // Deactivate membership (does not delete global user account).
  async function deactivateMembership(membershipId, organizationId, requestingMembershipId) {
    if (membershipId === requestingMembershipId) throw new AppError(400, 'Cannot remove your own membership');
    const membership = await membershipsRepo.getMembershipById(membershipId);
    if (!membership || membership.organization_id !== organizationId) {
      throw new AppError(404, 'Membership not found');
    }
    await membershipsRepo.updateMembership(membershipId, { is_active: false });
  }

  return { list, findByUsername, create, checkUsername, updateUser, updateMembership, deactivateMembership };
}
