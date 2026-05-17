# Patman Inventory System — Master Architecture & Operational Guide

# Current Architecture Snapshot (2026-05-17, post-audit)

This section is the canonical map of where the centralized analytics
engine lives today. It's maintained alongside the code — if you change
the architecture, update this.

## Centralized analytics engine

**Single source of truth**: [server/src/services/inventoryMetricsService.js](server/src/services/inventoryMetricsService.js)
- `computeSummary(orgId)` — dashboard KPI totals
- `getSkuSummary(orgId, opts)` — paginated per-SKU pivot (SKU View page)
- `getRawRowsForFilteredSkus(orgId, opts)` — drilldown export for raw rows under SKU filter
- `getStockAnalytics(orgId)` — stock status + monthly health charts

Shared CTEs (private to the service): `_ordersAggCTE`, `_invAggCTE`, `_perSkuCTE`.

**Shared SQL fragments**: [server/src/utils/skuPatterns.js](server/src/utils/skuPatterns.js)
- `effectiveSkuSql({ skuCol, shippedCol })` — canonical shipped-SKU resolution
- `wrongPartSql({ skuCol, shippedCol })` — shipped-wrong-part detection

**Shared CTE builders**: [server/src/utils/skuPivots.js](server/src/utils/skuPivots.js)
- `ordersAggCTE({ ordTable })` — orders rolled up by effective SKU
- `invAggCTE({ invTable, regexParam })` — inventory rolled up by SKU
- `perSkuCTE()` — the canonical fulfilled/phantom/remaining pivot

EVERY query that aggregates orders or inventory MUST import these
builders. The CTE SQL is defined ONCE; both the live computation
(`inventoryMetricsService`) and the materialized rebuild
(`summaryRefreshService`) consume the same source text, so the two
paths cannot drift. Repositories that need order aggregation
(`lookupRepository`, `inventoryRepository.findAlternativeBoxes`) also
use `ordersAggCTE` — no inline reimplementations.

**Undefined SKU classification** (D1 fix): the SQL classifier in
[inventoryPatterns.js](server/src/utils/inventoryPatterns.js) wraps the
SKU column in `UPPER(IFNULL(...))` before matching against the org's
compiled regex. The compiled regex uses uppercase-only character
classes (`[A-Z0-9]+`). Frontend `normalizeSku` already uppercases when
`case_insensitive: true` (default). All three paths — frontend modal
validator, SQL classifier, summary refresh — produce identical
results for a given SKU + structure.

## BigQuery tables (canonical)

Raw operational tables (DDL: [server/sql/schema/](server/sql/schema/)):
- `inventory` — one row per upload entry. UPDATE/DELETE keyed by `row_uid`.
- `orders` — one row per order line. UPDATE/DELETE keyed by `order_row_id`.
  - `shipped_sku` column accepts box-only or full-SKU overrides;
    `effectiveSkuSql()` parses intent at query time.
- `organizations`, `users`, `memberships`, `activity_log`, `inventory_uploads`,
  `order_uploads` — supporting tables.

**Known gap (see [docs/AUDIT_FOLLOWUP.md](docs/AUDIT_FOLLOWUP.md) C1)**:
`inventory` and `orders` have NO partition/cluster in canonical DDL.
Highest-impact cost optimization. Migration plan documented but not run.

## Frontend rendering layer

Frontend is a pure renderer — NO analytics computation in the browser:
- Dashboard KPIs come from `MetricsEngine.load()` → `/dashboard/kpis`.
- SKU View comes from `API.getSkuSummary()` → `/inventory/sku-summary`.
- Drilldown (raw rows behind one SKU) from `API.getRawRowsBySku(sku)`.
- Box Lookup from `/lookup` → `lookupService.search`.
- No `.reduce` / `.groupBy` for KPIs anywhere in `js/*.js`.

Frontend module reset on org switch: `App.resetAllState()` clears
`MetricsEngine` cache + every module's `.reset()` before the next render.

## Auth + session model

- JWT-only (no cookies). Access tokens carry `organization_id` + `role`;
  refresh tokens carry only `user_id` + a `jti`.
- `authenticate` middleware verifies the JWT and rejects tokens without
  org context. `requireRole('manager'|'admin')` gates mutating routes.
- Every business-data route reads `organization_id` from
  `request.user.organization_id` — never from request body/query.
- Frontend uses `sessionStorage` (per-tab), 30-min idle logout,
  BroadcastChannel for cross-tab logout sync.

**Known gap (see C2)**: refresh-token revocation is a stub. Logout
doesn't actually invalidate refresh tokens on the server.

## Caching strategy

- **Backend KPI cache** ([dashboardService.js](server/src/services/dashboardService.js)):
  per-org, in-memory, 60s TTL. `invalidateKPICache(orgId)` called from every
  mutating route (uploads, inventory edit/delete, orders edit/delete/reassign).
- **Backend SKU regex cache** ([organizationsRepository.js](server/src/repositories/organizationsRepository.js)):
  per-process, invalidated on org update.
- **Frontend `MetricsEngine`**: per-tab, invalidated on every mutating
  user action and on org switch.

**Materialized summary tables (Phase A LANDED · Phase B PENDING)**:
- `dashboard_summary`, `inventory_summary`, `box_summary_by_upc`,
  `box_summary_by_part` BQ tables exist (see
  `server/sql/migrations/20260517_002_materialized_summaries.sql` — MUST
  be run by operator before deploy). Box Lookup is split into two
  purpose-clustered tables so UPC and part-number searches both get
  ~10 KB cluster-pruned scans (Option D, see AUDIT_FOLLOWUP.md for the
  full analysis).
- `summaryRefreshService.refresh(orgId)` is the ONLY writer to those
  tables. Wired into every mutating route (uploads, inventory CRUD,
  orders CRUD, org sku_structure update). Refresh failures are
  fire-and-forget; the originating mutation never fails.
- Read paths still use live CTEs. Parity logging gates the cutover:
  set env `SUMMARY_PARITY_LOG=1` to log `dashboard_summary` vs live
  CTE on every `getKPIs` call. After 24h with zero diffs, perform
  Phase B (see [docs/AUDIT_FOLLOWUP.md](docs/AUDIT_FOLLOWUP.md)).
- After Phase B cutover the in-memory KPI cache becomes redundant and
  can be removed; reads collapse to a single row-per-org SELECT.

## Audit follow-up

Heavier items deferred from the 2026-05-17 audit have full implementation
plans in [docs/AUDIT_FOLLOWUP.md](docs/AUDIT_FOLLOWUP.md):
- **C1** — BigQuery `inventory`/`orders` partition+cluster migration
- **C2** — Refresh-token revocation table
- **Materialized summaries** — `dashboard_summary`/`inventory_summary`/`box_summary`
- **M3/M4** — Dashboard query consolidation + activity-log DML INSERT

---

# Core System Philosophy

Patman must operate as a centralized enterprise inventory and fulfillment platform with strict data consistency across all modules.

Primary priorities:

* inventory accuracy
* centralized calculations
* organization isolation
* secure session handling
* role-based permissions
* operational consistency
* maintainable architecture
* clean scalable codebase

The system should behave like a professional ERP/inventory platform, not a collection of disconnected pages.

---

# Centralized Inventory Calculation Engine

This is the MOST important architectural rule.

Never calculate inventory separately on different pages.

Instead:

1. Load inventory + orders data
2. Normalize data
3. Run all calculations through ONE centralized inventory engine/service
4. Store computed results in shared canonical state
5. Every page consumes the same processed dataset

Pages that MUST use the same source-of-truth:

* Dashboard
* Inventory List
* Orders
* Box Lookup
* Analytics
* Exports
* Reports

Future fixes should happen in ONE calculation layer only.

Never duplicate business logic across pages/components.

Accuracy is more important than instant rendering.

It is acceptable to:

* show loading overlays
* show syncing states
* process calculations before rendering

---

# Upload Architecture

Users:

* download CSV templates
* edit data in spreadsheet software
* upload back as `.txt` tab-delimited files

Reason:
`.txt` uploads support:

* better bulk ingestion
* simpler parsing
* stable large-file processing

System requirements:

* validate required fields
* normalize uploads before calculations
* reject malformed uploads safely
* support large batch processing

---

# Inventory Logic

## Physical Inventory Rules

Only actual fulfilled inventory-backed sales reduce stock.

The following MUST NOT reduce physical inventory:

* phantom units
* phantom orders
* undefined SKU orders
* unknown SKU orders

Remaining stock must NEVER go below zero because of phantom demand.

---

# Phantom Logic

Phantom units are informational analytics/warnings only.

Purpose:

* show oversold demand
* highlight attempted fulfillment beyond stock

Phantom units:

* appear in dashboard analytics
* appear in box lookup
* appear in inventory analytics

Phantom units MUST NOT:

* reduce physical stock
* create negative remaining inventory
* affect available inventory counts

Example:

Initial stock = 1
Units sold = 2
Phantom = 1

Correct:

* Actual Sold = 1
* Remaining = 0
* Phantom = 1

Incorrect:

* Remaining = -1

Never allow negative remaining caused by phantom sales.

---

# Dashboard KPI Logic

All KPIs must come from centralized calculations only.

Correct KPI formulas:

Total Units
= uploaded inventory quantity

Units Sold
= all order quantities

Actual Units Sold
= Units Sold - Phantom Units

Remaining Stock
= Total Units - Actual Units Sold

Phantom Units
= informational warning metric only

Undefined SKU Orders
= orders without valid inventory match

Undefined orders must not reduce stock.

---

# Box Lookup Logic

Users search by:

* part number
* SKU
* UPC

Results show:

* Initial
* Actual Sold
* Phantom
* Remaining

Grouped by:

* SKU
* box allocation

Remaining stock reflects REAL physical inventory only.

Phantom values are informational only.

Never reduce remaining below zero.

---

# Orders Page Logic

Orders page is a fulfillment management module.

It is NOT a phantom management page.

Do NOT:

* mark phantom orders at row level
* filter phantom rows
* assign phantom state to specific orders

Reason:
System cannot reliably determine WHICH oversold order became phantom.

Phantom logic exists ONLY at aggregated inventory analytics level.

---

# Shipped SKU Reassignment Logic

Users can reassign fulfillment SKU from Orders page.

Example:

Original ordered SKU:
ARA1-123-321

Alternative in-stock compatible SKUs:

* ARA2-123-321
* ARA3-123-321

Dropdown rules:

* show only compatible SKUs
* show only IN-STOCK SKUs
* show full SKU values
* exclude unavailable SKUs

Behavior:

Original order history remains unchanged.

Inventory deduction happens ONLY from reassigned shipped SKU.

Example:

Ordered:
ARA1-123-321

Reassigned shipped SKU:
ARA2-123-321

Correct behavior:

* deduct from ARA2-123-321
* do NOT deduct from ARA1-123-321

All related pages must instantly reflect this:

* dashboard
* inventory list
* box lookup
* exports
* analytics

Through centralized calculations only.

---

# Multi-User & Organization Management

The system supports:

* multiple organizations
* multiple users
* role-based permissions
* organization-level isolation

This architecture must be strict and secure.

---

# User Roles

## 1. Admin

Admins can:

* create organizations
* update organizations
* remove organizations
* create users
* update users
* remove users
* assign organizations
* assign user roles
* reset/change passwords
* manage uploads
* manage shipped SKU reassignment
* access all analytics
* access all reports
* manage system settings

Admins have full platform access.

---

## 2. Standard Users

Users can:

* access assigned organizations only
* upload inventory/orders
* manage shipped SKU reassignment
* use operational tools
* download reports
* access analytics

Users CANNOT:

* manage users
* manage organizations
* assign permissions
* change platform security settings

---

## 3. Viewers

Viewers are read-only users.

Viewers can:

* view dashboards
* view reports
* view analytics
* download reports

Viewers CANNOT:

* upload files
* edit shipped SKU
* modify inventory
* modify orders
* manage users
* manage organizations

---

# Organization Isolation & Security

Critical requirement:

Users must NEVER:

* access organizations not assigned to them
* inherit another user session
* view another organization's data
* cross-access protected records

Session handling must be strict.

Implement:

* proper auth isolation
* organization-scoped queries
* organization-level middleware validation
* role validation on every protected route
* secure session invalidation
* token validation
* organization permission checks

This is mandatory for every backend endpoint and frontend state load.

---

# Password & Access Management

If users need:

* password changes
* new organization access
* role changes

They must contact an admin.

Display clear notices inside profile/settings pages.

Only admins can:

* change passwords
* assign organizations
* update permissions

---

# UI & Dashboard Direction

System should resemble a professional ERP platform.

Priorities:

* compact layouts
* responsive sizing
* operational clarity
* clean analytics
* enterprise styling

Avoid:

* oversized cards
* spreadsheet-like dashboards
* duplicated KPI sections
* inconsistent spacing
* excessive scrolling

---

# Dashboard Layout Direction

Dashboard is the centralized control center.

Contains:

* KPI cards
* analytics
* reporting
* operational insights

Use:

* responsive KPI cards
* chart grids
* compact enterprise layout

Avoid:

* table-strip KPI rows
* fake cards
* oversized whitespace

Desktop should minimize scrolling.

---

# Performance & Responsiveness

Use:

* CSS grid
* minmax()
* flex layouts
* viewport-aware sizing
* internal scroll regions

Avoid:

* giant fixed heights
* excessive page scroll
* overflowing layouts

---

# Uploads Page

Upload controls should:

* remain sticky
* stay compact
* support fast operational workflows

Guide panel:

* displayed beside uploads
* compact
* scroll internally if needed

---

# Box Lookup Page

Dedicated operational page.

Requirements:

* sticky search
* empty state illustration
* proper no-results state
* responsive result layout

---

# Engineering & Maintenance Standards

Continuously audit:

* backend structure
* BigQuery schema
* API consistency
* legacy code
* unused CSS
* dead routes
* obsolete calculations

Clean old architecture aggressively after refactors.

Never allow:

* duplicate calculation paths
* outdated KPI logic
* legacy UI wrappers
* abandoned routes/components

---

# BigQuery & Backend Maintenance

Regularly validate:

* schema integrity
* organization isolation
* inventory consistency
* auth/session behavior
* permissions
* query performance

Ensure:

* migrations remain clean
* no stale columns
* no orphaned data structures
* no conflicting inventory logic

---

# Deployment & QA Rules

After every major change:

1. validate KPI consistency
2. validate inventory accuracy
3. validate organization isolation
4. validate role permissions
5. validate shipped SKU reassignment
6. validate uploads
7. validate exports
8. validate responsive layouts

Then:

* clean legacy code
* push changes to git
* redeploy backend/frontend if required
* verify production behavior

Accuracy, consistency, and maintainability are the highest priorities.
