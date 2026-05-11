-- Inventory table — tenant-scoped. organization_id is mandatory on every row.
-- All queries MUST include WHERE organization_id = @organizationId.
CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.inventory` (
  organization_id  STRING    NOT NULL,
  sku              STRING    NOT NULL,
  name             STRING,
  platform         STRING,
  initial_stock    INT64     NOT NULL DEFAULT 0,
  units_sold       INT64     NOT NULL DEFAULT 0,
  units_returned   INT64     NOT NULL DEFAULT 0,
  is_active        BOOL      NOT NULL DEFAULT TRUE,
  updated_at       TIMESTAMP,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);
-- Computed stock = initial_stock - units_sold + units_returned (can be negative by design).
-- Negative stock = phantom units sold beyond initial allocation.
