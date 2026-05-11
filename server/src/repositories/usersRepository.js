import { TABLES } from '../config/tables.js';

export function createUsersRepository({ bq, projectId }) {
  const table = `\`${projectId}.${TABLES.USERS}\``;

  // Global lookup — usernames are unique across the platform.
  async function findByUsernameGlobal(username) {
    const query = `
      SELECT user_id, username, email, password_hash, display_name, is_active
      FROM ${table}
      WHERE username  = @username
        AND is_active = TRUE
      LIMIT 1
    `;
    const [rows] = await bq.query({ query, params: { username } });
    return rows[0] ?? null;
  }

  async function findById(userId) {
    const query = `
      SELECT user_id, username, email, password_hash, display_name, is_active
      FROM ${table}
      WHERE user_id = @userId
      LIMIT 1
    `;
    const [rows] = await bq.query({ query, params: { userId } });
    return rows[0] ?? null;
  }

  async function findAll() {
    const query = `
      SELECT user_id, username, email, display_name, is_active, created_at
      FROM ${table}
      ORDER BY display_name
    `;
    const [rows] = await bq.query({ query });
    return rows;
  }

  async function insert(user) {
    const query = `
      INSERT INTO ${table}
        (user_id, username, email, display_name, password_hash, is_active, created_at, updated_at)
      VALUES
        (@user_id, @username, @email, @display_name, @password_hash,
         @is_active, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())
    `;
    await bq.query({ query, params: user });
  }

  async function update(userId, updates) {
    const allowed    = ['display_name', 'is_active'];
    const setClauses = Object.keys(updates)
      .filter(k => allowed.includes(k))
      .map(k => `${k} = @${k}`);
    if (!setClauses.length) return;
    const query = `
      UPDATE ${table}
      SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP()
      WHERE user_id = @userId
    `;
    await bq.query({ query, params: { ...updates, userId } });
  }

  async function updatePasswordHash(userId, passwordHash) {
    const query = `
      UPDATE ${table}
      SET password_hash = @passwordHash, updated_at = CURRENT_TIMESTAMP()
      WHERE user_id = @userId
    `;
    await bq.query({ query, params: { passwordHash, userId } });
  }

  return { findByUsernameGlobal, findById, findAll, insert, update, updatePasswordHash };
}
