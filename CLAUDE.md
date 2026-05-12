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

### Impact Across Pages

**Dashboard KPIs**
- "Remaining Stock" = physical stock only, never negative
- "Phantom Units" = unfulfillable demand, not depleted inventory
- "Units Sold" = fulfilled units only (capped at available stock per SKU)

**Inventory List**
- Remaining column: `MAX(qty - sold, 0)` per row
- Phantom row highlight applies when oversold demand exists for that SKU
- Physical stock is never shown as negative

**Box Lookup**
- Always shows actual physical stock
- If phantom demand exists for a box, show a warning alongside (e.g. "⚠ 2 oversold units not fulfillable") rather than showing negative remaining
- Box 164 with 7 units and 0 orders = 7 physical remaining, always

**Performance / Analytics**
- "Units Sold" chart = fulfilled units (demand capped at stock)
- Phantom demand tracked as separate exception metric
- Do not subtract phantom from physical inventory in any chart

**Exports**
- All exports use fulfilled (capped) quantities, not raw order totals

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
