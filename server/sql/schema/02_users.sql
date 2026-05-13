-- ============================================================
-- users — canonical DDL (post Phase-B migration)
-- ------------------------------------------------------------
-- Global user identity. No organization_id, no role.
--   - Organization membership is recorded ONLY in `memberships`.
--   - Role lives ONLY on `memberships.role` until Phase C promotes
--     it to a global `users.role` column (3-tier viewer/user/admin).
--
-- Login credential is `username` (globally unique, case-insensitive).
-- `email` is optional — for notifications/recovery only.
-- ============================================================

CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.users` (
  user_id        STRING    NOT NULL,
  username       STRING    NOT NULL,
  email          STRING,                              -- nullable; not a login credential
  password_hash  STRING    NOT NULL,                  -- bcrypt; legacy SHA-256 upgraded on next login
  display_name   STRING    NOT NULL,
  is_active      BOOL      NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  updated_at     TIMESTAMP
);

-- Uniqueness contracts enforced by application code:
--   UNIQUE(user_id)
--   UNIQUE(LOWER(username))   — see usernameService.normalize()
