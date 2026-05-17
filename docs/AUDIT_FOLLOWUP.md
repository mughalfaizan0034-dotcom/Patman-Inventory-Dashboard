# Audit Follow-Up Plan

This document captures the four heavier items deferred from the
enterprise-grade security/performance/architecture audit. Each section
contains the problem, the file:line evidence, and a step-by-step
implementation plan.

Issued: 2026-05-17
Source: full-stack audit (see chat transcript / FINDINGS report)
Session-1 fixes that already landed (do NOT re-do):
- M1: `/auth/switch-org` `is_active` check
- M2: frontend `switchOrg` writes new refresh token
- M5: deleted dead BQ-v2 fallback proxy
- L2: deleted dead `notIgnored` SQL fragment
- M9: deleted dead `ALLOWED_MIME` constant
- M10: deleted orphan `.tmp` file + added `*.tmp.*` to `.gitignore`
- M6: deleted orphan API methods + `GET /inventory/` + `GET /inventory/export`
       + `inventoryService.list/exportAll` + `inventoryRepository.findAll/exportAll`
- M7: deleted `backend/*.gs` legacy Apps Script
- M8: archived legacy migration JSONs under `server/migrations/_archive/`
- H1: introduced backend KPI cache (per-org, 60s TTL, real `invalidateKPICache`)

---

## C1 — BigQuery partition/cluster migration (highest cost-impact)

### Problem
The two largest BigQuery tables have no partitioning or clustering:
- [server/sql/schema/04_inventory.sql](../server/sql/schema/04_inventory.sql)
- [server/sql/schema/05_orders.sql](../server/sql/schema/05_orders.sql)

Every query (`WHERE organization_id = @x` and `WHERE order_date >= @date`)
scans the entire physical table. Cost grows multiplicatively with orgs ×
active users × page loads.

The older migration `002_inventory_schema.sql` had `CLUSTER BY
organization_id, sku` and `CLUSTER BY organization_id, order_date` — that
was lost when the canonical DDL was rewritten.

### Target schema
```sql
-- inventory
CREATE TABLE patman-inventory.patman_inventory.inventory_new (
  ... same columns ...
)
CLUSTER BY organization_id, sku;

-- orders
CREATE TABLE patman-inventory.patman_inventory.orders_new (
  ... same columns ...
)
PARTITION BY DATE(SAFE_CAST(order_date AS DATE))
CLUSTER BY organization_id, sku;
```

Why partition `orders` by `order_date` and not `created_at`:
- All filtering in `dashboardRepository.getPerformance` already uses
  `SAFE_CAST(order_date AS DATE)` predicates. Partition pruning will kick
  in automatically.
- `created_at` is upload-time which has near-flat distribution and doesn't
  help pruning.

Why cluster `inventory` only (no partition):
- No timestamp-shaped predicate in the inventory hot path.
- Clustering by `(organization_id, sku)` is exactly aligned with every
  `WHERE organization_id = @x [AND sku = @y]` access pattern.

### Migration plan (zero-downtime)
1. **Create new tables** with partition + cluster:
   ```sql
   CREATE TABLE patman-inventory.patman_inventory.inventory_new
   PARTITION BY ...
   CLUSTER BY organization_id, sku
   AS SELECT * FROM patman-inventory.patman_inventory.inventory;
   ```
2. **Verify row counts match**:
   ```sql
   SELECT COUNT(*) FROM inventory;
   SELECT COUNT(*) FROM inventory_new;
   ```
3. **Atomic rename**:
   ```sql
   ALTER TABLE inventory RENAME TO inventory_old;
   ALTER TABLE inventory_new RENAME TO inventory;
   ```
4. **Smoke-test the app** against the renamed table (read paths).
5. **Drop the old table** after a 24-hour grace period.
6. Repeat for `orders`.

### Pitfalls to avoid
- BigQuery's `CREATE TABLE ... AS SELECT` doesn't carry partitioning;
  must be declared explicitly in the new DDL.
- Streaming inserts to a recently-created table can have a buffer delay;
  pause uploads during the swap window (~5 minutes).
- Run during low-traffic window; the verification COUNT pair can be
  ~30 seconds for very large tables.

### Expected impact
- 5-10× scan reduction on dashboard queries (only the org's slice).
- Partition pruning on date-range queries: `Last 12 weeks` reads
  ~12 partitions instead of full history.
- No application code change required.

---

## C2 — Refresh-token revocation table (highest security-impact)

### Problem
[server/src/repositories/refreshTokensRepository.js](../server/src/repositories/refreshTokensRepository.js)
is a fully-stubbed module. `isRevoked()` returns `false`. No `save()` is
ever called. A leaked refresh token works for the full
`JWT_REFRESH_EXPIRES` (7 days) regardless of password change, logout, or
user deactivation.

### Target table
```sql
CREATE TABLE patman-inventory.patman_inventory.refresh_tokens (
  jti              STRING    NOT NULL,
  user_id          STRING    NOT NULL,
  organization_id  STRING,
  created_at       TIMESTAMP NOT NULL,
  expires_at       TIMESTAMP NOT NULL,
  revoked          BOOL      NOT NULL DEFAULT FALSE,
  revoked_at       TIMESTAMP,
  revoked_reason   STRING               -- 'logout' | 'password_change' | 'user_deactivated' | 'admin'
)
PARTITION BY DATE(expires_at)
CLUSTER BY user_id, jti;
```

### Implementation steps
1. **Migration file** `server/sql/migrations/20260517_001_create_refresh_tokens.sql`
   with the DDL above.
2. **Implement the repo methods** in `refreshTokensRepository.js`:
   - `save(jti, userId, organizationId, expiresAt)` — DML INSERT
   - `isRevoked(jti)` — SELECT revoked WHERE jti; unknown jti = treat as revoked
   - `revoke(jti, reason)` — UPDATE SET revoked = TRUE
   - `revokeAllForUser(userId, reason)` — UPDATE all user's tokens
3. **Wire into the auth flow** (`server/src/routes/auth.js`):
   - After every `tokenFactory.signRefreshToken()`, call `save()`.
   - At the top of `/auth/refresh`, after JWT verify, decode the `jti`
     and call `isRevoked()` — reject with 401 if revoked.
4. **Add `/auth/logout`** endpoint that calls `revoke(jti, 'logout')`.
   Frontend should call this before clearing local session.
5. **Wire `revokeAllForUser`** into:
   - `usersService.updateGlobalUser` when `is_active` becomes false
   - `usersService.updateGlobalUser` when password changes
6. **Inject `refreshTokensRepo`** into the auth route module in `server.js`.

### Frontend changes
- [js/auth.js](../js/auth.js) `logout()` — POST `/auth/logout` with the
  refresh token in the body before clearing local storage.

### Pitfalls to avoid
- Don't `revoke()` synchronously on every refresh — keep refresh-token
  rotation: revoke the old `jti` and save the new one in the SAME flow.
  Otherwise an interrupted refresh leaves the user with no usable token.
- `revoke` failures must not fail the login/logout endpoint — wrap in
  try/catch and log; security degrades to "as before" but the user
  isn't locked out.

### Expected impact
- Logout actually invalidates the refresh token immediately.
- Password change immediately invalidates all sessions for that user.
- User deactivation immediately invalidates all sessions.
- Auditable revocation trail.

---

## Materialized summary tables (architecturally cleanest performance win)

### Problem
H1 (KPI cache) shipped a 60s in-memory cache, which fixes the common
read pattern (dashboard load → tab focus → idle). It does NOT eliminate
the underlying BigQuery scans — every cache miss still runs the full
`_ordersAggCTE` + `_invAggCTE` + `_perSkuCTE` pipeline against the raw
tables.

Architecture mandate (your direction): "ensure summaries rebuild ONLY
after uploads / deletes / shipped SKU reassignment / inventory mutations
/ validation structure changes."

### Target tables
```sql
-- dashboard-level summary: one row per org, refreshed on upload/edit/delete
CREATE TABLE patman-inventory.patman_inventory.dashboard_summary (
  organization_id          STRING    NOT NULL,
  total_skus               INT64,
  total_units              INT64,
  fulfilled_units          INT64,
  phantom_units            INT64,
  physical_remaining_units INT64,
  in_stock_skus            INT64,
  oos_skus                 INT64,
  phantom_skus             INT64,
  undefined_skus           INT64,
  units_sold_raw           INT64,
  unknown_units_sold       INT64,
  unknown_orders           INT64,
  wrong_part_units         INT64,
  total_orders             INT64,
  active_platforms         INT64,
  refreshed_at             TIMESTAMP NOT NULL
)
CLUSTER BY organization_id;

-- per-SKU summary: powers SKU View directly
CREATE TABLE patman-inventory.patman_inventory.inventory_summary (
  organization_id   STRING    NOT NULL,
  sku               STRING    NOT NULL,
  total_stock       INT64,
  sold_units        INT64,
  fulfilled_units   INT64,
  phantom_units     INT64,
  remaining_units   INT64,
  boxes_count       INT64,
  last_added_at     STRING,
  part_number       STRING,
  upc               STRING,
  is_undefined      BOOL,
  refreshed_at      TIMESTAMP NOT NULL
)
CLUSTER BY organization_id, sku;

-- box-level summary: powers Box Lookup
CREATE TABLE patman-inventory.patman_inventory.box_summary (
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
```

### Refresh strategy
Create `summaryRefreshService.refresh(orgId)` that runs three DML
INSERT...SELECT statements (using the existing CTE templates from
`inventoryMetricsService`) into the summary tables, scoped to a single
org. Total runtime per org: 2-5 seconds.

Trigger points:
- `uploadsService.processInventoryUpload` — after the upload commits
- `uploadsService.processOrdersUpload` — after the upload commits
- `inventoryService.updateRow` — after any inventory edit
- `inventoryService.deleteRows` — after any inventory delete
- `ordersService.updateRow` — after any shipped-SKU reassignment
- `ordersService.deleteRows` — after any order delete
- `organizationsRepo.update` — when `sku_structure` changes (affects
  `is_undefined` classification)

### Read-path changes
- `dashboardService.getKPIs(orgId)` → single `SELECT * FROM dashboard_summary
  WHERE organization_id = @orgId LIMIT 1`. No CTEs.
- `inventoryMetricsService.getSkuSummary(orgId, opts)` → `SELECT ... FROM
  inventory_summary WHERE organization_id = @orgId AND <filters>
  ORDER BY ... LIMIT N OFFSET M`. No CTEs.
- `lookupRepository.search(orgId, q)` → `SELECT ... FROM box_summary
  WHERE organization_id = @orgId AND (upc = @q OR part_number = @q)`.
- The in-memory KPI cache (H1) can be REMOVED after this lands — the
  read is already cheap.

### Pitfalls to avoid
- Refresh failures must not fail the originating upload/edit. Wrap in
  try/catch + log; stale-by-1-upload is acceptable, broken upload is not.
- The `refreshed_at` column lets the UI show a "Updated X seconds ago"
  marker if needed.
- During the transition, run BOTH the live CTE and the summary read in
  parallel for a week and diff the results in logs. Cut over when zero
  diffs.

### Expected impact
- Dashboard load: 2 BQ queries (~1.5s) → 1 BQ query (~50ms) → with cache:
  ~5ms.
- SKU View load: 1 large BQ query (~1s) → 1 small index seek (~100ms).
- Box Lookup: similar 10× improvement.
- Multi-org cost scales linearly with org count, not with org × user
  × page-view.

---

## M3 — Merge dashboard's two BQ queries into one + M4 — Activity log to DML INSERT + partitioning

### M3: dashboard query consolidation
[server/src/services/inventoryMetricsService.js:162-165](../server/src/services/inventoryMetricsService.js#L162-L165)

`summaryQuery` (per-SKU pivot) and `ordersQuery` (raw totals + unknown counts
via LEFT JOIN to inv_skus) currently run as `Promise.all`. They share the
`inv_skus` CTE conceptually.

Fix: rewrite as one query returning two row groups (UNION ALL with a `kind`
column, or use a single `WITH ...` that returns a struct).

Halves BQ requests on the hot path. This becomes moot once materialized
summaries land — leave M3 until after that decision is made.

---

## D1 — Undefined-SKU classification disagrees with the SKU structure validator (drift bug)

### Problem
The org's SKU structure modal validates a sample SKU live and shows it as
✓ Valid, but the dashboard / SKU View classifies the same SKU as
**Undefined**. Reproduced 2026-05-17 with:

- Org structure: `ARA - [{Box}] - {Part Number} - {UPC}`
- Tested SKU: `ARA100-NoMdel-887220767414` → modal says ✓ Valid
- Inventory page: same SKU rendered with the amber **UNDEFINED** badge

This violates the centralized-engine mandate: two code paths claim to
apply the same SKU structure rule but produce opposite results.

### Suspected root cause
- **Modal validator** (frontend JS) compares against the structure with
  `normalizeSku` applied first — which uppercases the SKU when
  `case_insensitive: true`. So `NoMdel` becomes `NOMDEL` before regex
  match. See [server/src/utils/skuEngine.js:289-295](../server/src/utils/skuEngine.js#L289-L295).
- **SQL classifier** uses `REGEXP_CONTAINS(IFNULL(sku, ''), @sku_regex)`
  in `isUndefinedSql` ([server/src/utils/inventoryPatterns.js:57-74](../server/src/utils/inventoryPatterns.js#L57-L74)).
  BigQuery RE2 is **case-sensitive by default**. The compiled regex
  doesn't include `(?i)` or an uppercased character class — so a SKU
  with mixed-case part-number text (`NoMdel`) fails the regex even
  though the structure is `case_insensitive: true`.

The validator and the classifier diverge whenever the SKU contains
lowercase characters AND the structure is configured `case_insensitive`.

### Confirmation steps (when picking this up)
1. Read `compileSegmentsRegex` in [server/src/utils/skuEngine.js:259-282](../server/src/utils/skuEngine.js#L259-L282) — confirm whether the
   compiled regex has any case-folding marker.
2. Read `_segmentBody` to see the character class used for `letters_and_numbers` / `letters` segments. If it's `[A-Z]+` it requires
   uppercase; if `[A-Za-z]+` or `[A-Z0-9]+` etc.
3. Run in BQ console:
   ```sql
   SELECT REGEXP_CONTAINS('ARA100-NoMdel-887220767414', r'^ARA…')
   ```
   with the literal compiled regex from `organizations.sku_structure` to
   confirm the false-negative.

### Fix options

**A. Apply the same normalization in SQL** (recommended)
Update `isUndefinedSql` to `UPPER(IFNULL(sku, ''))` before the regex
check whenever the structure is `case_insensitive: true`. The compiled
regex then only needs to match the uppercase form.

```sql
-- in isUndefinedSql (when case_insensitive)
NOT REGEXP_CONTAINS(UPPER(IFNULL(sku, '')), @sku_regex)
```

The corresponding regex compilation should produce uppercase character
classes (`[A-Z0-9]+` not `[A-Za-z0-9]+`) when case_insensitive is set.

**B. Switch BQ regex to RE2's inline case flag**
Prepend `(?i)` to the compiled regex when `case_insensitive: true`.
BigQuery RE2 supports `(?i)` for case-insensitive matching. This is the
lowest-touch fix — change one line in `compileSegmentsRegex`.

```javascript
// in compileSegmentsRegex
const prefix = s.case_insensitive ? '(?i)' : '';
return `${prefix}^${body}$`;
```

Option B is the smaller change but less explicit; option A keeps the
regex pure and moves all case logic to one place.

### Impact when fixed
- Inventory rows like `ARA100-NoMdel-887220767414` (mixed-case
  "letters & numbers" segments) will correctly classify as **valid**.
- Dashboard Undefined SKU KPI count drops by however many rows have
  this shape.
- SKU View no longer shows misleading amber-tinted rows for
  legitimately-structured SKUs.

### Test plan
1. Pick 3 SKUs that differ only in casing of letter segments
   (`ARA1-AB12-12345`, `ARA1-Ab12-12345`, `ARA1-aB12-12345`).
2. In an org configured `case_insensitive: true`, all three must:
   - Validate as ✓ in the modal validator.
   - NOT appear in the Undefined SKU filter on SKU View.
   - NOT add to the dashboard "Undefined SKUs" KPI.
3. In an org configured `case_insensitive: false`, only the
   canonically-cased SKU should pass.

---

---

## D2 — Hard-delete option for users and organizations

### Goal
Today the Settings page can only **deactivate** users and orgs (sets
`is_active = false`; row is preserved for audit). Operators need a way to
**permanently delete** rows when:
- A test user / sandbox org needs to be removed completely.
- Compliance / GDPR-style erasure requests.
- A misconfigured org needs a clean rebuild without trailing data.

Deactivate must remain the default action — hard delete is opt-in,
secondary, and clearly destructive.

### UX requirements
- Settings → Users list:
  - Existing **Deactivate** button stays as primary trailing action.
  - Add a **Delete permanently** button in the row's overflow menu
    (kebab `⋮`), styled with destructive red text and an icon.
- Settings → Organizations list:
  - Same pattern. Deactivate stays primary; Delete in overflow.
- Confirmation modal:
  - Title: "Delete user / organization permanently"
  - Body lists what will be removed (memberships, audit refs, etc.).
  - Operator must **type the username / org slug** to enable the
    Delete button. Same as how DROP TABLE prompts in DBeaver/etc.
  - Final button is `Delete forever` (btn-danger).

### Backend contract

**User hard delete**: `DELETE /users/:id/permanent` (admin only)

What it removes:
- `users` row
- `memberships` rows for this user (across all orgs)
- `refresh_tokens` rows for this user (once C2 lands)

What it preserves (for audit):
- `activity_log` rows — `user_id` is nullable, so we NULL it out instead
  of cascade-deleting history. The audit log still shows "User X
  uploaded inventory" but with the user reference replaced by a
  placeholder ("deleted user").
- `inventory.uploaded_by`, `orders.uploaded_by` — same treatment, NULL out.

Pre-flight safety check:
- Prevent self-delete: `if (req.params.id === request.user.user_id) → 400`
- Optional: prevent deleting the last admin (could lock everyone out
  of an org).

**Organization hard delete**: `DELETE /organizations/:id/permanent` (admin only)

What it removes:
- `organizations` row
- All `memberships` for this org
- All `inventory` rows for this org
- All `orders` rows for this org
- All `inventory_uploads`, `order_uploads` rows for this org
- All `activity_log` rows for this org (org is the audit scope; no
  cross-org audit history exists for a deleted org)

Pre-flight safety check:
- Prevent deletion of the org the requesting admin is currently
  signed into (forces a switch first).
- Return 400 with a clear message if any active mutating uploads are
  in-flight for the org (acquire-once flag during upload).

### Implementation steps
1. **Backend routes**:
   - `server/src/routes/users.js` — add `DELETE /:id/permanent`.
   - `server/src/routes/organizations.js` — add `DELETE /:id/permanent`.
   - Both behind `requireRole('admin')` + double-confirmation header
     `X-Confirm-Delete: <username|slug>` matching the URL param.
2. **Service methods**:
   - `usersService.hardDeleteUser(userId, requestingUserId)`
   - Each implements the cascade above as a sequence of DELETE/UPDATE
     calls. Wrap in a try/catch with rollback log if any step fails
     (BigQuery has no transactions across queries; each DML is
     individually atomic — log enough to manually reconcile if a
     mid-cascade failure occurs).
3. **Repo methods**:
   - `usersRepo.deletePermanent(userId)`
   - `usersRepo.nullifyAuditReferences(userId)` — UPDATE inventory /
     orders / activity_log SET user_id = NULL WHERE user_id = @x.
   - `orgsRepo.deletePermanent(organizationId)`
   - `inventoryRepo.deleteAllForOrg`, `ordersRepo.deleteAllForOrg`,
     `uploadsRepo.deleteAllForOrg`, `activityRepo.deleteAllForOrg`.
4. **Frontend**:
   - [js/app.js](../js/app.js) Settings page — add overflow menu with
     Delete entry per row.
   - Build a `Modal.dangerDelete(prompt, expectedText)` helper in
     [js/utilities.js](../js/utilities.js) for the typed-confirmation modal.
   - Wire to the new API client methods `API.deleteUserPermanent(id)`
     and `API.deleteOrgPermanent(id)`.
5. **Auditing**:
   - Log a final `activity_log` entry (user_id = requesting admin,
     description = "Permanently deleted user/org X") BEFORE the cascade
     runs, so the action survives the org/user it destroyed.

### Pitfalls to avoid
- Don't soft-delete instead of hard-delete when the user explicitly
  picks hard delete. The whole point is the rows actually disappear.
- BigQuery's streaming-insert buffer can block DELETE for ~90 minutes
  on recently-streamed rows. Activity log is currently streaming
  (see M4); switch that to DML INSERT first or document the buffer
  delay in the UI ("Audit entries from the last hour may take up to
  90 minutes to be removed").
- Make sure the cascade DELETEs are ordered: child tables first
  (memberships, inventory, orders) then the parent (org). Otherwise
  foreign-key-style integrity checks (when added later) would block.
- Never expose hard-delete to anything below `admin` role. Even a
  manager seeing the Delete button by mistake is a UX failure.

### Test plan
1. Create a test user + test org. Add some inventory + orders + activity.
2. From a different admin's session, hard-delete the test user — verify
   the user is gone, the `activity_log` rows still exist with `user_id =
   NULL`, and the user can no longer log in.
3. Hard-delete the test org — verify all inventory, orders, uploads,
   memberships, activity rows for that org are gone. Verify other orgs'
   data is untouched (org isolation under deletion).
4. Try to hard-delete the currently-signed-in admin's own user — must
   be rejected with 400.
5. Try to hard-delete the currently-active org — must be rejected.

### Why this isn't a quick win
- ~6 new repo methods, 2 new service methods, 2 new routes, 1 new
  modal pattern, 2 frontend wiring points.
- Touches the most destructive operations in the platform; bugs here
  could nuke production data. Must ship with a test plan executed
  against a staging environment first.
- Estimated effort: 0.5–1 day of focused work.

---

### M4: activity log
[server/src/repositories/activityRepository.js:28](../server/src/repositories/activityRepository.js#L28)

Currently uses `dataset.table('activity_log').insert([row])` — streaming
inserts API. Costs more per row than DML and has a 90-min buffer that
delays UPDATEs/DELETEs against recent rows.

Fix:
1. Migration: rebuild `activity_log` with
   `PARTITION BY DATE(created_at) CLUSTER BY organization_id, action_type`.
2. Switch `activityRepository.log` to DML INSERT (mirror
   `uploadsRepository.insertOrdersBatch` pattern).
3. Verify cost dashboard shows the drop (typically ~70%).
