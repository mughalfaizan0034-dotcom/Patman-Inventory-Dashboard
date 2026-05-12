# Patman Inventory Dashboard — Claude Implementation Guide

## Stack
- **Frontend**: GitHub Pages static site (vanilla JS, no bundler)
- **Backend**: Fastify on Cloud Run (Node.js 22 LTS)
- **Database**: BigQuery (multi-tenant, `organization_id` scopes every query)
- **Auth**: JWT — 15-min access tokens + 7-day refresh tokens; `membership_id` in every JWT

## Critical Rules (never violate)
- No SQL inside route handlers — repositories only
- No business logic in repositories — services only
- No frontend inventory calculations — BigQuery is authoritative
- No synthetic SKU generation
- No silent failures
- Phantom unit / undefined SKU / negative inventory logic is backend-only
- Every query must filter by `organization_id`

---

## Operational Inventory Model

This is the most important business logic in the system.

### Two Distinct Concepts

#### 1. Physical Inventory (warehouse reality)
Actual sellable stock. When marketplace orders exceed stock, **excess orders are cancelled/refunded and never shipped**. Phantom orders do NOT consume physical stock.

```
physical_remaining = MAX(initial_quantity - fulfilled_quantity, 0)
```

Physical stock can never go negative. A warehouse box cannot have −5 units.

#### 2. Phantom Demand (operational exception)
Orders received beyond available stock. These are not fulfilled — they are eventually cancelled. Track separately as a warning metric, not as inventory depletion.

```
phantom_units = ABS(MIN(initial_quantity - total_ordered, 0))
```

### Example

| Fact | Value |
|------|-------|
| Initial stock | 10 units |
| Orders received | 15 units |
| **Physical fulfilled** | **10 units** |
| **Physical remaining** | **0 units** |
| **Phantom demand** | **5 units** |

The system must NOT show `remaining = -5`. That is operationally false.

### Formula Summary

| KPI | Formula |
|-----|---------|
| Total Units | `SUM(initial_quantity)` |
| Fulfilled Units Sold | `MIN(available_inventory, ordered_quantity)` per SKU |
| Phantom Units | Ordered quantity exceeding available inventory |
| Physical Remaining | `Total Units - Fulfilled Units Sold` (never negative) |

### Current vs Correct

| Calculation | Current (wrong) | Correct |
|-------------|-----------------|---------|
| Remaining | `initial - total_ordered` | `MAX(initial - total_ordered, 0)` |
| Phantom | ABS of negative remaining | Orders that couldn't be fulfilled |
| Physical stock | Can go negative | Floored at 0 |

### Canonical Column Structure (enforced across all pages)

Every surface that displays inventory stock data uses the same four derived fields — never raw `units_sold` or uncapped `remaining_stock`:

| Field | Source / Formula | Display label |
|-------|-----------------|---------------|
| `initial_stock` / `quantity` | Raw from BigQuery | **Initial** |
| `fulfilled_units` | `LEAST(units_sold, quantity)` | **Actual Sold** |
| `phantom_units` | `GREATEST(units_sold - quantity, 0)` | **Phantom** |
| `remaining_stock` | `GREATEST(quantity - fulfilled_units, 0)` | **Remaining** |

These four fields are computed in BigQuery CTEs and returned by every relevant repository method. Frontend code must never calculate them independently from raw `units_sold` alone — except as a fallback when the old backend (pre-redeploy) returns neither `fulfilled_units` nor `phantom_units`, in which case the frontend derives them identically to the formulas above.

### Impact Across Pages

**Dashboard KPIs**
- "Actual Remaining" = physical stock only, never negative (`remaining_stock`)
- "Phantom Units" = unfulfillable demand, not depleted inventory (`phantom_units`)
- "Actual Sold" = fulfilled units only, capped at available stock per SKU (`fulfilled_units`)

**Inventory List** — confirmed canonical column order:
`[ checkbox | SKU | Box # | Part # | UPC | Initial Qty | Actual Sold | Phantom | Remaining | Date Added | Notes | edit ]`
- `Phantom` column in red when `> 0`, muted (`var(--txt-4)`) when `0`
- `Remaining` column in green when `> 0`, muted when `0` — never negative, never red
- Row gets `.row-phantom` class when `phantom_units > 0`

**Box Lookup** — confirmed canonical column order:
*UPC summary card:* `[ Initial | Actual Sold | Phantom | Remaining | Status pill ]`
*Box table:* `[ Box # | Initial | Actual Sold | Phantom | Remaining | Status ]`
- Status pill: **Phantom** (red) when `phantom > 0`, **In Stock** (green) when `remaining > 0`, **OOS** (orange) otherwise
- Row gets `.row-phantom` class when `phantom_units > 0`
- Box 164 with 7 units and 0 orders = 7 remaining, always

**Performance / Analytics**
- "Units Sold" chart = fulfilled units (demand capped at stock)
- Phantom demand tracked as separate exception metric
- Do not subtract phantom from physical inventory in any chart

**Exports**
- CSV columns: `SKU, Box #, Part #, UPC, Initial Qty, Actual Sold, Phantom Units, Actual Remaining, Date Added, Notes`
- All exports use `fulfilled_units` / `phantom_units`, not raw order totals

---

## Upload / Template Workflow

```
DOWNLOAD:  inventory_template.csv / orders_template.csv  (.csv)
EDIT IN:   Excel / Google Sheets / Numbers
SAVE AS:   UTF-8 tab-delimited .txt
UPLOAD:    .txt only (server validates extension and parses tab-delimited)
```

**Do NOT** convert template downloads to `.txt`. Do NOT accept `.csv` uploads. These are intentionally different.

---

## Upload Architecture
- TXT-only: UTF-8 tab-delimited `.txt` files
- Multipart via `@fastify/multipart`, streaming readline parser, 500-row batch inserts
- Max 10 MB / 100,000 rows
- Inventory uploads: full replacement (DELETE + chunked insert)
- Orders uploads: append (chunked insert)

---

## Multi-Tenant Auth
- `users`: global identity
- `organizations`: org_id, slug, display_name
- `memberships`: user_id + organization_id + role — source of truth for access
- Single-org login → direct tokens; multi-org login → pending_token + org selector UI
- `/auth/select-org`: pending_token + membership_id → scoped access token
- `/auth/switch-org`: in-app org switching with valid access token

---

## Table Schemas
**Inventory:** `sku, upc, part_number, box_number, quantity (INT), date_added, notes`
**Orders:** `order_id, order_date, sku, upc, quantity_sold (INT), platform, source_file, shipped_from_box`

---

## ARA SKU Pattern
SKUs matching `^ARA[0-9]+-.+$` use `shipped_from_box` overrides. When `shipped_from_box` is set, the effective SKU for order matching becomes:
```
CONCAT('ARA', shipped_from_box, REGEXP_EXTRACT(sku, '^ARA[0-9]+(.+)$'))
```
This is applied in every orders aggregation CTE.

---

## Box Lookup Aggregation
Boxes may have multiple rows with different SKU strings (different upload batches). The correct approach is 4-CTE SQL:
1. `inv_grouped` — SUM quantity by (box_number, part_number, upc)
2. `inv_skus` — DISTINCT all SKU strings per (box_number, part_number, upc)
3. `ord_summary` — aggregate orders with ARA override
4. `box_orders` — JOIN every SKU variant against ord_summary, SUM per box
5. Final JOIN on (box_number, part_number, upc) only — never on SKU alone

---

## Phantom Row Styling
Shared CSS class `.row-phantom` in `tables.css`:
- Background: `rgba(220, 38, 38, 0.05)` soft pink
- Hover: `rgba(220, 38, 38, 0.09)`
- No PHANTOM badge/label on rows — background alone signals the exception
- Applied identically across Inventory List, Box Lookup, and Orders pages
- **Trigger:** `phantom_units > 0` (NOT `remaining < 0` — remaining is always floored at 0)
