import { TABLES } from '../config/tables.js';

export function createLookupRepository({ bq, projectId }) {
  const invTable = `\`${projectId}.${TABLES.INVENTORY}\``;
  const ordTable = `\`${projectId}.${TABLES.ORDERS}\``;

  async function search(organizationId, query) {
    const q = (query || '').trim();
    if (!q) return [];

    // Two-stage aggregation:
    // 1. inv_grouped: SUM quantities by (box, part, upc) — handles N rows per box.
    // 2. inv_skus: collect ALL distinct skus per (box, part, upc) — a box may have
    //    rows with different sku strings (different uploads / replenishment batches).
    // 3. box_orders: join EVERY sku for each box against orders, then SUM per box —
    //    ensures sold counts cover all sku variants, not just MIN(sku).
    // 4. Final join: merge aggregated initial stock with aggregated sold quantity.
    const sql = `
      WITH inv_grouped AS (
        SELECT
          COALESCE(upc, '')         AS upc,
          COALESCE(part_number, '') AS part_number,
          COALESCE(box_number, '')  AS box_number,
          SUM(quantity)             AS initial_stock
        FROM ${invTable}
        WHERE organization_id = @organizationId
          AND (
            LOWER(TRIM(COALESCE(upc, '')))            = LOWER(TRIM(@query))
            OR LOWER(TRIM(COALESCE(part_number, ''))) = LOWER(TRIM(@query))
          )
        GROUP BY COALESCE(box_number, ''), COALESCE(part_number, ''), COALESCE(upc, '')
      ),
      inv_skus AS (
        SELECT DISTINCT
          COALESCE(upc, '')         AS upc,
          COALESCE(part_number, '') AS part_number,
          COALESCE(box_number, '')  AS box_number,
          sku
        FROM ${invTable}
        WHERE organization_id = @organizationId
          AND (
            LOWER(TRIM(COALESCE(upc, '')))            = LOWER(TRIM(@query))
            OR LOWER(TRIM(COALESCE(part_number, ''))) = LOWER(TRIM(@query))
          )
      ),
      ord_summary AS (
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
          AND COALESCE(is_ignored, FALSE) = FALSE
        GROUP BY effective_sku
      ),
      box_orders AS (
        SELECT
          s.upc, s.part_number, s.box_number,
          COALESCE(SUM(o.units_sold), 0) AS units_sold
        FROM inv_skus s
        LEFT JOIN ord_summary o ON s.sku = o.effective_sku
        GROUP BY s.upc, s.part_number, s.box_number
      )
      SELECT
        ig.upc,
        ig.part_number,
        ig.box_number,
        ig.initial_stock,
        COALESCE(bo.units_sold, 0)                    AS units_sold,
        ig.initial_stock - COALESCE(bo.units_sold, 0) AS remaining_stock
      FROM inv_grouped ig
      LEFT JOIN box_orders bo
        ON  ig.box_number   = bo.box_number
        AND ig.part_number  = bo.part_number
        AND ig.upc          = bo.upc
      ORDER BY ig.part_number, ig.upc, remaining_stock DESC
    `;

    const [rows] = await bq.query({
      query: sql,
      params: { organizationId, query: q },
    });
    return rows.map(r => ({
      ...r,
      initial_stock:   Number(r.initial_stock   ?? 0),
      units_sold:      Number(r.units_sold       ?? 0),
      remaining_stock: Number(r.remaining_stock  ?? 0),
    }));
  }

  return { search };
}
