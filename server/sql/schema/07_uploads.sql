-- ============================================================
-- inventory_uploads, order_uploads — canonical DDLs
-- ------------------------------------------------------------
-- Per-upload audit rows recording each .txt import attempt.
-- Used by the Uploads page history pane.
--
-- status values: success | partial | failed
-- ============================================================

CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.inventory_uploads` (
  upload_id        STRING    NOT NULL,
  organization_id  STRING    NOT NULL,
  user_id          STRING,                            -- nullable: failsafe for orphaned uploads
  filename         STRING    NOT NULL,
  row_count        INT64     NOT NULL,                -- rows successfully processed (added + updated + removed)
  status           STRING    NOT NULL,                -- success | partial | failed
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.order_uploads` (
  upload_id        STRING    NOT NULL,
  organization_id  STRING    NOT NULL,
  user_id          STRING,
  filename         STRING    NOT NULL,
  row_count        INT64     NOT NULL,
  status           STRING    NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- Uniqueness contracts enforced by application code:
--   UNIQUE(upload_id) — both tables
