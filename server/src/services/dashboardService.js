const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function monthLabel(ym) {
  // ym = '2026-05'
  const [y, m] = ym.split('-');
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}

function weekLabel(dateVal) {
  if (!dateVal) return '?';
  const d = new Date(dateVal?.value ?? dateVal);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function createDashboardService({ dashboardRepo }) {
  async function getKPIs(organizationId) {
    return dashboardRepo.getKPIs(organizationId);
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
    const raw = await dashboardRepo.getInventoryAnalytics(organizationId);

    return {
      stockStatus: raw.stockStatus.map(r => ({
        status: r.status,
        count:  Number(r.count ?? 0),
      })),
      topBoxes: raw.topBoxes.map(r => ({
        box_number:      r.box_number,
        remaining_units: Number(r.remaining_units ?? 0),
        sku_count:       Number(r.sku_count       ?? 0),
      })),
      healthByMonth: raw.healthByMonth.map(r => ({
        month:    r.month,
        in_stock: Number(r.in_stock ?? 0),
        oos:      Number(r.oos      ?? 0),
        phantom:  Number(r.phantom  ?? 0),
        total:    Number(r.total    ?? 0),
      })),
      mostOversoldSkus: raw.mostOversoldSkus.map(r => ({
        sku:          r.sku,
        original_qty: Number(r.original_qty ?? 0),
        units_sold:   Number(r.units_sold   ?? 0),
        remaining:    Number(r.remaining    ?? 0),
      })),
      boxUtilization: raw.boxUtilization.map(r => ({
        box_number:  r.box_number,
        total_skus:  Number(r.total_skus  ?? 0),
        active_skus: Number(r.active_skus ?? 0),
      })),
    };
  }

  return { getKPIs, getPerformance, getInventoryAnalytics };
}
