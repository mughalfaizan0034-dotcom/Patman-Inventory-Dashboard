-- ============================================================
-- memberships — canonical DDL
-- ------------------------------------------------------------
-- Many-to-many between users and organizations.
-- Role is currently per-org; Phase C will migrate it to a global
-- field on `users.role` and this column will be removed.
--
-- The JWT access token carries (user_id, organization_id, membership_id, role)
-- so every authenticated request is scoped to exactly one membership.
-- ============================================================

CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.memberships` (
  membership_id    STRING    NOT NULL,
  user_id          STRING    NOT NULL,
  organization_id  STRING    NOT NULL,
  role             STRING    NOT NULL,                -- {admin, manager, staff, viewer} (Phase C will collapse to {viewer, user, admin} on users.role)
  is_active        BOOL      NOT NULL,
  created_at       TIMESTAMP
);

-- Uniqueness contracts enforced by application code:
--   UNIQUE(membership_id)
--   UNIQUE(user_id, organization_id)   — one membership per user per org
