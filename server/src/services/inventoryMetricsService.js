import { TABLES } from '../config/tables.js';

/**
 * inventoryMetricsService — single source of truth for all inventory calculations.
 *
 * Core formulas (all per SKU, then summed):
 *   remaining = GREATEST(initial_qty - ordered, 0)   physical stock, never < 0
 *   fulfilled = LEAST(ordered, initial_qty)           actually shipped
 *   phantom   = GREATEST(ordered - initial_qty, 0)   unfulfillable excess demand
 *
 * Rules enforced everywhere:
 *   - Ignored orders excluded from all math
 *   - ARA SKU override applied to effective_sku
 *   - Physical inventory can never go below zero
 *   - Phantom units are a warning metric only, not an inventory deduction
 */
export function createInventoryMetricsService({ bq, projectId }) {
  const invTable = `\`${projectId}.${TABLES.INVENTORY}\``;
  const ordTable = `\`${projectId}.${TABLES.ORDERS}\``;

  // ── Shared CTE: ARA-aware order aggregation, ignoring excluded orders ──────
  const _ordersAggCTE = () => `
    orders_agg AS (
      SELECT
        CASE
          WHEN shipped_from_box IS NOT NULL
               AND TRIM(CAST(shipped_from_box AS STRING)) != ''
               AND REGEXP_CONTAINS(sku, r'^ARA[0-9]+-.+$')
          THEN CONCAT('ARA', TRIM(CAST(shipped_from_box AS STRING)),
                      REGEXP_EXTRACT(sku, r'^ARA[0-9]+(.+)$'))
          ELSE sku
        END AS effective_sku,
        SUM(quantity_sold) AS ordered
      FROM ${ordTable}
      WHERE organization_id = @organizationId
        AND COALESCE(is_ignored, FALSE) = FALSE
      GROUP BY effective_sku
    )`;

  // ── Shared CTE: inventory aggregated per SKU ──────────────────────────────
  const _invAggCTE = () => `
    inv_agg AS (
      SELECT sku, SUM(quantity) AS initial_qty
      FROM ${invTable}
      WHERE organization_id = @organizationId
      GROUP BY sku
    )`;

  // ── Shared CTE: per-SKU stock math with correct capping ───────────────────
  const _perSkuCTE = () => `
    per_sku AS (
      SELECT
        i.sku,
        i.initial_qty,
        COALESCE(o.ordered, 0)                                AS ordered,
        GREATEST(i.initial_qty - COALESCE(o.ordered, 0), 0)  AS remaining,
        LEAST(COALESCE(o.ordered, 0), i.initial_qty)         AS fulfilled,
        GREATEST(COALESCE(o.ordered, 0) - i.initial_qty, 0)  AS phantom
      FROM inv_agg i
      LEFT JOIN orders_agg o ON i.sku = o.effective_sku
    )`;

  // ─────────────────────────────────────────────────────────────────────────
  // computeSummary — ALL dashboard KPIs in one query
  // ─────────────────────────────────────────────────────────────────────────
  async function computeSummary(organizationId) {
    const p = { organizationId };

    const summaryQuery = `
      WITH ${_ordersAggCTE()},
      ${_invAggCTE()},
      ${_perSkuCTE()}
      SELECT
        COUNT(*)                    AS total_skus,
        SUM(ps.initial_qty)         AS total_inventory_units,
        SUM(ps.fulfilled)           AS actual_units_sold,
        SUM(ps.remaining)           AS physical_remaining_units,
        SUM(ps.phantom)             AS phantom_units,
        COUNTIF(ps.remaining > 0)   AS in_stock_skus,
        COUNTIF(ps.remaining = 0 AND ps.phantom = 0) AS oos_skus,
        COUNTIF(ps.phantom > 0)     AS phantom_skus,
        (
          SELECT COUNT(*)
          FROM ${invTable}
          WHERE organization_id = @organizationId
            AND (
              UPPER(TRIM(COALESCE(sku, '')))           IN ('NA','N/A','')
              OR UPPER(TRIM(COALESCE(upc, '')))        IN ('NA','N/A','')
              OR UPPER(TRIM(COALESCE(part_number,''))) IN ('NA','N/A','')
            )
        ) AS undefined_inventory_rows
      FROM per_sku ps
    `;

    const ordersQuery = `
      SELECT
        COUNT(*)                                      AS total_orders,
        SUM(quantity_sold)                            AS units_sold_raw,
        COUNT(DISTINCT CASE WHEN platform IS NOT NULL THEN platform END) AS active_platforms,
        (
          SELECT COUNT(DISTINCT o2.sku)
          FROM ${ordTable} o2
          WHERE o2.organization_id = @organizationId
            AND COALESCE(o2.is_ignored, FALSE) = FALSE
            AND COALESCE(o2.mapped_inventory_sku, '') = ''
            AND o2.sku NOT IN (
              SELECT sku FROM ${invTable} WHERE organization_id = @organizationId
            )
        ) AS undefined_sku_orders
      FROM ${ordTable}
      WHERE organization_id = @organizationId
        AND COALESCE(is_ignored, FALSE) = FALSE
    `;

    try {
      const [invRow, ordRow] = await Promise.all([
        bq.query({ query: summaryQuery, params: p }).then(r => r[0][0] ?? {}),
        bq.query({ query: ordersQuery,  params: p }).then(r => r[0][0] ?? {}),
      ]);

      const actualUnitsSold        = Number(invRow.actual_units_sold       ?? 0);
      const physicalRemainingUnits = Number(invRow.physical_remaining_units ?? 0);

      return {
        // Inventory KPIs
        totalSkus:              Number(invRow.total_skus              ?? 0),
        totalUnits:             Number(invRow.total_inventory_units   ?? 0),
        actualUnitsSold,
        physicalRemainingUnits,
        phantomUnits:           Number(invRow.phantom_units           ?? 0),
        inStockSkus:            Number(invRow.in_stock_skus           ?? 0),
        oosSkus:                Number(invRow.oos_skus                ?? 0),
        phantomSkus:            Number(invRow.phantom_skus            ?? 0),
        undefinedSkus:          Number(invRow.undefined_inventory_rows ?? 0),
        // Sales KPIs
        unitsSold:              Number(ordRow.units_sold_raw          ?? 0),
        totalOrders:            Number(ordRow.total_orders            ?? 0),
        activePlatforms:        Number(ordRow.active_platforms        ?? 0),
        undefinedSkuOrders:     Number(ordRow.undefined_sku_orders    ?? 0),
        // Aliases used by existing frontend field references
        remainingStock:         physicalRemainingUnits,
      };
    } catch (err) {
      console.error('[inventoryMetrics.computeSummary] failed:', err?.message ?? err);
      return {
        totalSkus: 0, totalUnits: 0, actualUnitsSold: 0, physicalRemainingUnits: 0,
        phantomUnits: 0, inStockSkus: 0, oosSkus: 0, phantomSkus: 0, undefinedSkus: 0,
        unitsSold: 0, totalOrders: 0, activePlatforms: 0, undefinedSkuOrders: 0,
        remainingStock: 0,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getStockAnalytics — inventory intelligence charts and tables
  // All formulas use GREATEST/LEAST for correct physical stock math
  // ─────────────────────────────────────────────────────────────────────────
  async function getStockAnalytics(organizationId) {
    const p = { organizationId };

    const stockStatusQuery = `
      WITH ${_ordersAggCTE()},
      inv_agg AS (
        SELECT sku, upc, part_number, SUM(quantity) AS quantity
        FROM ${invTable}
        WHERE organization_id = @organizationId
        GROUP BY sku, upc, part_number
      ),
      per_item AS (
        SELECT
          GREATEST(i.quantity - COALESCE(o.ordered, 0), 0) AS remaining,
          GREATEST(COALESCE(o.ordered, 0) - i.quantity, 0) AS phantom,
          (
            UPPER(TRIM(COALESCE(i.sku, '')))           IN ('NA','N/A','') OR
            UPPER(TRIM(COALESCE(i.upc, '')))           IN ('NA','N/A','') OR
            UPPER(TRIM(COALESCE(i.part_number, '')))   IN ('NA','N/A','')
          ) AS is_undefined
        FROM inv_agg i
        LEFT JOIN orders_agg o ON i.sku = o.effective_sku
      )
      SELECT
        CASE
          WHEN is_undefined  THEN 'Undefined'
          WHEN phantom > 0   THEN 'Phantom'
          WHEN remaining = 0 THEN 'OOS'
          ELSE 'In Stock'
        END AS status,
        COUNT(*) AS count
      FROM per_item
      GROUP BY status
      ORDER BY count DESC
    `;

    const topBoxesQuery = `
      WITH ${_ordersAggCTE()},
      inv_agg AS (
        SELECT sku, box_number, SUM(quantity) AS quantity
        FROM ${invTable}
        WHERE organization_id = @organizationId
          AND box_number IS NOT NULL AND TRIM(CAST(box_number AS STRING)) != ''
        GROUP BY sku, box_number
      ),
      box_remaining AS (
        SELECT
          i.box_number,
          SUM(GREATEST(i.quantity - COALESCE(o.ordered, 0), 0)) AS remaining_units,
          COUNT(DISTINCT i.sku) AS sku_count
        FROM inv_agg i
        LEFT JOIN orders_agg o ON i.sku = o.effective_sku
        GROUP BY i.box_number
      )
      SELECT box_number, remaining_units, sku_count
      FROM box_remaining
      WHERE remaining_units > 0
      ORDER BY remaining_units DESC
      LIMIT 10
    `;

    const healthByMonthQuery = `
      WITH ${_ordersAggCTE()},
      inv_agg AS (
        SELECT
          sku,
          LEFT(COALESCE(CAST(date_added AS STRING), ''), 7) AS month,
          SUM(quantity) AS quantity
        FROM ${invTable}
        WHERE organization_id = @organizationId
          AND date_added IS NOT NULL
          AND LENGTH(CAST(date_added AS STRING)) >= 7
        GROUP BY sku, LEFT(COALESCE(CAST(date_added AS STRING), ''), 7)
      ),
      per_item AS (
        SELECT
          i.month,
          GREATEST(i.quantity - COALESCE(o.ordered, 0), 0) AS remaining,
          GREATEST(COALESCE(o.ordered, 0) - i.quantity, 0) AS phantom
        FROM inv_agg i
        LEFT JOIN orders_agg o ON i.sku = o.effective_sku
      )
      SELECT
        month,
        COUNTIF(remaining > 0 AND phantom = 0) AS in_stock,
        COUNTIF(remaining = 0 AND phantom = 0) AS oos,
        COUNTIF(phantom > 0)                   AS phantom,
        COUNT(*)                               AS total
      FROM per_item
      WHERE month != '' AND month IS NOT NULL
      GROUP BY month
      ORDER BY month ASC
      LIMIT 24
    `;

    const oversoldSkusQuery = `
      WITH ${_ordersAggCTE()},
      inv_agg AS (
        SELECT sku, SUM(quantity) AS quantity
        FROM ${invTable}
        WHERE organization_id = @organizationId
        GROUP BY sku
      )
      SELECT
        i.sku,
        i.quantity                                                AS original_qty,
        COALESCE(o.ordered, 0)                                    AS units_sold,
        GREATEST(COALESCE(o.ordered, 0) - i.quantity, 0)         AS remaining,
        GREATEST(COALESCE(o.ordered, 0) - i.quantity, 0)         AS phantom_demand
      FROM inv_agg i
      LEFT JOIN orders_agg o ON i.sku = o.effective_sku
      WHERE COALESCE(o.ordered, 0) > i.quantity
      ORDER BY phantom_demand DESC
      LIMIT 10
    `;

    const boxUtilizationQuery = `
      WITH ${_ordersAggCTE()},
      inv_agg AS (
        SELECT sku, box_number, SUM(quantity) AS quantity
        FROM ${invTable}
        WHERE organization_id = @organizationId
          AND box_number IS NOT NULL AND TRIM(CAST(box_number AS STRING)) != ''
        GROUP BY sku, box_number
      ),
      box_stats AS (
        SELECT
          i.box_number,
          COUNT(DISTINCT i.sku) AS total_skus,
          COUNT(DISTINCT CASE WHEN GREATEST(i.quantity - COALESCE(o.ordered, 0), 0) > 0 THEN i.sku END) AS active_skus
        FROM inv_agg i
        LEFT JOIN orders_agg o ON i.sku = o.effective_sku
        GROUP BY i.box_number
      )
      SELECT box_number, total_skus, active_skus
      FROM box_stats
      ORDER BY total_skus DESC
      LIMIT 10
    `;

    const run = (query, label) =>
      bq.query({ query, params: p })
        .then(r => r[0])
        .catch(err => {
          console.error(`[inventoryMetrics.getStockAnalytics] ${label} failed:`, err?.message ?? err);
          return [];
        });

    const [stockStatus, topBoxes, healthByMonth, mostOversoldSkus, boxUtilization] = await Promise.all([
      run(stockStatusQuery,    'stockStatus'),
      run(topBoxesQuery,       'topBoxes'),
      run(healthByMonthQuery,  'healthByMonth'),
      run(oversoldSkusQuery,   'oversoldSkus'),
      run(boxUtilizationQuery, 'boxUtilization'),
    ]);

    return { stockStatus, topBoxes, healthByMonth, mostOversoldSkus, boxUtilization };
  }

  return { computeSummary, getStockAnalytics };
}
