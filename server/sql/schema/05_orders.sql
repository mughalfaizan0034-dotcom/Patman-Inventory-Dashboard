-- ============================================================
-- orders — canonical DDL
-- ------------------------------------------------------------
-- One row per fulfilled order line per organization.
--
-- order_row_id is the canonical Order ID exposed in the UI and
-- used for PATCH/DELETE/dedup operations.
--
-- shipped_from_box is the OPERATIONAL override that re-routes the
-- inventory deduction to a different ARA box when the original
-- box is out of stock. Inventory deduction always uses the
-- EFFECTIVE shipped SKU, NEVER the original feed SKU.
--
-- mapped_inventory_sku is an alternate (legacy) mapping used to
-- rescue an order whose feed SKU doesn't match any inventory row
-- even after the shipped_from_box override is applied.
--
-- LEGACY FIELDS (slated for removal in Phase D):
--   is_ignored, ignored_at, ignored_by — soft-delete flag from the
--   pre-shipped-SKU era. No new writes; existing rows excluded
--   from every view via `COALESCE(is_ignored, FALSE) = FALSE`.
-- ============================================================

CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.orders` (
  order_row_id         STRING    NOT NULL,             -- INTERNAL UID: row tracker for API updates/deletes (do not show as "order ID")
  organization_id      STRING    NOT NULL,
  order_id             STRING,                          -- EXTERNAL marketplace order ID (Amazon order #, eBay sale ID, etc.) — user-provided
  order_date           STRING    NOT NULL,             -- YYYY-MM-DD; queries use SAFE_CAST(order_date AS DATE)
  sku                  STRING    NOT NULL,             -- feed SKU; may be overridden by shipped_from_box
  quantity_sold        INT64     NOT NULL,
  platform             STRING    NOT NULL,             -- e.g. Amazon, eBay, Walmart, Shopify
  shipped_from_box     STRING,                         -- OPERATIONAL OVERRIDE: box number for ARA reassignment
  mapped_inventory_sku STRING,                         -- alternate manual mapping (rescue path)
  uploaded_by          STRING,                         -- user_id of uploader
  created_at           TIMESTAMP,                      -- upload timestamp
  mapped_at            TIMESTAMP,
  mapped_by            STRING,

  -- Legacy fields (Phase D will drop these):
  is_ignored           BOOL,
  ignored_at           TIMESTAMP,
  ignored_by           STRING
);

-- Uniqueness contracts enforced by application code:
--   UNIQUE(order_row_id)
