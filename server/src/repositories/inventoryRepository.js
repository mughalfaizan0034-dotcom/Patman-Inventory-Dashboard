import { TABLES } from '../config/tables.js';

export function createInventoryRepository({ bq, projectId }) {
  const table = `\`${projectId}.${TABLES.INVENTORY}\``;

  // organizationId is mandatory — never omit it.
  async function findAll({ organizationId, page, pageSize, search, platform, status, sortBy, sortDir }) {
    const offset = (page - 1) * pageSize;

    const conditions = ['organization_id = @organizationId'];
    const params     = { organizationId };

    if (search) {
      conditions.push('(LOWER(sku) LIKE @search OR LOWER(name) LIKE @search)');
      params.search = `%${search.toLowerCase()}%`;
    }
    if (platform) {
      conditions.push('platform = @platform');
      params.platform = platform;
    }
    if (status !== 'all') {
      conditions.push('is_active = @isActive');
      params.isActive = status === 'active';
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const allowedSort = ['sku', 'name', 'platform', 'stock', 'updated_at'];
    const col = allowedSort.includes(sortBy) ? sortBy : 'updated_at';
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

    const dataQuery = `
      SELECT
        sku, name, platform, is_active,
        initial_stock, units_sold, units_returned,
        (initial_stock - units_sold + units_returned) AS stock,
        updated_at
      FROM ${table}
      ${where}
      ORDER BY ${col} ${dir}
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM ${table}
      ${where}
    `;

    const [rows, countRows] = await Promise.all([
      bq.query({ query: dataQuery, params }),
      bq.query({ query: countQuery, params }),
    ]);

    return {
      items: rows[0],
      total: Number(countRows[0][0]?.total ?? 0),
    };
  }

  return { findAll };
}
