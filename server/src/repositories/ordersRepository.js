import { TABLES } from '../config/tables.js';

export function createOrdersRepository({ bq, projectId }) {
  const table    = `\`${projectId}.${TABLES.ORDERS}\``;
  const invTable = `\`${projectId}.${TABLES.INVENTORY}\``;

  // Reusable SQL: phantom SKU subquery (SKUs where inventory remaining < 0)
  const _phantomSkuSubquery = () => `
    SELECT i.sku
    FROM (
      SELECT sku, SUM(quantity) AS qty
      FROM ${invTable}
      WHERE organization_id = @organizationId
      GROUP BY sku
    ) i
    LEFT JOIN (
      SELECT
        CASE
          WHEN shipped_from_box IS NOT NULL
               AND TRIM(CAST(shipped_from_box AS STRING)) != ''
               AND REGEXP_CONTAINS(sku, r'^ARA[0-9]+-.+$')
          THEN CONCAT('ARA', TRIM(CAST(shipped_from_box AS STRING)),
                      REGEXP_EXTRACT(sku, r'^ARA[0-9]+(.+)$'))
          ELSE sku
        END AS effective_sku,
        SUM(quantity_sold) AS sold
      FROM ${table}
      WHERE organization_id = @organizationId
        AND COALESCE(is_ignored, FALSE) = FALSE
      GROUP BY effective_sku
    ) ord ON i.sku = ord.effective_sku
    WHERE i.qty - COALESCE(ord.sold, 0) < 0
  `;

  // Build the WHERE clause extension for the status filter.
  // inv_skus CTE must be in scope when the query uses 'unknown' or 'normal'.
  function _statusCondition(status) {
    switch (status) {
      case 'phantom':
        return `AND COALESCE(o.mapped_inventory_sku, o.sku) IN (${_phantomSkuSubquery()})
                AND COALESCE(o.is_ignored, FALSE) = FALSE`;
      case 'unknown':
        return `AND inv.sku IS NULL
                AND COALESCE(o.is_ignored, FALSE) = FALSE`;
      case 'ignored':
        return `AND COALESCE(o.is_ignored, FALSE) = TRUE`;
      case 'normal':
        return `AND inv.sku IS NOT NULL
                AND COALESCE(o.is_ignored, FALSE) = FALSE
                AND COALESCE(o.mapped_inventory_sku, o.sku) NOT IN (${_phantomSkuSubquery()})`;
      default: // 'all'
        return '';
    }
  }

  async function findAll({ organizationId, page, pageSize, platform, startDate, endDate, search, sortBy, sortDir, status }) {
    const offset = (page - 1) * pageSize;
    const params = { organizationId };

    const conditions = ['o.organization_id = @organizationId'];
    if (platform)  { conditions.push('o.platform = @platform');         params.platform  = platform; }
    if (startDate) { conditions.push('o.order_date >= @startDate');     params.startDate = startDate; }
    if (endDate)   { conditions.push('o.order_date <= @endDate');       params.endDate   = endDate; }
    if (search)    { conditions.push('LOWER(o.sku) LIKE @search');      params.search    = `%${search.toLowerCase()}%`; }

    const baseWhere  = conditions.join(' AND ');
    const statusCond = _statusCondition(status || 'all');

    const ALLOWED_SORT = ['order_date', 'sku', 'quantity_sold', 'platform', 'shipped_from_box'];
    const col = ALLOWED_SORT.includes(sortBy) ? `o.${sortBy}` : 'o.order_date';
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

    const dataQuery = `
      WITH inv_skus AS (
        SELECT DISTINCT sku FROM ${invTable} WHERE organization_id = @organizationId
      )
      SELECT
        o.order_row_id, o.order_date, o.sku, o.quantity_sold, o.shipped_from_box, o.platform, o.created_at,
        COALESCE(o.mapped_inventory_sku, '') AS mapped_inventory_sku,
        COALESCE(o.is_ignored, FALSE)        AS is_ignored,
        (inv.sku IS NULL)                    AS is_unknown
      FROM ${table} o
      LEFT JOIN inv_skus inv ON COALESCE(o.mapped_inventory_sku, o.sku) = inv.sku
      WHERE ${baseWhere} ${statusCond}
      ORDER BY ${col} ${dir}, o.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    const countQuery = `
      WITH inv_skus AS (
        SELECT DISTINCT sku FROM ${invTable} WHERE organization_id = @organizationId
      )
      SELECT COUNT(*) AS total
      FROM ${table} o
      LEFT JOIN inv_skus inv ON COALESCE(o.mapped_inventory_sku, o.sku) = inv.sku
      WHERE ${baseWhere} ${statusCond}
    `;

    const [rows, countRows] = await Promise.all([
      bq.query({ query: dataQuery, params }),
      bq.query({ query: countQuery, params }),
    ]);

    return {
      items: rows[0].map(r => ({ ...r, created_at: r.created_at?.value ?? r.created_at ?? null })),
      total: Number(countRows[0][0]?.total ?? 0),
    };
  }

  async function exportAll({ organizationId, platform, startDate, endDate, search, sortBy, sortDir, status }) {
    const params = { organizationId };

    const conditions = ['o.organization_id = @organizationId'];
    if (platform)  { conditions.push('o.platform = @platform');    params.platform  = platform; }
    if (startDate) { conditions.push('o.order_date >= @startDate'); params.startDate = startDate; }
    if (endDate)   { conditions.push('o.order_date <= @endDate');   params.endDate   = endDate; }
    if (search)    { conditions.push('LOWER(o.sku) LIKE @search');  params.search    = `%${search.toLowerCase()}%`; }

    const baseWhere  = conditions.join(' AND ');
    const statusCond = _statusCondition(status || 'all');

    const ALLOWED_SORT = ['order_date', 'sku', 'quantity_sold', 'platform', 'shipped_from_box'];
    const col = ALLOWED_SORT.includes(sortBy) ? `o.${sortBy}` : 'o.order_date';
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

    const query = `
      WITH inv_skus AS (
        SELECT DISTINCT sku FROM ${invTable} WHERE organization_id = @organizationId
      )
      SELECT
        o.order_row_id, o.order_date, o.sku, o.quantity_sold, o.shipped_from_box, o.platform, o.created_at,
        COALESCE(o.mapped_inventory_sku, '') AS mapped_inventory_sku,
        COALESCE(o.is_ignored, FALSE)        AS is_ignored,
        (inv.sku IS NULL)                    AS is_unknown
      FROM ${table} o
      LEFT JOIN inv_skus inv ON COALESCE(o.mapped_inventory_sku, o.sku) = inv.sku
      WHERE ${baseWhere} ${statusCond}
      ORDER BY ${col} ${dir}, o.created_at DESC
    `;

    const [rows] = await bq.query({ query, params });
    return rows.map(r => ({ ...r, created_at: r.created_at?.value ?? r.created_at ?? null }));
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

  async function ignoreOrder(organizationId, rowId, userId) {
    const query = `
      UPDATE ${table}
      SET
        is_ignored = TRUE,
        ignored_at = CURRENT_TIMESTAMP(),
        ignored_by = @userId
      WHERE order_row_id = @rowId AND organization_id = @organizationId
    `;
    await bq.query({
      query,
      params: { organizationId, rowId, userId: userId ?? null },
      types: { userId: 'STRING' },
    });
  }

  async function mapSku(organizationId, rowId, mappedInventorySku, userId) {
    const query = `
      UPDATE ${table}
      SET
        mapped_inventory_sku = @mappedSku,
        is_ignored           = FALSE,
        mapped_at            = CURRENT_TIMESTAMP(),
        mapped_by            = @userId
      WHERE order_row_id = @rowId AND organization_id = @organizationId
    `;
    await bq.query({
      query,
      params: { organizationId, rowId, mappedSku: mappedInventorySku, userId: userId ?? null },
      types: { userId: 'STRING' },
    });
  }

  async function deleteByRowIds(organizationId, rowIds) {
    if (!rowIds?.length) return 0;
    const query = `
      DELETE FROM ${table}
      WHERE organization_id = @organizationId
        AND order_row_id IN UNNEST(@rowIds)
    `;
    await bq.query({ query, params: { organizationId, rowIds } });
    return rowIds.length;
  }

  async function deleteByFilters(organizationId, { platform, startDate, endDate, search }) {
    const conditions = ['organization_id = @organizationId'];
    const params     = { organizationId };

    if (platform)  { conditions.push('platform = @platform');         params.platform  = platform; }
    if (startDate) { conditions.push('order_date >= @startDate');     params.startDate = startDate; }
    if (endDate)   { conditions.push('order_date <= @endDate');       params.endDate   = endDate; }
    if (search)    { conditions.push('LOWER(sku) LIKE @search');      params.search    = `%${search.toLowerCase()}%`; }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const countQuery = `SELECT COUNT(*) AS total FROM ${table} ${where}`;
    const [countRows] = await bq.query({ query: countQuery, params });
    const total = Number(countRows[0]?.total ?? 0);
    if (total > 0) {
      await bq.query({ query: `DELETE FROM ${table} ${where}`, params });
    }
    return total;
  }

  async function updateRow(organizationId, rowId, updates) {
    const query = `
      UPDATE ${table}
      SET
        order_date       = @orderDate,
        quantity_sold    = @quantitySold,
        platform         = @platform,
        shipped_from_box = @shippedFromBox
      WHERE order_row_id = @rowId AND organization_id = @organizationId
    `;
    await bq.query({
      query,
      params: {
        organizationId, rowId,
        orderDate:      updates.order_date,
        quantitySold:   updates.quantity_sold,
        platform:       updates.platform,
        shippedFromBox: updates.shipped_from_box ?? null,
      },
      types: { shippedFromBox: 'STRING' },
    });
  }

  return { findAll, exportAll, getPlatforms, ignoreOrder, mapSku, deleteByRowIds, deleteByFilters, updateRow };
}
