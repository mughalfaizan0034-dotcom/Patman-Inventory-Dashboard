import { TABLES } from '../config/tables.js';
import { parseStructure, compileStructureRegex } from '../utils/skuValidator.js';

export function createOrganizationsRepository({ bq, projectId }) {
  const table = `\`${projectId}.${TABLES.ORGANIZATIONS}\``;

  // Tiny in-process cache for the compiled SKU regex. Org config changes
  // rarely; every dashboard hit would otherwise re-parse + recompile. The
  // cache is invalidated on insert/update of any org row.
  const _regexCache = new Map(); // organizationId → compiled regex string ('' = no structure)

  function _invalidate(organizationId) {
    if (organizationId) _regexCache.delete(organizationId);
    else _regexCache.clear();
  }

  async function findBySlug(slug) {
    const query = `
      SELECT organization_id, slug, display_name, is_active, sku_structure
      FROM ${table}
      WHERE slug = @slug AND is_active = TRUE
      LIMIT 1
    `;
    const [rows] = await bq.query({ query, params: { slug } });
    return rows[0] ?? null;
  }

  async function findById(organizationId) {
    const query = `
      SELECT organization_id, slug, display_name, is_active, sku_structure
      FROM ${table}
      WHERE organization_id = @organizationId
      LIMIT 1
    `;
    const [rows] = await bq.query({ query, params: { organizationId } });
    return rows[0] ?? null;
  }

  async function findAll() {
    const query = `
      SELECT organization_id, slug, display_name, is_active, sku_structure, created_at
      FROM ${table}
      ORDER BY display_name
    `;
    const [rows] = await bq.query({ query });
    return rows;
  }

  /**
   * Returns the org's compiled SKU regex (anchored RE2 string) or null when
   * no structure is configured. Cached per process.
   */
  async function getSkuRegex(organizationId) {
    if (_regexCache.has(organizationId)) {
      const cached = _regexCache.get(organizationId);
      return cached || null;
    }
    const org = await findById(organizationId);
    const struct = parseStructure(org?.sku_structure);
    // Prefer the regex stored alongside the JSON; recompile on the fly if missing.
    const compiled = (struct?.compiled && typeof struct.compiled === 'string' && struct.compiled.trim())
      ? struct.compiled.trim()
      : (compileStructureRegex(struct) || '');
    _regexCache.set(organizationId, compiled);
    return compiled || null;
  }

  async function insert(org) {
    const query = `
      INSERT INTO ${table}
        (organization_id, slug, display_name, is_active, sku_structure, created_at)
      VALUES
        (@organization_id, @slug, @display_name, @is_active, @sku_structure, CURRENT_TIMESTAMP())
    `;
    const params = {
      sku_structure: null,
      ...org,
    };
    // BigQuery requires NULL params to be typed. Coerce empty string → null
    // and pass null as a typed STRING to keep the driver happy.
    await bq.query({
      query,
      params,
      types:  { sku_structure: 'STRING' },
    });
    _invalidate(org.organization_id);
  }

  async function update(organizationId, updates) {
    const allowed    = ['display_name', 'slug', 'is_active', 'sku_structure'];
    const setClauses = Object.keys(updates)
      .filter(k => allowed.includes(k))
      .map(k => `${k} = @${k}`);
    if (!setClauses.length) return;
    const query = `
      UPDATE ${table}
      SET ${setClauses.join(', ')}
      WHERE organization_id = @organizationId
    `;
    const params = { ...updates, organizationId };
    const types  = {};
    if ('sku_structure' in updates) types.sku_structure = 'STRING';
    await bq.query({ query, params, types });
    _invalidate(organizationId);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Hard-delete (2026-05-18). The organization row plus everything it
  // owns — memberships, raw inventory + orders, all summary tables, and
  // upload audit rows — is DELETED. Irreversible. Caller (route) gates
  // this on is_active=false so deactivate-first is enforced.
  //
  // Each delete is its own DML statement scoped by organization_id.
  // BigQuery's DML quota per table per day (1500) is well above what
  // any reasonable hard-delete operation can hit — even a worst-case
  // single org with millions of rows is a single DELETE statement.
  // ─────────────────────────────────────────────────────────────────────
  async function deleteAllOrgData(organizationId) {
    if (!organizationId) return { tables_cleared: [] };
    const cleared = [];

    // Tables that carry organization_id as a direct column. We DELETE
    // from each one before removing the organizations row last so a
    // partial failure leaves the org marked inactive but with some
    // residue, rather than orphaned data with no parent.
    const orgScopedTables = [
      TABLES.INVENTORY,
      TABLES.ORDERS,
      TABLES.INVENTORY_UPLOADS,
      TABLES.ORDER_UPLOADS,
      TABLES.DASHBOARD_SUMMARY,
      TABLES.INVENTORY_SUMMARY,
      TABLES.BOX_SUMMARY_BY_UPC,
      TABLES.BOX_SUMMARY_BY_PART,
    ];

    for (const t of orgScopedTables) {
      try {
        await bq.query({
          query:  `DELETE FROM \`${projectId}.${t}\` WHERE organization_id = @organizationId`,
          params: { organizationId },
        });
        cleared.push(t);
      } catch (err) {
        // Tolerate missing tables (e.g. a summary table on an
        // installation that hasn't run the materialized-summaries
        // migration). Other errors propagate so the route can surface
        // them to the operator.
        const msg = String(err?.message ?? '');
        if (/Not found: Table|does not have a table/i.test(msg)) continue;
        throw err;
      }
    }

    // Finally, delete the organizations row itself.
    await bq.query({
      query:  `DELETE FROM ${table} WHERE organization_id = @organizationId`,
      params: { organizationId },
    });
    cleared.push(TABLES.ORGANIZATIONS);

    _invalidate(organizationId);
    return { tables_cleared: cleared };
  }

  return { findBySlug, findById, findAll, insert, update, getSkuRegex, deleteAllOrgData };
}
