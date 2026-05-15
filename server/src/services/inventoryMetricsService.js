import { TABLES } from '../config/tables.js';
import { isUndefinedSql, isUndefinedRowSql } from '../utils/inventoryPatterns.js';
import { effectiveSkuSql } from '../utils/skuPatterns.js';

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
        ${effectiveSkuSql()} AS effective_sku,
        SUM(quantity_sold) AS ordered
      FROM ${ordTable}
      WHERE organization_id = @organizationId
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
        SUM(ps.remaining)           AS physical_remaining_units,
        SUM(ps.fulfilled)           AS fulfilled_units,
        SUM(ps.phantom)             AS phantom_units,
        COUNTIF(ps.remaining > 0)   AS in_stock_skus,
        COUNTIF(ps.remaining = 0 AND ps.phantom = 0) AS oos_skus,
        COUNTIF(ps.phantom > 0)     AS phantom_skus,
        (
          SELECT COUNT(*)
          FROM ${invTable}
          WHERE organization_id = @organizationId
            AND ${isUndefinedRowSql()}
        ) AS undefined_inventory_rows
      FROM per_sku ps
    `;

    // Undefined SKU = orders whose EFFECTIVE shipped SKU does not exist in inventory.
    // The shipped_from_box override + ARA-pattern reassignment compute the effective
    // SKU; if that effective SKU resolves to an inventory row, the order counts as
    // fulfilled (not undefined). A manual mapping (mapped_inventory_sku) also rescues it.
    // The legacy is_ignored column has been dropped (Phase D). All orders
    // visible to the system are now considered live. ignored_orders is
    // therefore always 0 — kept in the returned shape for backward compat
    // until any frontend reference is removed.
    const ordersQuery = `
      SELECT
        COUNT(*)                                      AS total_orders,
        SUM(quantity_sold)                            AS units_sold_raw,
        COUNT(DISTINCT CASE WHEN platform IS NOT NULL THEN platform END) AS active_platforms,
        0                                             AS ignored_orders,
        (
          SELECT COUNT(DISTINCT o2.effective_sku)
          FROM (
            SELECT
              ${effectiveSkuSql()} AS effective_sku,
              mapped_inventory_sku
            FROM ${ordTable}
            WHERE organization_id = @organizationId
          ) o2
          WHERE COALESCE(o2.mapped_inventory_sku, '') = ''
            AND o2.effective_sku NOT IN (
              SELECT sku FROM ${invTable} WHERE organization_id = @organizationId
            )
        ) AS undefined_sku_orders
      FROM ${ordTable}
      WHERE organization_id = @organizationId
    `;

    try {
      const [invRow, ordRow] = await Promise.all([
        bq.query({ query: summaryQuery, params: p }).then(r => r[0][0] ?? {}),
        bq.query({ query: ordersQuery,  params: p }).then(r => r[0][0] ?? {}),
      ]);

      const unitsSoldRaw           = Number(ordRow.units_sold_raw          ?? 0);
      const fulfilledUnits         = Number(invRow.fulfilled_units         ?? 0);
      const phantomUnits           = Number(invRow.phantom_units           ?? 0);
      const physicalRemainingUnits = Number(invRow.physical_remaining_units ?? 0);

      // Math invariants (per CLAUDE.md "Centralized Inventory Calculation Engine"):
      //   unitsSoldRaw = matched_units + unknown_units
      //   matched_units = fulfilled + phantom         (per-SKU LEAST + GREATEST)
      //   ⇒ unknown_units = unitsSoldRaw - fulfilled - phantom
      //
      //   totalUnits = fulfilled + physicalRemaining   (every inventory unit is
      //                                                 either shipped or in stock)
      //   ⇒ physicalRemaining = totalUnits - fulfilled  ✓ matches SQL
      //
      // "Actual Units Sold" = units that ACTUALLY came out of stock = fulfilled.
      // The previous formula (unitsSoldRaw - phantom) overcounted whenever
      // orders had unknown SKUs — those units never deducted, but were still
      // subtracted via the dashboard label "Sold", making Total - Sold ≠ Remaining.
      const unknownUnitsSold = Math.max(unitsSoldRaw - fulfilledUnits - phantomUnits, 0);
      const actualUnitsSold  = fulfilledUnits;

      return {
        // Inventory KPIs
        totalSkus:              Number(invRow.total_skus              ?? 0),
        totalUnits:             Number(invRow.total_inventory_units   ?? 0),
        actualUnitsSold,
        fulfilledUnits,
        physicalRemainingUnits,
        phantomUnits,
        inStockSkus:            Number(invRow.in_stock_skus           ?? 0),
        oosSkus:                Number(invRow.oos_skus                ?? 0),
        phantomSkus:            Number(invRow.phantom_skus            ?? 0),
        undefinedSkus:          Number(invRow.undefined_inventory_rows ?? 0),
        // Sales KPIs
        unitsSold:              unitsSoldRaw,
        unknownUnitsSold,
        totalOrders:            Number(ordRow.total_orders            ?? 0),
        activePlatforms:        Number(ordRow.active_platforms        ?? 0),
        ignoredOrders:          Number(ordRow.ignored_orders          ?? 0),
        // Distinct count of unknown effective_skus (kept for any UI that
        // wants to surface "how many unique SKUs are unknown").
        undefinedSkuCount:      Number(ordRow.undefined_sku_orders    ?? 0),
        // Aliases used by existing frontend field references
        remainingStock:         physicalRemainingUnits,
      };
    } catch (err) {
      console.error('[inventoryMetrics.computeSummary] failed:', err?.message ?? err);
      return {
        totalSkus: 0, totalUnits: 0, actualUnitsSold: 0, fulfilledUnits: 0, physicalRemainingUnits: 0,
        phantomUnits: 0, inStockSkus: 0, oosSkus: 0, phantomSkus: 0, undefinedSkus: 0,
        unitsSold: 0, unknownUnitsSold: 0,
        totalOrders: 0, activePlatforms: 0, ignoredOrders: 0, undefinedSkuCount: 0,
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
          ${isUndefinedRowSql('i')} AS is_undefined
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

    const run = (query, label) =>
      bq.query({ query, params: p })
        .then(r => r[0])
        .catch(err => {
          console.error(`[inventoryMetrics.getStockAnalytics] ${label} failed:`, err?.message ?? err);
          return [];
        });

    const [stockStatus, healthByMonth] = await Promise.all([
      run(stockStatusQuery,   'stockStatus'),
      run(healthByMonthQuery, 'healthByMonth'),
    ]);

    return { stockStatus, healthByMonth };
  }

  return { computeSummary, getStockAnalytics };
}
