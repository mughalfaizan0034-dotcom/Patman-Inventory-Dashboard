-- Users table — multi-tenant: usernames are unique per organization, not globally.
-- email is stored for notifications/recovery but is NOT the login credential.
-- Login credential is: organization_slug + username + password.
CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.users` (
  user_id         STRING    NOT NULL,
  organization_id STRING    NOT NULL,
  username        STRING    NOT NULL,
  email           STRING,
  password_hash   STRING    NOT NULL,
  display_name    STRING,
  role            STRING    NOT NULL DEFAULT 'viewer',
  is_active       BOOL      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  updated_at      TIMESTAMP
);

-- BigQuery does not enforce UNIQUE constraints, but application code enforces:
--   UNIQUE(organization_id, username) — see usersRepository.findByUsername()
--   Uniqueness checks are race-condition-safe via usernameService.

-- Migration: backfill existing single-tenant users to the 'patman' org.
-- Run AFTER organizations table is seeded.
--
-- UPDATE `patman-inventory.patman_inventory.users` u
-- SET
--   organization_id = (
--     SELECT organization_id FROM `patman-inventory.patman_inventory.organizations`
--     WHERE organization_slug = 'patman' LIMIT 1
--   ),
--   username = REGEXP_REPLACE(LOWER(SPLIT(u.email, '@')[OFFSET(0)]), '[^a-z0-9_]', '')
-- WHERE u.organization_id IS NULL OR u.organization_id = '';
