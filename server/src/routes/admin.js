import { authenticate, requireRole } from '../middleware/authenticate.js';
import { TABLES } from '../config/tables.js';

// Admin-only operational diagnostics.
//
// Routes here are NOT for normal app use — they exist for production
// debugging and Phase A/B rollout observability. Every route is gated
// by requireRole('admin') and operates within the caller's active org
// unless explicitly cross-org (and even then, returns no row-level data).
export async function adminRoutes(fastify, { bq, projectId, summaryRefreshService }) {
  const dashboardSummary = `\`${projectId}.${TABLES.DASHBOARD_SUMMARY}\``;
  const inventorySummary = `\`${projectId}.${TABLES.INVENTORY_SUMMARY}\``;
  const boxSummaryByUpc  = `\`${projectId}.${TABLES.BOX_SUMMARY_BY_UPC}\``;
  const boxSummaryByPart = `\`${projectId}.${TABLES.BOX_SUMMARY_BY_PART}\``;

  // GET /admin/summary-status?org=<orgId>
  // Returns per-table row count + most-recent refreshed_at for the
  // specified org (defaults to the requester's active org). Use this
  // to confirm summary state before flipping read paths during Phase B
  // cutover, and to diagnose stale or missing summaries.
  fastify.get('/summary-status', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const orgId = request.query.org || request.user.organization_id;
    if (!orgId) return reply.code(400).send({ success: false, error: 'org is required' });

    // Each row: { table, row_count, last_refreshed_at }
    const tables = [
      { name: 'dashboard_summary',    ref: dashboardSummary  },
      { name: 'inventory_summary',    ref: inventorySummary  },
      { name: 'box_summary_by_upc',   ref: boxSummaryByUpc   },
      { name: 'box_summary_by_part',  ref: boxSummaryByPart  },
    ];

    const results = await Promise.all(tables.map(async ({ name, ref }) => {
      try {
        const [rows] = await bq.query({
          query: `
            SELECT
              COUNT(*) AS row_count,
              MAX(refreshed_at) AS last_refreshed_at
            FROM ${ref}
            WHERE organization_id = @organizationId
          `,
          params: { organizationId: orgId },
        });
        const r = rows[0] ?? {};
        return {
          table:             name,
          row_count:         Number(r.row_count ?? 0),
          last_refreshed_at: r.last_refreshed_at?.value ?? r.last_refreshed_at ?? null,
          status:            'ok',
        };
      } catch (err) {
        return {
          table:             name,
          row_count:         null,
          last_refreshed_at: null,
          status:            'error',
          err:               err?.message ?? String(err),
        };
      }
    }));

    return reply.send({ success: true, data: { organization_id: orgId, tables: results } });
  });

  // POST /admin/summary-refresh
  // Force a summary rebuild for the specified org (or the caller's active
  // org). Useful for orgs that haven't had a mutating operation since the
  // migration ran and therefore have no summary rows yet. Fire-and-forget
  // semantics: returns immediately; rebuild runs in the background.
  fastify.post('/summary-refresh', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const orgId = request.body?.organization_id || request.user.organization_id;
    if (!orgId) return reply.code(400).send({ success: false, error: 'organization_id is required' });
    summaryRefreshService?.refresh(orgId).catch(() => {});
    return reply.send({ success: true, data: { organization_id: orgId, scheduled: true } });
  });
}
