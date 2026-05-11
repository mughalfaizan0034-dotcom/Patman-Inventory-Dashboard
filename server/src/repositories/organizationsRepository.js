import { TABLES } from '../config/tables.js';

export function createOrganizationsRepository({ bq, projectId }) {
  const table = `\`${projectId}.${TABLES.ORGANIZATIONS}\``;

  async function findBySlug(slug) {
    const query = `
      SELECT organization_id, slug, display_name, is_active
      FROM ${table}
      WHERE slug = @slug AND is_active = TRUE
      LIMIT 1
    `;
    const [rows] = await bq.query({ query, params: { slug } });
    return rows[0] ?? null;
  }

  async function findById(organizationId) {
    const query = `
      SELECT organization_id, slug, display_name, is_active
      FROM ${table}
      WHERE organization_id = @organizationId
      LIMIT 1
    `;
    const [rows] = await bq.query({ query, params: { organizationId } });
    return rows[0] ?? null;
  }

  async function findAll() {
    const query = `
      SELECT organization_id, slug, display_name, is_active, created_at
      FROM ${table}
      ORDER BY display_name
    `;
    const [rows] = await bq.query({ query });
    return rows;
  }

  async function insert(org) {
    const query = `
      INSERT INTO ${table}
        (organization_id, slug, display_name, is_active, created_at)
      VALUES
        (@organization_id, @slug, @display_name, @is_active, CURRENT_TIMESTAMP())
    `;
    await bq.query({ query, params: org });
  }

  async function update(organizationId, updates) {
    const allowed    = ['display_name', 'slug', 'is_active'];
    const setClauses = Object.keys(updates)
      .filter(k => allowed.includes(k))
      .map(k => `${k} = @${k}`);
    if (!setClauses.length) return;
    const query = `
      UPDATE ${table}
      SET ${setClauses.join(', ')}
      WHERE organization_id = @organizationId
    `;
    await bq.query({ query, params: { ...updates, organizationId } });
  }

  return { findBySlug, findById, findAll, insert, update };
}
