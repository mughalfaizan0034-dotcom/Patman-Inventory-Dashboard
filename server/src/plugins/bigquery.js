import fp from 'fastify-plugin';
import { BigQuery } from '@google-cloud/bigquery';
import { env } from '../config/env.js';

// ── Schema-version fallback ───────────────────────────────────────────────────
// Columns added in migration 001_orders_sku_resolution.sql.
// If the migration hasn't run yet, BigQuery rejects SELECT queries with
// "Unrecognized name: is_ignored". The proxy below catches that error on
// read-only queries and retries with pre-migration equivalents so the app
// stays functional. Write operations (UPDATE/INSERT) still fail until the
// migration runs — that is intentional.

const V2_COLS = ['is_ignored', 'mapped_inventory_sku', 'ignored_at', 'ignored_by', 'mapped_at', 'mapped_by'];
const V2_SCHEMA_RE = new RegExp(`Unrecognized name: (${V2_COLS.join('|')})`);

function isV2SchemaError(err) {
  const texts = [err?.message, ...(err?.errors || []).map(e => e?.message)].filter(Boolean);
  return texts.some(t => V2_SCHEMA_RE.test(t));
}

// Replaces v2-specific SQL fragments with semantically equivalent pre-migration forms.
// Old schema has no ignored/mapped orders, so:
//   COALESCE(*.is_ignored, FALSE) = FALSE  →  TRUE   (include all rows)
//   COALESCE(*.is_ignored, FALSE) = TRUE   →  FALSE  (no ignored rows)
//   COALESCE(*.mapped_inventory_sku, *.sku) → *.sku  (no remapped SKUs)
function stripV2Columns(sql) {
  return sql
    .replace(/COALESCE\(\w*\.?is_ignored,\s*FALSE\)\s*=\s*FALSE/g,       'TRUE')
    .replace(/COALESCE\(\w*\.?is_ignored,\s*FALSE\)\s*=\s*TRUE/g,        'FALSE')
    .replace(/COALESCE\(\w*\.?is_ignored,\s*FALSE\)\s+AS\s+is_ignored/g, 'FALSE AS is_ignored')
    .replace(/COALESCE\((\w+)\.mapped_inventory_sku,\s*\1\.sku\)/g,      '$1.sku')
    .replace(/COALESCE\(\w*\.?mapped_inventory_sku,\s*''\)\s*=\s*''/g,   'TRUE')
    .replace(/COALESCE\(\w*\.?mapped_inventory_sku,\s*''\)\s+AS\s+mapped_inventory_sku/g, "'' AS mapped_inventory_sku")
    .replace(/COALESCE\(\w*\.?mapped_inventory_sku,\s*''\)/g,            "''");
}

function isReadQuery(sql) {
  return /^\s*(WITH|SELECT)\b/i.test(sql ?? '');
}

async function bigqueryPlugin(fastify) {
  const rawBq = new BigQuery({ projectId: env.GCP_PROJECT_ID });

  // Wrap bq.query so all repositories transparently get the v2 fallback.
  const bq = new Proxy(rawBq, {
    get(target, prop) {
      if (prop !== 'query') {
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      }
      return async function query(opts, ...rest) {
        try {
          return await target.query(opts, ...rest);
        } catch (err) {
          if (isV2SchemaError(err) && isReadQuery(opts?.query)) {
            fastify.log.warn(
              { missingCols: V2_COLS },
              'BQ schema v2 columns missing — retrying with pre-migration fallback. ' +
              'Run migrations/001_orders_sku_resolution.sql to resolve.',
            );
            return target.query({ ...opts, query: stripV2Columns(opts.query) }, ...rest);
          }
          throw err;
        }
      };
    },
  });

  fastify.decorate('bq', bq);
  fastify.log.info({ projectId: env.GCP_PROJECT_ID }, 'BigQuery client ready');
}

export default fp(bigqueryPlugin, { name: 'bigquery' });
