import { TABLES } from '../config/tables.js';

export function createOrdersRepository({ bq, projectId }) {
  const table = `\`${projectId}.${TABLES.ORDERS}\``;

  async function findAll({ organizationId, page, pageSize, platform, startDate, endDate, search }) {
    const offset = (page - 1) * pageSize;

    const conditions = ['organization_id = @organizationId'];
    const params     = { organizationId };

    if (platform) {
      conditions.push('platform = @platform');
      params.platform = platform;
    }
    if (startDate) {
      conditions.push('order_date >= @startDate');
      params.startDate = startDate;
    }
    if (endDate) {
      conditions.push('order_date <= @endDate');
      params.endDate = endDate;
    }
    if (search) {
      conditions.push('LOWER(sku) LIKE @search');
      params.search = `%${search.toLowerCase()}%`;
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const dataQuery = `
      SELECT order_date, sku, quantity_sold, shipped_from_box, platform, created_at
      FROM ${table}
      ${where}
      ORDER BY order_date DESC, created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;
    const countQuery = `SELECT COUNT(*) AS total FROM ${table} ${where}`;

    const [rows, countRows] = await Promise.all([
      bq.query({ query: dataQuery, params }),
      bq.query({ query: countQuery, params }),
    ]);

    return {
      items: rows[0].map(r => ({ ...r, created_at: r.created_at?.value ?? r.created_at ?? null })),
      total: Number(countRows[0][0]?.total ?? 0),
    };
  }

  async function getPlatforms(organizationId) {
    const query = `
      SELECT DISTINCT platform
      FROM ${table}
      WHERE organization_id = @organizationId
        AND platform IS NOT NULL
      ORDER BY platform
    `;
    const [rows] = await bq.query({ query, params: { organizationId } });
    return rows.map(r => r.platform);
  }

  return { findAll, getPlatforms };
}
