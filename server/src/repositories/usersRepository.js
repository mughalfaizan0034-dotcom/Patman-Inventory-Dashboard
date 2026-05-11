import { TABLES } from '../config/tables.js';

export function createUsersRepository({ bq, projectId }) {
  const table = `\`${projectId}.${TABLES.USERS}\``;

  async function findByEmail(email) {
    const query = `
      SELECT user_id, email, password_hash, role, display_name, is_active
      FROM ${table}
      WHERE email = @email
      LIMIT 1
    `;
    const [rows] = await bq.query({ query, params: { email } });
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

  return { findByEmail, updatePasswordHash };
}
