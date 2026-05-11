import { TABLES } from '../config/tables.js';

export function createOrganizationsRepository({ bq, projectId }) {
  const table = `\`${projectId}.${TABLES.ORGANIZATIONS}\``;

  async function findBySlug(slug) {
    const query = `
      SELECT organization_id, slug, display_name, is_active
      FROM ${table}
      WHERE slug = @slug
        AND is_active = TRUE
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

  return { findBySlug, findById };
}
