-- ============================================================
-- organizations — canonical DDL
-- ------------------------------------------------------------
-- One row per tenant. Identity columns are organization_id (uuid)
-- and slug (human-friendly URL identifier, unique).
--
-- All other rows in every other table reference organization_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.organizations` (
  organization_id  STRING    NOT NULL,
  slug             STRING    NOT NULL,
  display_name     STRING    NOT NULL,
  is_active        BOOL      NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- Uniqueness contracts enforced by application code (BigQuery does not enforce):
--   UNIQUE(organization_id)
--   UNIQUE(slug)
