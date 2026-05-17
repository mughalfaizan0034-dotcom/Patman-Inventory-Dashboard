-- ============================================================
-- 20260517_002 — Materialized summary tables
-- ------------------------------------------------------------
-- Three read-optimized summaries that replace per-page CTE
-- aggregation. Populated by server/src/services/summaryRefreshService.js.
--
-- Refresh strategy:
--   - One row per (organization_id, ...key) per summary.
--   - Refresh runs after mutating operations: uploads, inventory
--     edit/delete, orders edit/delete, shipped-SKU reassign, org
--     sku_structure update.
--   - Refresh failures are NON-FATAL — they log a warning and the
--     caller proceeds. Reads still work because the parity logging
--     in dashboardService.getKPIs detects staleness and the in-memory
--     KPI cache (60s) papers over short windows.
--
-- Read paths (Phase B cutover):
--   dashboard_summary  → dashboardService.getKPIs
--   inventory_summary  → inventoryMetricsService.getSkuSummary
--   box_summary        → lookupRepository.search
--
-- Until Phase B cutover, read paths still use live CTEs and parity
-- logging compares summary table vs live CTE output. Cutover happens
-- only after observed parity = 0 diffs.
--
-- Clustering: all three cluster on organization_id (the universal
-- filter). inventory_summary additionally clusters on sku for fast
-- single-SKU drilldown. box_summary on upc for fast Box Lookup.
-- ============================================================

-- ── dashboard_summary ──────────────────────────────────────────
-- One row per organization. Powers Dashboard KPI cards.
CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.dashboard_summary` (
  organization_id          STRING    NOT NULL,

  -- Inventory KPIs
  total_skus               INT64,
  total_units              INT64,
  fulfilled_units          INT64,
  phantom_units            INT64,
  physical_remaining_units INT64,
  in_stock_skus            INT64,
  oos_skus                 INT64,
  phantom_skus             INT64,
  undefined_skus           INT64,

  -- Sales KPIs
  units_sold_raw           INT64,
  unknown_units_sold       INT64,
  unknown_orders           INT64,
  wrong_part_units         INT64,
  total_orders             INT64,
  active_platforms         INT64,

  -- When this row was last rebuilt by summaryRefreshService.
  refreshed_at             TIMESTAMP NOT NULL
)
CLUSTER BY organization_id;


-- ── inventory_summary ──────────────────────────────────────────
-- One row per (organization_id, sku). Powers SKU View.
CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.inventory_summary` (
  organization_id   STRING    NOT NULL,
  sku               STRING    NOT NULL,

  total_stock       INT64,    -- SUM(quantity) over all upload rows
  sold_units        INT64,    -- SUM(quantity_sold) over orders mapped to this SKU
  fulfilled_units   INT64,    -- LEAST(sold, total_stock)
  phantom_units     INT64,    -- GREATEST(sold - total_stock, 0)
  remaining_units   INT64,    -- GREATEST(total_stock - sold, 0)

  boxes_count       INT64,    -- COUNT(DISTINCT box_number)
  last_added_at     STRING,   -- MAX(date_added)
  part_number       STRING,   -- ANY_VALUE — same across all rows with this SKU by construction
  upc               STRING,   -- ANY_VALUE — same across all rows with this SKU by construction
  is_undefined      BOOL,     -- structure-regex + placeholder check

  refreshed_at      TIMESTAMP NOT NULL
)
CLUSTER BY organization_id, sku;


-- ── box_summary ────────────────────────────────────────────────
-- One row per (organization_id, upc, part_number, box_number). Powers
-- Box Lookup operational diagnostics.
CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.box_summary` (
  organization_id   STRING    NOT NULL,
  upc               STRING    NOT NULL,
  part_number       STRING    NOT NULL,
  box_number        STRING    NOT NULL,

  initial_stock     INT64,
  fulfilled_units   INT64,
  phantom_units     INT64,
  remaining_stock   INT64,

  refreshed_at      TIMESTAMP NOT NULL
)
CLUSTER BY organization_id, upc;


-- Verification:
SELECT table_name, clustering_fields
FROM `patman-inventory.patman_inventory.INFORMATION_SCHEMA.TABLES`
WHERE table_name IN ('dashboard_summary', 'inventory_summary', 'box_summary')
ORDER BY table_name;
