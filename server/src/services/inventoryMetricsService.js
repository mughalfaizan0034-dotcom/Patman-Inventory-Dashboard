import { TABLES } from '../config/tables.js';
import { isUndefinedSql, isUndefinedRowSql } from '../utils/inventoryPatterns.js';
import { effectiveSkuSql } from '../utils/skuPatterns.js';

/**
 * inventoryMetricsService — single source of truth for dashboard KPI math.
 *
 * The reference is the user's exported inventory report aggregated by SKU.
 * Inventory rows share a SKU when the same product lives in multiple boxes,
 * and the dashboard must classify by SKU (not by row) so the counts match
 * what users see when they pivot the export in Excel / Google Sheets.
 *
 * For each inventory ROW we compute the standard per-row math (the same
 * formulas the Inventory List page renders into each row's cells):
 *
 *   row_fulfilled = LEAST(ordered_for_sku, row.quantity)
 *   row_phantom   = GREATEST(ordered_for_sku - row.quantity, 0)
 *   row_remaining = GREATEST(row.quantity - ordered_for_sku, 0)
 *
 * Then we aggregate to SKU:
 *
 *   sku_qty                = SUM(row.quantity)
 *   sku_phantom_perrow     = SUM(row_phantom)      ← user's "Phantom units"
 *   sku_remaining_perrow   = SUM(row_remaining)    ← used for SKU classification
 *   sku_real_remaining     = GREATEST(sku_qty - ordered_for_sku, 0)
 *                                                  ← user's "Remaining units"
 *                                                    (one ordered_for_sku per SKU)
 *
 * KPI totals (used by the dashboard):
 *
 *   total_skus  = COUNT(*) over per_sku            (distinct SKUs)
 *   in_stock    = COUNTIF(sku_remaining_perrow > 0)   per-SKU classification
 *   oos         = COUNTIF(sku_remaining_perrow = 0)   per-SKU classification
 *   phantom_sk  = COUNTIF(sku_phantom_perrow > 0)
 *
 *   total_units = SUM(sku_qty)
 *   remaining   = SUM(sku_real_remaining)          per-SKU real remaining
 *                                                  = SUM(GREATEST(sum_qty − ordered, 0))
 *   phantom     = SUM(sku_phantom_perrow)          per-row phantom summed
 *   fulfilled   = unitsSoldRaw − phantom − unknown (derived in JS — the
 *                                                  per-row LEAST sum
 *                                                  over-counts when an
 *                                                  SKU spans multiple
 *                                                  inventory rows)
 *
 * Identity that holds across the orders side of the dashboard:
 *   Units Sold = Fulfilled + Phantom + Unknown
 */
export function createInventoryMetricsService({ bq, projectId }) {
  const invTable = `\`${projectId}.${TABLES.INVENTORY}\``;
  const ordTable = `\`${projectId}.${TABLES.ORDERS}\``;

  // ── Shared CTE: ARA-aware order aggregation by effective SKU ──────────────
  const _ordersAggCTE = () => `
    orders_agg AS (
      SELECT
        ${effectiveSkuSql()} AS effective_sku,
        SUM(quantity_sold) AS ordered
      FROM ${ordTable}
      WHERE organization_id = @organizationId
      GROUP BY effective_sku
    )`;

  // Per-row stock math (mirror of inventoryRepository.findAll) — one row per
  // inventory record. The same value of ordered_for_sku is broadcast across
  // every row of a given SKU because the LEFT JOIN matches on i.sku.
  const _perRowCTE = () => `
    per_row AS (
      SELECT
        i.row_uid,
        i.sku,
        i.quantity                                              AS quantity,
        COALESCE(o.ordered, 0)                                  AS ordered_for_sku,
        LEAST(COALESCE(o.ordered, 0), i.quantity)               AS row_fulfilled,
        GREATEST(COALESCE(o.ordered, 0) - i.quantity, 0)        AS row_phantom,
        GREATEST(i.quantity - COALESCE(o.ordered, 0), 0)        AS row_remaining,
        ${isUndefinedRowSql('i')}                               AS is_undefined
      FROM ${invTable} i
      LEFT JOIN orders_agg o ON i.sku = o.effective_sku
      WHERE i.organization_id = @organizationId
    )`;

  // Per-SKU rollup of the per-row math.
  const _perSkuCTE = () => `
    per_sku AS (
      SELECT
        sku,
        SUM(quantity)                                              AS sku_qty,
        MAX(ordered_for_sku)                                       AS ordered_for_sku,
        SUM(row_fulfilled)                                         AS sku_fulfilled_perrow,
        SUM(row_phantom)                                           AS sku_phantom_perrow,
        SUM(row_remaining)                                         AS sku_remaining_perrow,
        GREATEST(SUM(quantity) - MAX(ordered_for_sku), 0)          AS sku_real_remaining,
        LOGICAL_OR(is_undefined)                                   AS is_undefined
      FROM per_row
      GROUP BY sku
    )`;

  // ─────────────────────────────────────────────────────────────────────────
  // computeSummary — ALL dashboard KPIs in one query
  // ─────────────────────────────────────────────────────────────────────────
  async function computeSummary(organizationId) {
    const p = { organizationId };

    const summaryQuery = `
      WITH ${_ordersAggCTE()},
      ${_perRowCTE()},
      ${_perSkuCTE()}
      SELECT
        COUNT(*)                              AS total_skus,
        SUM(sku_qty)                          AS total_inventory_units,
        -- Per-SKU REAL remaining (= max(sum_qty − ordered, 0) per SKU).
        SUM(sku_real_remaining)               AS physical_remaining_units,
        -- Per-row phantom summed: matches the inventory list export's
        -- "Phantom Units" column sum (over-counts when SKU spans rows,
        -- but this is the value the user's pivot tables expect).
        SUM(sku_phantom_perrow)               AS phantom_units,
        -- SKU classification using the per-row remaining sum: a SKU is
        -- in-stock if any of its rows still has remaining stock.
        COUNTIF(sku_remaining_perrow > 0)     AS in_stock_skus,
        COUNTIF(sku_remaining_perrow = 0)     AS oos_skus,
        COUNTIF(sku_phantom_perrow > 0)       AS phantom_skus,
        COUNTIF(is_undefined)                 AS undefined_inventory_rows
      FROM per_sku
    `;

    // unknown_units = SUM(quantity_sold) for orders whose effective SKU is
    // not in inventory (mapped_inventory_sku rescues a few). These units
    // never deduct from any inventory row, so they must NOT be counted in
    // fulfilled — they appear under the dashboard's "Unknown" sub-value.
    const ordersQuery = `
      WITH eff AS (
        SELECT
          ${effectiveSkuSql()} AS effective_sku,
          mapped_inventory_sku,
          quantity_sold,
          platform
        FROM ${ordTable}
        WHERE organization_id = @organizationId
      ),
      inv_skus AS (
        SELECT DISTINCT sku FROM ${invTable} WHERE organization_id = @organizationId
      )
      SELECT
        COUNT(*)                                                       AS total_orders,
        SUM(quantity_sold)                                             AS units_sold_raw,
        COUNT(DISTINCT CASE WHEN platform IS NOT NULL THEN platform END) AS active_platforms,
        0                                                              AS ignored_orders,
        -- Unknown UNITS: sum of quantity_sold for orders whose resolved
        -- SKU (mapped override OR effective_sku) is not in inventory.
        SUM(IF(
          COALESCE(mapped_inventory_sku, effective_sku) NOT IN (SELECT sku FROM inv_skus),
          quantity_sold,
          0
        ))                                                             AS unknown_units_sold,
        -- Distinct count of unknown effective SKUs (informational).
        COUNT(DISTINCT IF(
          COALESCE(mapped_inventory_sku, effective_sku) NOT IN (SELECT sku FROM inv_skus),
          effective_sku,
          NULL
        ))                                                             AS undefined_sku_count
      FROM eff
    `;

    try {
      const [invRow, ordRow] = await Promise.all([
        bq.query({ query: summaryQuery, params: p }).then(r => r[0][0] ?? {}),
        bq.query({ query: ordersQuery,  params: p }).then(r => r[0][0] ?? {}),
      ]);

      const unitsSoldRaw           = Number(ordRow.units_sold_raw          ?? 0);
      const phantomUnits           = Number(invRow.phantom_units           ?? 0);
      const physicalRemainingUnits = Number(invRow.physical_remaining_units ?? 0);
      const unknownUnitsSold       = Number(ordRow.unknown_units_sold      ?? 0);

      // "Fulfilled" = units that actually deducted from physical inventory.
      // Derived in JS to preserve the user's pivot table identity:
      //
      //     Units Sold = Fulfilled + Phantom + Unknown
      //
      // We can't use SUM(per-row fulfilled) from SQL — that over-counts the
      // moment an SKU lives in multiple inventory rows.
      const fulfilledUnits  = Math.max(unitsSoldRaw - phantomUnits - unknownUnitsSold, 0);
      const actualUnitsSold = fulfilledUnits;

      return {
        // Inventory KPIs — per-SKU classification + per-row-summed unit totals
        totalSkus:              Number(invRow.total_skus               ?? 0),
        totalUnits:             Number(invRow.total_inventory_units    ?? 0),
        actualUnitsSold,
        fulfilledUnits,
        physicalRemainingUnits,
        phantomUnits,
        inStockSkus:            Number(invRow.in_stock_skus            ?? 0),
        oosSkus:                Number(invRow.oos_skus                 ?? 0),
        phantomSkus:            Number(invRow.phantom_skus             ?? 0),
        undefinedSkus:          Number(invRow.undefined_inventory_rows ?? 0),
        // Sales KPIs
        unitsSold:              unitsSoldRaw,
        unknownUnitsSold,
        totalOrders:            Number(ordRow.total_orders             ?? 0),
        activePlatforms:        Number(ordRow.active_platforms         ?? 0),
        ignoredOrders:          Number(ordRow.ignored_orders           ?? 0),
        undefinedSkuCount:      Number(ordRow.undefined_sku_count      ?? 0),
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

    // Per-ROW classification, identical to computeSummary above. We slice
    // OOS into phantom and non-phantom so the chart can show both.
    const stockStatusQuery = `
      WITH ${_ordersAggCTE()},
      per_row AS (
        SELECT
          GREATEST(i.quantity - COALESCE(o.ordered, 0), 0) AS remaining,
          GREATEST(COALESCE(o.ordered, 0) - i.quantity, 0) AS phantom,
          ${isUndefinedRowSql('i')} AS is_undefined
        FROM ${invTable} i
        LEFT JOIN orders_agg o ON i.sku = o.effective_sku
        WHERE i.organization_id = @organizationId
      )
      SELECT
        CASE
          WHEN is_undefined  THEN 'Undefined'
          WHEN phantom > 0   THEN 'Phantom'
          WHEN remaining = 0 THEN 'OOS'
          ELSE 'In Stock'
        END AS status,
        COUNT(*) AS count
      FROM per_row
      GROUP BY status
      ORDER BY count DESC
    `;

    const healthByMonthQuery = `
      WITH ${_ordersAggCTE()},
      per_row AS (
        SELECT
          LEFT(COALESCE(CAST(i.date_added AS STRING), ''), 7) AS month,
          GREATEST(i.quantity - COALESCE(o.ordered, 0), 0)    AS remaining,
          GREATEST(COALESCE(o.ordered, 0) - i.quantity, 0)    AS phantom
        FROM ${invTable} i
        LEFT JOIN orders_agg o ON i.sku = o.effective_sku
        WHERE i.organization_id = @organizationId
          AND i.date_added IS NOT NULL
          AND LENGTH(CAST(i.date_added AS STRING)) >= 7
      )
      SELECT
        month,
        COUNTIF(remaining > 0 AND phantom = 0) AS in_stock,
        COUNTIF(remaining = 0 AND phantom = 0) AS oos,
        COUNTIF(phantom > 0)                   AS phantom,
        COUNT(*)                               AS total
      FROM per_row
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
