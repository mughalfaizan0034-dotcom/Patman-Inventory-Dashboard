const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function monthLabel(ym) {
  const [y, m] = ym.split('-');
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}

function weekLabel(dateVal) {
  if (!dateVal) return '?';
  const d = new Date(dateVal?.value ?? dateVal);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// KPI cache removed (was a 5-min in-memory TTL) — it was masking fresh
// metric runs after deploys and edits. The summary query is cheap enough
// (a single BigQuery DML against per-SKU CTEs) to recompute on every
// dashboard hit. If we ever need to add caching back, do it behind a
// `?refresh` query param so refreshes are always authoritative.

export function createDashboardService({ dashboardRepo, metricsService }) {
  async function getKPIs(organizationId) {
    return metricsService.computeSummary(organizationId);
  }

  // Kept for backward compatibility — uploads / order edits still call it
  // to signal "metrics may have changed". With the cache gone it's a no-op
  // but we leave the function in place so existing call sites compile.
  function invalidateKPICache(_organizationId) { /* no-op */ }

  async function getPerformance(organizationId, weeks, platform = null) {
    const { weekly, platforms, topSkus, monthly } = await dashboardRepo.getPerformance(organizationId, weeks, platform);

    return {
      weekly: weekly.map(r => ({
        week_start:  r.week_start?.value ?? r.week_start,
        week_label:  weekLabel(r.week_start),
        units_sold:  Number(r.units_sold ?? 0),
        order_count: Number(r.orders     ?? 0),
      })),
      platforms: platforms.map(r => ({
        platform:    r.platform,
        units_sold:  Number(r.units_sold  ?? 0),
        order_count: Number(r.order_count ?? 0),
      })),
      topSkus: topSkus.map(r => ({
        sku:        r.sku,
        units_sold: Number(r.units_sold ?? 0),
      })),
      monthly: monthly.map(r => ({
        month:        r.month,
        month_label:  monthLabel(r.month),
        order_count:  Number(r.order_count ?? 0),
        units_sold:   Number(r.units_sold  ?? 0),
        top_platform: r.top_platform ?? '—',
      })),
    };
  }

  async function getInventoryAnalytics(organizationId) {
    const raw = await metricsService.getStockAnalytics(organizationId);

    return {
      stockStatus: raw.stockStatus.map(r => ({
        status: r.status,
        count:  Number(r.count ?? 0),
      })),
      healthByMonth: raw.healthByMonth.map(r => ({
        month:    r.month,
        in_stock: Number(r.in_stock ?? 0),
        oos:      Number(r.oos      ?? 0),
        phantom:  Number(r.phantom  ?? 0),
        total:    Number(r.total    ?? 0),
      })),
    };
  }

  return { getKPIs, getPerformance, getInventoryAnalytics, invalidateKPICache };
}
