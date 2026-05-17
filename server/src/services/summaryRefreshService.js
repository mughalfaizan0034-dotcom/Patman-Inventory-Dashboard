import { TABLES } from '../config/tables.js';
import { effectiveSkuSql, wrongPartSql } from '../utils/skuPatterns.js';
import { ordersAggCTE, invAggCTE, perSkuCTE } from '../utils/skuPivots.js';

/**
 * summaryRefreshService — rebuilds the three materialized summary tables
 * for a single organization. The ONLY way these tables are updated.
 *
 * Refresh model:
 *   1. DELETE the org's rows from each summary.
 *   2. INSERT fresh aggregates via the same CTE chains that
 *      inventoryMetricsService uses for live computation.
 *
 * Why "DELETE + INSERT" rather than MERGE:
 *   - The per-SKU keyspace can shrink (a SKU deleted in inventory must
 *     also disappear from inventory_summary). MERGE-only would leave
 *     orphan summary rows. DELETE-then-INSERT guarantees the summary
 *     matches the current raw state.
 *   - Each call scopes by organization_id so other orgs' rows are
 *     untouched.
 *
 * Refresh failures are non-fatal. The caller wraps in try/catch + log;
 * the originating operation (upload, edit, etc.) still commits. The
 * KPI parity logger and the next refresh will catch the drift.
 */
export function createSummaryRefreshService({ bq, projectId, orgsRepo, logger }) {
  const invTable          = `\`${projectId}.${TABLES.INVENTORY}\``;
  const ordTable          = `\`${projectId}.${TABLES.ORDERS}\``;
  const dashboardSummary  = `\`${projectId}.${TABLES.DASHBOARD_SUMMARY}\``;
  const inventorySummary  = `\`${projectId}.${TABLES.INVENTORY_SUMMARY}\``;
  const boxSummaryByUpc   = `\`${projectId}.${TABLES.BOX_SUMMARY_BY_UPC}\``;
  const boxSummaryByPart  = `\`${projectId}.${TABLES.BOX_SUMMARY_BY_PART}\``;

  async function _resolveSkuRegex(organizationId) {
    if (!orgsRepo?.getSkuRegex) return null;
    try { return await orgsRepo.getSkuRegex(organizationId); }
    catch { return null; }
  }

  // Build the params object + the regex-param name used inside the SQL
  // CTEs. When skuRegex is null we pass no regex param and the SQL skips
  // the structure-regex check (legacy placeholder-only classification).
  function _bindings(organizationId, skuRegex) {
    const params = { organizationId };
    let regexParam = null;
    if (skuRegex) {
      params.sku_regex = skuRegex;
      regexParam = 'sku_regex';
    }
    return { params, regexParam };
  }

  // CTE builders imported from utils/skuPivots.js — single source of truth
  // shared with inventoryMetricsService. Live computation and materialized
  // rebuild cannot drift because they're literally the same SQL text.
  const _ordersAggCTE  = ()           => ordersAggCTE({ ordTable });
  const _invAggCTE     = (regexParam) => invAggCTE({ invTable, regexParam });
  const _perSkuCTE     = ()           => perSkuCTE();

  // ─────────────────────────────────────────────────────────────────────
  // dashboard_summary — one row per org
  // ─────────────────────────────────────────────────────────────────────
  async function _rebuildDashboardSummary(organizationId, skuRegex) {
    const { params, regexParam } = _bindings(organizationId, skuRegex);

    await bq.query({
      query:  `DELETE FROM ${dashboardSummary} WHERE organization_id = @organizationId`,
      params: { organizationId },
    });

    const insertQuery = `
      INSERT INTO ${dashboardSummary} (
        organization_id, total_skus, total_units, fulfilled_units,
        phantom_units, physical_remaining_units, in_stock_skus, oos_skus,
        phantom_skus, undefined_skus, units_sold_raw, unknown_units_sold,
        unknown_orders, wrong_part_units, total_orders, active_platforms,
        refreshed_at
      )
      WITH ${_ordersAggCTE()},
      ${_invAggCTE(regexParam)},
      ${_perSkuCTE()},
      inv_skus_for_join AS (
        SELECT DISTINCT sku FROM ${invTable} WHERE organization_id = @organizationId
      ),
      o_eff AS (
        SELECT
          o.*,
          ${effectiveSkuSql({ skuCol: 'o.sku', shippedCol: 'o.shipped_sku' })} AS effective_sku
        FROM ${ordTable} o
        WHERE o.organization_id = @organizationId
      ),
      inv_pivot AS (
        SELECT
          COUNT(*)                       AS total_skus,
          SUM(initial)                   AS total_units,
          SUM(fulfilled)                 AS fulfilled_units,
          SUM(phantom)                   AS phantom_units,
          SUM(remaining)                 AS physical_remaining_units,
          COUNTIF(remaining > 0)         AS in_stock_skus,
          COUNTIF(remaining = 0)         AS oos_skus,
          COUNTIF(phantom > 0)           AS phantom_skus,
          COUNTIF(is_undefined)          AS undefined_skus
        FROM per_sku
      ),
      ord_pivot AS (
        SELECT
          COUNT(*)                                                            AS total_orders,
          SUM(o.quantity_sold)                                                AS units_sold_raw,
          SUM(IF(${wrongPartSql({ skuCol: 'o.sku', shippedCol: 'o.shipped_sku' })}, o.quantity_sold, 0)) AS wrong_part_units,
          COUNTIF(inv.sku IS NULL)                                            AS unknown_orders,
          SUM(IF(inv.sku IS NULL, o.quantity_sold, 0))                        AS unknown_units_sold,
          COUNT(DISTINCT CASE WHEN o.platform IS NOT NULL THEN o.platform END) AS active_platforms
        FROM o_eff o
        LEFT JOIN inv_skus_for_join inv ON COALESCE(o.mapped_inventory_sku, o.effective_sku) = inv.sku
      )
      SELECT
        @organizationId,
        inv_pivot.total_skus,
        inv_pivot.total_units,
        inv_pivot.fulfilled_units,
        inv_pivot.phantom_units,
        inv_pivot.physical_remaining_units,
        inv_pivot.in_stock_skus,
        inv_pivot.oos_skus,
        inv_pivot.phantom_skus,
        inv_pivot.undefined_skus,
        ord_pivot.units_sold_raw,
        ord_pivot.unknown_units_sold,
        ord_pivot.unknown_orders,
        ord_pivot.wrong_part_units,
        ord_pivot.total_orders,
        ord_pivot.active_platforms,
        CURRENT_TIMESTAMP()
      FROM inv_pivot, ord_pivot
    `;
    await bq.query({ query: insertQuery, params });
  }

  // ─────────────────────────────────────────────────────────────────────
  // inventory_summary — one row per (organization_id, sku)
  // ─────────────────────────────────────────────────────────────────────
  async function _rebuildInventorySummary(organizationId, skuRegex) {
    const { params, regexParam } = _bindings(organizationId, skuRegex);

    await bq.query({
      query:  `DELETE FROM ${inventorySummary} WHERE organization_id = @organizationId`,
      params: { organizationId },
    });

    const insertQuery = `
      INSERT INTO ${inventorySummary} (
        organization_id, sku, total_stock, sold_units, fulfilled_units,
        phantom_units, remaining_units, boxes_count, last_added_at,
        part_number, upc, is_undefined, refreshed_at
      )
      WITH ${_ordersAggCTE()},
      ${_invAggCTE(regexParam)},
      ${_perSkuCTE()},
      extras AS (
        SELECT
          sku,
          COUNT(DISTINCT box_number)        AS boxes_count,
          MAX(date_added)                   AS last_added_at,
          ANY_VALUE(part_number)            AS part_number,
          ANY_VALUE(upc)                    AS upc
        FROM ${invTable}
        WHERE organization_id = @organizationId
        GROUP BY sku
      )
      SELECT
        @organizationId,
        per_sku.sku,
        per_sku.initial      AS total_stock,
        per_sku.sold         AS sold_units,
        per_sku.fulfilled    AS fulfilled_units,
        per_sku.phantom      AS phantom_units,
        per_sku.remaining    AS remaining_units,
        extras.boxes_count,
        extras.last_added_at,
        extras.part_number,
        extras.upc,
        per_sku.is_undefined,
        CURRENT_TIMESTAMP()
      FROM per_sku
      LEFT JOIN extras ON per_sku.sku = extras.sku
    `;
    await bq.query({ query: insertQuery, params });
  }

  // ─────────────────────────────────────────────────────────────────────
  // box_summary_by_upc / box_summary_by_part — Option D (see audit doc).
  // Two narrow tables, each clustered for ONE search path so both
  // UPC and part-number lookups get equal sub-50ms scan performance.
  // Same row body in both; differ only in the LOWER+TRIMmed clustered
  // column (upc_norm vs part_norm).
  // ─────────────────────────────────────────────────────────────────────
  async function _rebuildBoxSummary(organizationId) {
    // Build the source aggregate once — same input rows feed both tables.
    // The CTE chain is identical to what lookupRepository.search used to do
    // (minus the operator query predicate). One round-trip per write table.
    const sourceCTE = `
      WITH inv_grouped AS (
        SELECT
          COALESCE(upc, '')         AS upc,
          COALESCE(part_number, '') AS part_number,
          COALESCE(box_number, '')  AS box_number,
          SUM(quantity)             AS initial_stock
        FROM ${invTable}
        WHERE organization_id = @organizationId
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
      ),
      ${ordersAggCTE({ ordTable })},
      box_orders AS (
        SELECT
          s.upc, s.part_number, s.box_number,
          COALESCE(SUM(o.ordered), 0) AS units_sold
        FROM inv_skus s
        LEFT JOIN orders_agg o ON s.sku = o.effective_sku
        GROUP BY s.upc, s.part_number, s.box_number
      ),
      box_rows AS (
        SELECT
          ig.upc,
          ig.part_number,
          ig.box_number,
          ig.initial_stock,
          LEAST(COALESCE(bo.units_sold, 0), ig.initial_stock)        AS fulfilled_units,
          GREATEST(COALESCE(bo.units_sold, 0) - ig.initial_stock, 0) AS phantom_units,
          GREATEST(ig.initial_stock - COALESCE(bo.units_sold, 0), 0) AS remaining_stock
        FROM inv_grouped ig
        LEFT JOIN box_orders bo
          ON  ig.box_number  = bo.box_number
          AND ig.part_number = bo.part_number
          AND ig.upc         = bo.upc
      )
    `;

    // ── box_summary_by_upc ── clustered by (org, upc_norm)
    await bq.query({
      query:  `DELETE FROM ${boxSummaryByUpc} WHERE organization_id = @organizationId`,
      params: { organizationId },
    });
    await bq.query({
      query: `
        ${sourceCTE}
        INSERT INTO ${boxSummaryByUpc} (
          organization_id, upc_norm, upc, part_number, box_number,
          initial_stock, fulfilled_units, phantom_units, remaining_stock,
          refreshed_at
        )
        SELECT
          @organizationId,
          LOWER(TRIM(upc))         AS upc_norm,
          upc, part_number, box_number,
          initial_stock, fulfilled_units, phantom_units, remaining_stock,
          CURRENT_TIMESTAMP()
        FROM box_rows
      `,
      params: { organizationId },
    });

    // ── box_summary_by_part ── clustered by (org, part_norm)
    await bq.query({
      query:  `DELETE FROM ${boxSummaryByPart} WHERE organization_id = @organizationId`,
      params: { organizationId },
    });
    await bq.query({
      query: `
        ${sourceCTE}
        INSERT INTO ${boxSummaryByPart} (
          organization_id, part_norm, upc, part_number, box_number,
          initial_stock, fulfilled_units, phantom_units, remaining_stock,
          refreshed_at
        )
        SELECT
          @organizationId,
          LOWER(TRIM(part_number)) AS part_norm,
          upc, part_number, box_number,
          initial_stock, fulfilled_units, phantom_units, remaining_stock,
          CURRENT_TIMESTAMP()
        FROM box_rows
      `,
      params: { organizationId },
    });
  }

  /**
   * Refresh ALL summaries for one organization. Called from every mutating
   * route. Best-effort: failures are logged but never thrown — callers
   * already committed the underlying mutation, and stale-by-one-event is
   * acceptable (next mutation will reconcile, and parity logging will warn).
   *
   * The KPI in-memory cache is invalidated as part of this same flow at the
   * route level (dashboardService.invalidateKPICache), so the dashboard
   * picks up the fresh summary on its next hit.
   */
  async function refresh(organizationId) {
    if (!organizationId) return { ok: false, reason: 'missing organizationId' };
    const skuRegex = await _resolveSkuRegex(organizationId);
    const start = Date.now();

    try {
      // Sequential — each rebuild is org-scoped, BQ DML queues small DMLs
      // cheaply, and the dashboard rebuild depends on the same inventory
      // state as the others (running concurrently risks read-skew).
      await _rebuildDashboardSummary(organizationId, skuRegex);
      await _rebuildInventorySummary(organizationId, skuRegex);
      await _rebuildBoxSummary(organizationId);
      logger?.info?.(
        { event: 'summary_refresh_ok', organization_id: organizationId, ms: Date.now() - start },
        'Summary tables rebuilt',
      );
      return { ok: true, ms: Date.now() - start };
    } catch (err) {
      logger?.warn?.(
        { event: 'summary_refresh_failed', organization_id: organizationId, err: err?.message },
        'Summary refresh failed — read-path KPIs may be stale until next refresh',
      );
      return { ok: false, reason: err?.message ?? String(err) };
    }
  }

  return { refresh };
}
