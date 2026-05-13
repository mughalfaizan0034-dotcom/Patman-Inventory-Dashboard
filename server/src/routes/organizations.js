import { authenticate, requireRole } from '../middleware/authenticate.js';
import { AppError } from '../utils/errors.js';
import { z } from 'zod';

const createOrgSchema = z.object({
  display_name:    z.string().min(1).max(100),
  slug:            z.string().min(2).max(40).regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  // Every org must have at least one member. The creating admin counts —
  // they're auto-included server-side if not present in this list.
  member_user_ids: z.array(z.string().uuid()).min(1),
});

// Slug is locked after creation — it's the URL identifier and changing it
// would break bookmarks/integrations. Only display_name, member roster,
// and active status can change.
const updateOrgSchema = z.object({
  display_name:    z.string().min(1).max(100).optional(),
  is_active:       z.boolean().optional(),
  member_user_ids: z.array(z.string().uuid()).min(1).optional(),
});

export async function organizationsRoutes(fastify, { orgsRepo, membershipsRepo, usersRepo }) {
  const { randomUUID } = await import('crypto');

  // Reconcile an org's member roster with a target list of user_ids.
  //   - Deactivate memberships not in target.
  //   - Reactivate (and re-role to mirror users.role) existing memberships in target.
  //   - Create new memberships for users newly added.
  async function syncOrgMembers(organizationId, targetUserIds) {
    const current = await membershipsRepo.findAllByOrg(organizationId);
    const targetSet = new Set(targetUserIds);
    const currentByUser = new Map();
    for (const m of current) currentByUser.set(m.user_id, m);

    // Deactivate active memberships not in target.
    for (const m of current) {
      if (m.is_active && !targetSet.has(m.user_id)) {
        await membershipsRepo.updateMembership(m.membership_id, { is_active: false });
      }
    }

    // Add or reactivate memberships in target. Each new/updated membership
    // mirrors the user's global users.role for legacy consistency.
    for (const userId of targetUserIds) {
      const user = await usersRepo.findById(userId);
      if (!user) throw new AppError(400, `User ${userId} does not exist`);
      const role = user.role || 'viewer';

      const existing = currentByUser.get(userId);
      if (existing) {
        const patch = {};
        if (!existing.is_active)         patch.is_active = true;
        if (existing.role     !== role)  patch.role      = role;
        if (Object.keys(patch).length) {
          await membershipsRepo.updateMembership(existing.membership_id, patch);
        }
      } else {
        await membershipsRepo.createMembership({
          membership_id:   randomUUID(),
          user_id:         userId,
          organization_id: organizationId,
          role,
        });
      }
    }
  }

  // List all organizations (super_admin only for now).
  fastify.get('/', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    try {
      const data = await orgsRepo.findAll();
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Orgs list error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // Create a new organization.
  fastify.post('/', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const parsed = createOrgSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body', details: parsed.error.flatten() });
    }
    try {
      const existing = await orgsRepo.findBySlug(parsed.data.slug);
      if (existing) return reply.code(409).send({ success: false, error: 'Organization slug already exists' });

      const orgId = randomUUID();
      await orgsRepo.insert({
        organization_id: orgId,
        slug:            parsed.data.slug,
        display_name:    parsed.data.display_name,
        is_active:       true,
      });

      // Automatically add the creating user as admin of the new org.
      await membershipsRepo.createMembership({
        membership_id:   randomUUID(),
        user_id:         request.user.user_id,
        organization_id: orgId,
        role:            'admin',
      });

      request.log.info({ event: 'org_created', organization_id: orgId, by: request.user.user_id }, 'Organization created');
      return reply.code(201).send({ success: true, data: { organization_id: orgId, ...parsed.data } });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ success: false, error: err.message });
      }
      request.log.error({ err }, 'Create org error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // Update organization metadata.
  fastify.patch('/:id', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const parsed = updateOrgSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body' });
    }
    try {
      const org = await orgsRepo.findById(request.params.id);
      if (!org) return reply.code(404).send({ success: false, error: 'Organization not found' });

      await orgsRepo.update(request.params.id, parsed.data);
      return reply.send({ success: true });
    } catch (err) {
      request.log.error({ err }, 'Update org error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
