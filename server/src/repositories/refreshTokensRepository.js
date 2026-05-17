import { TABLES } from '../config/tables.js';

// ============================================================
// refreshTokensRepository — server-side refresh-token revocation
// ------------------------------------------------------------
// Closes audit gap C2 (was a stub before 2026-05-18). Every refresh
// token the platform mints is recorded here so /auth/refresh and
// /auth/logout can REJECT tokens that have been revoked, even if
// their JWT signature is still cryptographically valid.
//
// Lifecycle:
//   1. Login (or select-org)  → insert(...) with fresh jti + family_id.
//   2. /auth/refresh          → getActive(jti) to validate, then revoke
//                               the old jti and insert a new one in the
//                               same family.
//   3. /auth/logout           → revoke(jti) for the current refresh.
//   4. Password change        → revokeAllByUserId(userId) so every
//                               active device is logged out.
//   5. (Future) Logout-all    → revokeAllByUserId(userId).
//
// Notes:
//   - `getActive` returns null for: not-found, revoked, or expired.
//     The caller never needs to inspect timestamps directly.
//   - All writes are single-row DML — fast (<200ms typical) and the
//     volume is bounded by login/refresh frequency.
// ============================================================

export function createRefreshTokensRepository({ bq, projectId }) {
  const refreshTokensTable = `\`${projectId}.${TABLES.REFRESH_TOKENS}\``;

  async function insert({ jti, userId, familyId, expiresAt, remembered, userAgent, ip }) {
    if (!jti || !userId || !familyId || !expiresAt) {
      throw new Error('refreshTokensRepository.insert: missing required field');
    }
    const query = `
      INSERT INTO ${refreshTokensTable}
        (jti, user_id, family_id, expires_at, remembered, user_agent, ip)
      VALUES
        (@jti, @userId, @familyId, @expiresAt, @remembered, @userAgent, @ip)
    `;
    await bq.query({
      query,
      params: {
        jti, userId, familyId,
        expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
        remembered: !!remembered,
        userAgent: _truncate(userAgent, 256) ?? null,
        ip:        _truncate(ip,        64)  ?? null,
      },
      types: { userAgent: 'STRING', ip: 'STRING', expiresAt: 'TIMESTAMP' },
    });
  }

  // Returns the row if the token is currently usable, else null.
  // Treats "not found", "revoked", and "expired" as the SAME null
  // result — the auth route only needs a boolean "valid?" answer.
  async function getActive(jti) {
    if (!jti) return null;
    const query = `
      SELECT jti, user_id, family_id, expires_at, revoked_at, remembered, last_used_at
      FROM ${refreshTokensTable}
      WHERE jti = @jti
        AND revoked_at IS NULL
        AND expires_at > CURRENT_TIMESTAMP()
      LIMIT 1
    `;
    try {
      const [rows] = await bq.query({ query, params: { jti } });
      const r = rows[0];
      if (!r) return null;
      return {
        jti:          r.jti,
        user_id:      r.user_id,
        family_id:    r.family_id,
        expires_at:   r.expires_at?.value   ?? r.expires_at,
        revoked_at:   r.revoked_at?.value   ?? r.revoked_at,
        remembered:   !!r.remembered,
        last_used_at: r.last_used_at?.value ?? r.last_used_at,
      };
    } catch {
      return null;
    }
  }

  // Idempotent revoke. Re-revoking a revoked token is a no-op
  // (WHERE revoked_at IS NULL won't match).
  async function revoke(jti) {
    if (!jti) return;
    const query = `
      UPDATE ${refreshTokensTable}
      SET revoked_at = CURRENT_TIMESTAMP()
      WHERE jti = @jti AND revoked_at IS NULL
    `;
    try { await bq.query({ query, params: { jti } }); }
    catch { /* non-fatal — the JWT is still expiring naturally */ }
  }

  // Revoke every active token in a rotation family. Wired but not
  // called yet — rotation-chain replay detection is a future
  // enhancement (deliberately deferred per Phase A design).
  async function revokeFamily(familyId) {
    if (!familyId) return;
    const query = `
      UPDATE ${refreshTokensTable}
      SET revoked_at = CURRENT_TIMESTAMP()
      WHERE family_id = @familyId AND revoked_at IS NULL
    `;
    try { await bq.query({ query, params: { familyId } }); }
    catch { /* non-fatal */ }
  }

  // Revoke every active token for a user. Called by:
  //   - password-change route (logs out every device)
  //   - future /auth/logout-all
  // Table is clustered by user_id so this only scans that user's rows.
  async function revokeAllByUserId(userId) {
    if (!userId) return 0;
    const query = `
      UPDATE ${refreshTokensTable}
      SET revoked_at = CURRENT_TIMESTAMP()
      WHERE user_id = @userId AND revoked_at IS NULL
    `;
    try {
      const [job] = await bq.query({ query, params: { userId } });
      return job?.numDmlAffectedRows ? Number(job.numDmlAffectedRows) : 0;
    } catch {
      return 0;
    }
  }

  // Stamp last_used_at after a successful refresh. Used by future
  // "Active Sessions" UI; not load-bearing for security.
  async function markUsed(jti) {
    if (!jti) return;
    const query = `
      UPDATE ${refreshTokensTable}
      SET last_used_at = CURRENT_TIMESTAMP()
      WHERE jti = @jti
    `;
    try { await bq.query({ query, params: { jti } }); }
    catch { /* non-fatal */ }
  }

  return { insert, getActive, revoke, revokeFamily, revokeAllByUserId, markUsed };
}

function _truncate(s, n) {
  if (s == null) return null;
  const str = String(s);
  return str.length > n ? str.slice(0, n) : str;
}
