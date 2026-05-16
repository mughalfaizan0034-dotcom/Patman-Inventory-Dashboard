import { TABLES } from '../config/tables.js';
import { isUndefinedRowSql } from '../utils/inventoryPatterns.js';
import { effectiveSkuSql } from '../utils/skuPatterns.js';

export function createInventoryRepository({ bq, projectId, orgsRepo }) {
  const invTable = `\`${projectId}.${TABLES.INVENTORY}\``;
  const ordTable = `\`${projectId}.${TABLES.ORDERS}\``;

  // Same regex resolver pattern as inventoryMetricsService — the Inventory
  // List page's "Undefined SKUs" filter must use the SAME structure-aware
  // classification as the dashboard so the two never disagree.
  async function _resolveSkuRegex(organizationId) {
    if (!orgsRepo?.getSkuRegex) return null;
    try { return await orgsRepo.getSkuRegex(organizationId); }
    catch { return null; }
  }

  async function findAll({ organizationId, page, pageSize, search, sortBy, sortDir, status = 'all' }) {
    const offset = (page - 1) * pageSize;

    const conditions = ['i.organization_id = @organizationId'];
    const params     = { organizationId };

    if (search) {
      conditions.push('(LOWER(i.sku) = @search OR LOWER(i.upc) = @search OR LOWER(i.part_number) = @search)');
      params.search = search.toLowerCase();
    }

    if (status === 'undefined') {
      const skuRegex = await _resolveSkuRegex(organizationId);
      if (skuRegex) params.sku_regex = skuRegex;
      conditions.push(isUndefinedRowSql('i', skuRegex ? { regexParam: 'sku_regex' } : {}));
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
          ${effectiveSkuSql()} AS effective_sku,
          SUM(quantity_sold) AS units_sold
        FROM ${ordTable}
        WHERE organization_id = @organizationId
        GROUP BY effective_sku
      )`;

    const dataQuery = `
      ${cte}
      SELECT
        i.row_uid, i.sku, i.upc, i.part_number, i.box_number, i.quantity, i.date_added, i.notes,
        COALESCE(o.units_sold, 0)                                    AS units_sold,
        LEAST(COALESCE(o.units_sold, 0), i.quantity)                 AS fulfilled_units,
        GREATEST(COALESCE(o.units_sold, 0) - i.quantity, 0)         AS phantom_units,
        GREATEST(i.quantity - COALESCE(o.units_sold, 0), 0)         AS remaining_stock
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

  // Delete by row_uid — the canonical tracker. SKU is NOT the row key
  // anymore (multiple rows can share a SKU).
  async function deleteByRowUids(organizationId, rowUids) {
    if (!rowUids?.length) return 0;
    const query = `
      DELETE FROM ${invTable}
      WHERE organization_id = @organizationId AND row_uid IN UNNEST(@rowUids)
    `;
    await bq.query({ query, params: { organizationId, rowUids } });
    return rowUids.length;
  }

  async function updateRow(organizationId, rowUid, updates) {
    const query = `
      UPDATE ${invTable}
      SET
        sku         = @sku,
        upc         = @upc,
        quantity    = @quantity,
        part_number = @partNumber,
        box_number  = @boxNumber,
        notes       = @notes,
        date_added  = @dateAdded,
        updated_at  = CURRENT_TIMESTAMP()
      WHERE row_uid = @rowUid AND organization_id = @organizationId
    `;
    await bq.query({
      query,
      params: {
        organizationId,
        rowUid,
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
    // CANONICAL: bare digits, matching the form used by alternatives[].box_number
    // below and by the database columns inventory.box_number and orders.shipped_sku
    // (when stored as box-only). Returning "ARA667" here caused the popover's
    // .find() to miss the original row (Original showed Qty 0) AND the !==
    // filter to fail (original SKU appeared a second time at the bottom).
    const originalBox = boxNum;

    const query = `
      WITH inv_agg AS (
        SELECT
          box_number,
          SUM(quantity) AS total_quantity,
          ARRAY_AGG(DISTINCT sku) AS skus
        FROM ${invTable}
        WHERE organization_id = @organizationId
          AND part_number = @partNumber
          AND upc         = @upc
          AND box_number IS NOT NULL
          AND TRIM(box_number) != ''
        GROUP BY box_number
      ),
      ord_summary AS (
        SELECT
          ${effectiveSkuSql()} AS effective_sku,
          SUM(quantity_sold) AS units_sold
        FROM ${ordTable}
        WHERE organization_id = @organizationId
        GROUP BY effective_sku
      ),
      box_orders AS (
        SELECT
          inv.box_number,
          SUM(COALESCE(o.units_sold, 0)) AS total_sold
        FROM inv_agg inv,
        UNNEST(inv.skus) AS inv_sku
        LEFT JOIN ord_summary o ON o.effective_sku = inv_sku
        GROUP BY inv.box_number
      )
      SELECT
        i.box_number,
        GREATEST(i.total_quantity - COALESCE(bo.total_sold, 0), 0) AS remaining_stock
      FROM inv_agg i
      LEFT JOIN box_orders bo ON bo.box_number = i.box_number
      ORDER BY remaining_stock DESC
    `;
    const [rows] = await bq.query({
      query,
      params: { organizationId, partNumber, upc },
    });

    // Some older inventory rows may have box_number stored as "ARA20" or even
    // a full SKU "ARA20-part-upc" due to past user-entry errors. Canonicalize
    // to bare digits before exposing to the frontend popover, otherwise
    // selecting the box would store the bad form into shipped_sku.
    const _bareBox = (v) => {
      const s = String(v ?? '').trim();
      const m = s.match(/^ARA(\d+)(?:-.*)?$/i);
      return m ? m[1] : s;
    };
    const all = rows.map(r => {
      const box = _bareBox(r.box_number);
      return {
        box_number:      box,
        effective_sku:   `ARA${box}-${partNumber}-${upc}`,
        remaining_stock: Number(r.remaining_stock ?? 0),
      };
    });

    return {
      originalBox,
      originalSku: sku,
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
      const skuRegex = await _resolveSkuRegex(organizationId);
      if (skuRegex) params.sku_regex = skuRegex;
      conditions.push(isUndefinedRowSql('i', skuRegex ? { regexParam: 'sku_regex' } : {}));
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
          ${effectiveSkuSql()} AS effective_sku,
          SUM(quantity_sold) AS units_sold
        FROM ${ordTable}
        WHERE organization_id = @organizationId
        GROUP BY effective_sku
      )`;

    const query = `
      ${cte}
      SELECT
        i.row_uid, i.sku, i.upc, i.part_number, i.box_number, i.quantity, i.date_added, i.notes,
        COALESCE(o.units_sold, 0)                                    AS units_sold,
        LEAST(COALESCE(o.units_sold, 0), i.quantity)                 AS fulfilled_units,
        GREATEST(COALESCE(o.units_sold, 0) - i.quantity, 0)         AS phantom_units,
        GREATEST(i.quantity - COALESCE(o.units_sold, 0), 0)         AS remaining_stock
      FROM ${invTable} i
      LEFT JOIN ord_summary o ON i.sku = o.effective_sku
      ${where} ${stockCond}
      ORDER BY ${col} ${dir}
    `;

    const [rows] = await bq.query({ query, params });
    return rows;
  }

  return { findAll, exportAll, deleteByRowUids, updateRow, findAlternativeBoxes };
}
