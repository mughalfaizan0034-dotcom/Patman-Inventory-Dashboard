import { TABLES } from '../config/tables.js';

// Detect whether the user's search string looks like a UPC. UPCs are
// 8-14 digit numbers (UPC-A is 12, EAN-13 is 13, EAN-8 is 8, sometimes
// 14 for ITF-14). Anything outside that shape is treated as a part
// number. Ambiguous edge cases (e.g. "1234") fall through to the
// part-number path; if zero rows come back the caller can retry on
// the UPC path. In practice the operator's barcode scanner always
// produces a full 12-14 digit number, so the heuristic is unambiguous
// in production.
function looksLikeUpc(q) {
  return /^\d{8,14}$/.test(q);
}

/**
 * Box Lookup — operational diagnostics for finding inventory by UPC
 * or part number. Reads from materialized summary tables:
 *
 *   box_summary_by_upc   — clustered (organization_id, upc_norm)
 *   box_summary_by_part  — clustered (organization_id, part_norm)
 *
 * One narrow query per request, fully clustered. See audit follow-up
 * doc for the architecture rationale (Option D).
 *
 * Cross-table fallback: if the routed query returns no rows AND the
 * input could plausibly hit the other table (e.g. a numeric-looking
 * part number, or a non-numeric UPC variant), retry on the other
 * table. Total cost in the common case: ONE query.
 */
export function createLookupRepository({ bq, projectId }) {
  const byUpc  = `\`${projectId}.${TABLES.BOX_SUMMARY_BY_UPC}\``;
  const byPart = `\`${projectId}.${TABLES.BOX_SUMMARY_BY_PART}\``;

  async function _queryByUpc(organizationId, normalized) {
    const sql = `
      SELECT upc, part_number, box_number,
             initial_stock, fulfilled_units, phantom_units, remaining_stock
      FROM ${byUpc}
      WHERE organization_id = @organizationId
        AND upc_norm        = @q
      ORDER BY part_number, upc, remaining_stock DESC
    `;
    const [rows] = await bq.query({
      query:  sql,
      params: { organizationId, q: normalized },
    });
    return rows;
  }

  async function _queryByPart(organizationId, normalized) {
    const sql = `
      SELECT upc, part_number, box_number,
             initial_stock, fulfilled_units, phantom_units, remaining_stock
      FROM ${byPart}
      WHERE organization_id = @organizationId
        AND part_norm       = @q
      ORDER BY part_number, upc, remaining_stock DESC
    `;
    const [rows] = await bq.query({
      query:  sql,
      params: { organizationId, q: normalized },
    });
    return rows;
  }

  async function search(organizationId, query) {
    const raw = (query || '').trim();
    if (!raw) return [];
    const normalized = raw.toLowerCase();

    // Route by shape, then fall back to the other table only if the
    // first returns nothing. Two BQ queries per search only happens
    // when the routed table genuinely has no match.
    const routedFirst = looksLikeUpc(raw) ? _queryByUpc : _queryByPart;
    const routedNext  = looksLikeUpc(raw) ? _queryByPart : _queryByUpc;

    let rows = await routedFirst(organizationId, normalized);
    if (!rows.length) rows = await routedNext(organizationId, normalized);

    return rows.map(r => ({
      ...r,
      initial_stock:   Number(r.initial_stock   ?? 0),
      fulfilled_units: Number(r.fulfilled_units ?? 0),
      phantom_units:   Number(r.phantom_units   ?? 0),
      remaining_stock: Number(r.remaining_stock ?? 0),
    }));
  }

  return { search };
}
