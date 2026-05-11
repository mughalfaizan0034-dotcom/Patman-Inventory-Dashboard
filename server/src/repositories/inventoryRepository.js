import { TABLES } from '../config/tables.js';

export function createInventoryRepository({ bq, projectId }) {
  const invTable = `\`${projectId}.${TABLES.INVENTORY}\``;
  const ordTable = `\`${projectId}.${TABLES.ORDERS}\``;

  async function findAll({ organizationId, page, pageSize, search, sortBy, sortDir, status = 'all' }) {
    const offset = (page - 1) * pageSize;

    const conditions = ['i.organization_id = @organizationId'];
    const params     = { organizationId };

    if (search) {
      conditions.push('(LOWER(i.sku) = @search OR LOWER(i.upc) = @search OR LOWER(i.part_number) = @search)');
      params.search = search.toLowerCase();
    }

    if (status === 'undefined') {
      conditions.push(`(
        UPPER(TRIM(COALESCE(i.sku, '')))           IN ('NA','N/A','')
        OR UPPER(TRIM(COALESCE(i.upc, '')))        IN ('NA','N/A','')
        OR UPPER(TRIM(COALESCE(i.part_number,''))) IN ('NA','N/A','')
      )`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const sortMap = {
      sku:             'i.sku',
      upc:             'i.upc',
      box_number:      'i.box_number',
      quantity:        'i.quantity',
      date_added:      'i.date_added',
      part_number:     'i.part_number',
      notes:           'i.notes',
      units_sold:      'units_sold',
      remaining_stock: 'remaining_stock',
    };
    const col = sortMap[sortBy] || 'i.date_added';
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

    // Stock-based filters require joining orders to compute remaining_stock
    const needsStockFilter = status === 'in_stock' || status === 'oos' || status === 'phantom';
    const stockCond = needsStockFilter
      ? `AND (i.quantity - COALESCE(o.units_sold, 0)) ${
          status === 'in_stock' ? '> 0' :
          status === 'oos'      ? '= 0' :
          '< 0'
        }`
      : '';

    const cte = `
      WITH ord_summary AS (
        SELECT
          CASE
            WHEN shipped_from_box IS NOT NULL
                 AND TRIM(CAST(shipped_from_box AS STRING)) != ''
                 AND REGEXP_CONTAINS(sku, r'^ARA[0-9]+-.+$')
            THEN CONCAT('ARA', TRIM(CAST(shipped_from_box AS STRING)), REGEXP_EXTRACT(sku, r'^ARA[0-9]+(.+)$'))
            ELSE sku
          END AS effective_sku,
          SUM(quantity_sold) AS units_sold
        FROM ${ordTable}
        WHERE organization_id = @organizationId
        GROUP BY effective_sku
      )`;

    const dataQuery = `
      ${cte}
      SELECT
        i.sku, i.upc, i.part_number, i.box_number, i.quantity, i.date_added, i.notes,
        COALESCE(o.units_sold, 0) AS units_sold,
        i.quantity - COALESCE(o.units_sold, 0) AS remaining_stock
      FROM ${invTable} i
      LEFT JOIN ord_summary o ON i.sku = o.effective_sku
      ${where} ${stockCond}
      ORDER BY ${col} ${dir}
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    const countQuery = needsStockFilter
      ? `${cte} SELECT COUNT(*) AS total FROM ${invTable} i LEFT JOIN ord_summary o ON i.sku = o.effective_sku ${where} ${stockCond}`
      : `SELECT COUNT(*) AS total FROM ${invTable} i ${where}`;

    const [rows, countRows] = await Promise.all([
      bq.query({ query: dataQuery, params }),
      bq.query({ query: countQuery, params }),
    ]);

    return {
      items: rows[0],
      total: Number(countRows[0][0]?.total ?? 0),
    };
  }

  async function deleteBySkus(organizationId, skus) {
    if (!skus?.length) return 0;
    const query = `
      DELETE FROM ${invTable}
      WHERE organization_id = @organizationId AND sku IN UNNEST(@skus)
    `;
    await bq.query({ query, params: { organizationId, skus } });
    return skus.length;
  }

  async function updateRow(organizationId, originalSku, updates) {
    const query = `
      UPDATE ${invTable}
      SET
        sku         = @sku,
        upc         = @upc,
        quantity    = @quantity,
        part_number = @partNumber,
        box_number  = @boxNumber,
        notes       = @notes,
        date_added  = @dateAdded
      WHERE sku = @originalSku AND organization_id = @organizationId
    `;
    await bq.query({
      query,
      params: {
        organizationId,
        originalSku,
        sku:        updates.sku,
        upc:        updates.upc,
        quantity:   updates.quantity,
        partNumber: updates.part_number ?? null,
        boxNumber:  updates.box_number  ?? null,
        notes:      updates.notes       ?? null,
        dateAdded:  updates.date_added  ?? null,
      },
      types: { partNumber: 'STRING', boxNumber: 'STRING', notes: 'STRING', dateAdded: 'STRING' },
    });
  }

  async function findAlternativeBoxes(organizationId, sku) {
    const match = sku?.match(/^ARA(\d+)-(.+)-(.+)$/);
    if (!match) return { originalBox: null, alternatives: [] };

    const [, boxNum, partNumber, upc] = match;
    const originalBox = `ARA${boxNum}`;

    const query = `
      WITH ord_summary AS (
        SELECT
          CASE
            WHEN shipped_from_box IS NOT NULL
                 AND TRIM(CAST(shipped_from_box AS STRING)) != ''
                 AND REGEXP_CONTAINS(sku, r'^ARA[0-9]+-.+$')
            THEN CONCAT('ARA', TRIM(CAST(shipped_from_box AS STRING)), REGEXP_EXTRACT(sku, r'^ARA[0-9]+(.+)$'))
            ELSE sku
          END AS effective_sku,
          SUM(quantity_sold) AS units_sold
        FROM ${ordTable}
        WHERE organization_id = @organizationId
        GROUP BY effective_sku
      )
      SELECT
        i.box_number,
        i.quantity - COALESCE(o.units_sold, 0) AS remaining_stock
      FROM ${invTable} i
      LEFT JOIN ord_summary o ON i.sku = o.effective_sku
      WHERE i.organization_id = @organizationId
        AND i.part_number = @partNumber
        AND i.upc         = @upc
        AND i.box_number IS NOT NULL
        AND TRIM(i.box_number) != ''
      ORDER BY remaining_stock DESC
    `;
    const [rows] = await bq.query({
      query,
      params: { organizationId, partNumber, upc },
    });

    const seen = new Set();
    const all  = rows
      .map(r => ({ box_number: r.box_number, remaining_stock: Number(r.remaining_stock ?? 0) }))
      .filter(r => { if (seen.has(r.box_number)) return false; seen.add(r.box_number); return true; });

    return {
      originalBox,
      alternatives: all,
    };
  }

  async function exportAll({ organizationId, search, sortBy, sortDir, status = 'all' }) {
    const conditions = ['i.organization_id = @organizationId'];
    const params     = { organizationId };

    if (search) {
      conditions.push('(LOWER(i.sku) = @search OR LOWER(i.upc) = @search OR LOWER(i.part_number) = @search)');
      params.search = search.toLowerCase();
    }

    if (status === 'undefined') {
      conditions.push(`(
        UPPER(TRIM(COALESCE(i.sku, '')))           IN ('NA','N/A','')
        OR UPPER(TRIM(COALESCE(i.upc, '')))        IN ('NA','N/A','')
        OR UPPER(TRIM(COALESCE(i.part_number,''))) IN ('NA','N/A','')
      )`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const sortMap = {
      sku:             'i.sku',
      upc:             'i.upc',
      box_number:      'i.box_number',
      quantity:        'i.quantity',
      date_added:      'i.date_added',
      part_number:     'i.part_number',
      notes:           'i.notes',
      units_sold:      'units_sold',
      remaining_stock: 'remaining_stock',
    };
    const col = sortMap[sortBy] || 'i.date_added';
    const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

    const needsStockFilter = status === 'in_stock' || status === 'oos' || status === 'phantom';
    const stockCond = needsStockFilter
      ? `AND (i.quantity - COALESCE(o.units_sold, 0)) ${
          status === 'in_stock' ? '> 0' :
          status === 'oos'      ? '= 0' :
          '< 0'
        }`
      : '';

    const cte = `
      WITH ord_summary AS (
        SELECT
          CASE
            WHEN shipped_from_box IS NOT NULL
                 AND TRIM(CAST(shipped_from_box AS STRING)) != ''
                 AND REGEXP_CONTAINS(sku, r'^ARA[0-9]+-.+$')
            THEN CONCAT('ARA', TRIM(CAST(shipped_from_box AS STRING)), REGEXP_EXTRACT(sku, r'^ARA[0-9]+(.+)$'))
            ELSE sku
          END AS effective_sku,
          SUM(quantity_sold) AS units_sold
        FROM ${ordTable}
        WHERE organization_id = @organizationId
        GROUP BY effective_sku
      )`;

    const query = `
      ${cte}
      SELECT
        i.sku, i.upc, i.part_number, i.box_number, i.quantity, i.date_added, i.notes,
        COALESCE(o.units_sold, 0) AS units_sold,
        i.quantity - COALESCE(o.units_sold, 0) AS remaining_stock
      FROM ${invTable} i
      LEFT JOIN ord_summary o ON i.sku = o.effective_sku
      ${where} ${stockCond}
      ORDER BY ${col} ${dir}
    `;

    const [rows] = await bq.query({ query, params });
    return rows;
  }

  return { findAll, exportAll, deleteBySkus, updateRow, findAlternativeBoxes };
}
