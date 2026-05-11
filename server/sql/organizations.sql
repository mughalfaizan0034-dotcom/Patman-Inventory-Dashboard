-- Organizations table — one row per tenant.
-- organization_slug is the human-readable tenant namespace used at login.
-- settings_json holds tenant-specific feature flags and config (no schema migration needed for new fields).
CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.organizations` (
  organization_id   STRING    NOT NULL,
  organization_slug STRING    NOT NULL,
  organization_name STRING    NOT NULL,
  status            STRING    NOT NULL DEFAULT 'active',
  settings_json     STRING,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- Seed: initial tenant
INSERT INTO `patman-inventory.patman_inventory.organizations`
  (organization_id, organization_slug, organization_name, status, created_at)
VALUES
  (GENERATE_UUID(), 'patman', 'Patman Inventory', 'active', CURRENT_TIMESTAMP());
