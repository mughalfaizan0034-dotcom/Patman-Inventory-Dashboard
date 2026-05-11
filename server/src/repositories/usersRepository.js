import { TABLES } from '../config/tables.js';

export function createUsersRepository({ bq, projectId }) {
  const table = `\`${projectId}.${TABLES.USERS}\``;

  async function findByUsername(organizationId, username) {
    const query = `
      SELECT user_id, organization_id, username, email, password_hash,
             display_name, role, is_active
      FROM ${table}
      WHERE organization_id = @organizationId
        AND username = @username
      LIMIT 1
    `;
    const [rows] = await bq.query({ query, params: { organizationId, username } });
    return rows[0] ?? null;
  }

  async function findById(userId) {
    const query = `
      SELECT user_id, organization_id, username, email, password_hash,
             display_name, role, is_active
      FROM ${table}
      WHERE user_id = @userId
      LIMIT 1
    `;
    const [rows] = await bq.query({ query, params: { userId } });
    return rows[0] ?? null;
  }

  async function findByEmail(organizationId, email) {
    const query = `
      SELECT user_id, organization_id, username, email, password_hash,
             display_name, role, is_active
      FROM ${table}
      WHERE organization_id = @organizationId
        AND email = @email
      LIMIT 1
    `;
    const [rows] = await bq.query({ query, params: { organizationId, email } });
    return rows[0] ?? null;
  }

  async function updatePasswordHash(userId, passwordHash) {
    const query = `
      UPDATE ${table}
      SET password_hash = @passwordHash, updated_at = CURRENT_TIMESTAMP()
      WHERE user_id = @userId
    `;
    await bq.query({ query, params: { passwordHash, userId } });
  }

  return { findByUsername, findById, findByEmail, updatePasswordHash };
}
