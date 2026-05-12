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

// In-memory KPI cache — keyed by organizationId, auto-expires after TTL.
const _kpiCache   = new Map();
const KPI_TTL_MS  = 5 * 60 * 1000; // 5 minutes

function _cacheGet(orgId) {
  const entry = _kpiCache.get(orgId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _kpiCache.delete(orgId); return null; }
  return entry.data;
}

function _cacheSet(orgId, data) {
  _kpiCache.set(orgId, { data, expiresAt: Date.now() + KPI_TTL_MS });
}

export function createDashboardService({ dashboardRepo, metricsService }) {
  async function getKPIs(organizationId) {
    const cached = _cacheGet(organizationId);
    if (cached) return cached;
    const data = await metricsService.computeSummary(organizationId);
    _cacheSet(organizationId, data);
    return data;
  }

  function invalidateKPICache(organizationId) {
    if (organizationId) _kpiCache.delete(organizationId);
    else _kpiCache.clear();
  }

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
