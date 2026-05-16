-- ============================================================
-- orders — canonical DDL (post Phase-D)
-- ------------------------------------------------------------
-- One row per fulfilled order line per organization.
--
-- order_row_id is the canonical INTERNAL UID — used for PATCH/DELETE.
-- order_id is the EXTERNAL marketplace order number (Amazon, eBay, etc.).
--
-- shipped_from_box is the OPERATIONAL override that re-routes the
-- inventory deduction to a different ARA box when the original
-- box is out of stock. Inventory deduction always uses the
-- EFFECTIVE shipped SKU, NEVER the original feed SKU.
--
-- shipped_sku_override holds a FULL alternate SKU when the operator
-- shipped a DIFFERENT part/UPC entirely (not just a different box).
-- When set, effective_sku uses it verbatim. Surfaced as the
-- "Shipped Wrong Part Number" status on the Orders page.
--
-- mapped_inventory_sku is an alternate manual mapping used to
-- rescue an order whose feed SKU doesn't match any inventory row
-- even after the shipped_from_box override is applied.
--
-- LEGACY FIELDS REMOVED in Phase D (no longer present):
--   is_ignored, ignored_at, ignored_by — replaced by hard deletes.
-- ============================================================

CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.orders` (
  order_row_id         STRING    NOT NULL,             -- INTERNAL UID: row tracker for API updates/deletes
  organization_id      STRING    NOT NULL,
  order_id             STRING,                          -- EXTERNAL marketplace order ID
  order_date           STRING    NOT NULL,             -- YYYY-MM-DD; queries use SAFE_CAST(order_date AS DATE)
  sku                  STRING    NOT NULL,             -- feed SKU; may be overridden by shipped_from_box
  quantity_sold        INT64     NOT NULL,
  platform             STRING    NOT NULL,
  shipped_from_box     STRING,                         -- OPERATIONAL OVERRIDE: box number for ARA reassignment
  shipped_sku_override STRING,                         -- WRONG-PART OVERRIDE: full alternate SKU (different part/UPC)
  mapped_inventory_sku STRING,                         -- alternate manual mapping (rescue path)
  uploaded_by          STRING,                         -- user_id of uploader
  created_at           TIMESTAMP,                      -- upload timestamp
  mapped_at            TIMESTAMP,
  mapped_by            STRING
);

-- Uniqueness contracts enforced by application code:
--   UNIQUE(order_row_id)
