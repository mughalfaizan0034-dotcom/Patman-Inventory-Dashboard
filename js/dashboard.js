/* ============================================================
   dashboard.js — KPI strip, dashboard page, performance charts
   ============================================================ */

/* ── Dashboard (Overview page) ──────────────────────────────── */
const Dashboard = (() => {

  /* Inventory row: Total SKUs | In Stock (bar) | OOS (bar) | Total Units | Remaining (bar) | Undefined SKUs */
  const INVENTORY_METRICS = [
    { id: 'dm-total-skus',   label: 'Total SKUs',    field: 'totalSkus',              navigate: 'inventory' },
    { id: 'dm-instock-skus', label: 'In Stock',      field: 'inStockSkus',            barOf: 'totalSkus',  barColor: '#16a34a', accent: 'green' },
    { id: 'dm-oos-skus',     label: 'OOS',           field: 'oosSkus',                barOf: 'totalSkus',  barColor: '#ea580c', accent: 'orange' },
    { id: 'dm-total-units',  label: 'Total Units',   field: 'totalUnits',             navigate: 'inventory' },
    { id: 'dm-remaining',    label: 'Remaining',     field: 'physicalRemainingUnits', barOf: 'totalUnits', barColor: '#16a34a', accent: 'green', navigate: 'inventory' },
    { id: 'dm-undef-inv',    label: 'Undefined SKUs',field: 'undefinedSkus',          navigate: 'inventory', action: 'undefined', warnIfPositive: true },
  ];

  /* Sales row: Total Orders | Units Sold | Actual Sold | Phantom Units | Unknown SKU Orders */
  const SALES_METRICS = [
    { id: 'dm-total-orders', label: 'Total Orders',       field: 'totalOrders',        navigate: 'orders' },
    { id: 'dm-units-sold',   label: 'Units Sold',         field: 'unitsSold',          navigate: 'orders' },
    { id: 'dm-actual-sold',  label: 'Actual Sold',        field: 'actualUnitsSold',    accent: 'teal' },
    { id: 'dm-phantom-u-s',  label: 'Phantom Units',      field: 'phantomUnits',       warnIfPositive: true },
    { id: 'dm-undef-orders', label: 'Unknown SKU Orders', field: 'undefinedSkuOrders', navigate: 'orders', action: 'unknown_orders', warnIfPositive: true },
  ];

  function _valueColor(def, val) {
    if (def.warnIfPositive && val > 0) return 'var(--error)';
    if (def.accent === 'green')  return '#16a34a';
    if (def.accent === 'orange') return '#c2410c';
    if (def.accent === 'teal')   return '#0d9488';
    return 'var(--txt-1)';
  }

  function _metricItem(def, data) {
    const val     = data[def.field] ?? null;
    const display = val != null ? Utils.formatNumber(val) : '—';
    const color   = _valueColor(def, val ?? 0);
    const nav     = def.navigate
      ? `data-navigate="${def.navigate}"${def.action ? ` data-action="${def.action}"` : ''}`
      : '';

    let barHtml = '';
    if (def.barOf) {
      const total = data[def.barOf] || 0;
      const pct   = total > 0 ? Math.min(100, Math.round((val || 0) / total * 100)) : 0;
      barHtml = `
        <div class="dash-kpi-item-bar-wrap">
          <div class="dash-kpi-item-bar" style="width:${pct}%;background:${def.barColor || 'var(--primary)'}"></div>
        </div>`;
    }

    return `
      <div class="dash-kpi-item${def.navigate ? ' clickable' : ''}" ${nav}>
        <div class="dash-kpi-item-label">${Utils.escapeHtml(def.label)}</div>
        <div class="dash-kpi-item-value" id="${def.id}" style="color:${color}">${Utils.escapeHtml(String(display))}</div>
        ${barHtml}
      </div>`;
  }

  function _skeletonItem() {
    return `
      <div class="dash-kpi-item">
        <div class="skel skel-line" style="width:72px;height:10px;margin-bottom:6px"></div>
        <div class="skel skel-line" style="width:56px;height:20px"></div>
      </div>`;
  }

  function _renderPanel(containerId, metrics, data) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const isLoading = !data;
    el.innerHTML = isLoading
      ? metrics.map(_skeletonItem).join('')
      : metrics.map(def => _metricItem(def, data)).join('');

    if (data) {
      el.querySelectorAll('.dash-kpi-item[data-navigate]').forEach(item => {
        item.addEventListener('click', () => {
          App.navigate(item.dataset.navigate);
          const action = item.dataset.action;
          if (action === 'undefined')          setTimeout(() => InventoryList.setStatusFilter?.('undefined'), 60);
          else if (action === 'unknown_orders') setTimeout(() => Orders.setStatusFilter?.('unknown'), 60);
        });
      });
    }
  }

  async function load() {
    _renderPanel('panel-inventory-intel', INVENTORY_METRICS, null);
    _renderPanel('panel-sales-intel',     SALES_METRICS,     null);
    try {
      const kpiData = await MetricsEngine.load();
      _renderPanel('panel-inventory-intel', INVENTORY_METRICS, kpiData);
      _renderPanel('panel-sales-intel',     SALES_METRICS,     kpiData);

      const lastSyncEl = document.getElementById('last-sync-time');
      if (lastSyncEl) lastSyncEl.textContent = 'Updated ' + Utils.timeAgo(new Date().toISOString());
    } catch (err) {
      const inv = document.getElementById('panel-inventory-intel');
      if (inv) inv.innerHTML = Loading.error('Failed to load dashboard data', load);
      Notify.apiError(err);
    }
  }

  return { load };
})();

/* ── Performance page ───────────────────────────────────────── */
const Perf = (() => {
  let _weeklyChart   = null;
  let _platformChart = null;
  let _weeks         = 12;
  let _platform      = '';

  const PLATFORM_COLORS = ['#2563eb','#16a34a','#d97706','#dc2626','#7c3aed','#0891b2','#db2777','#64748b'];

  async function load() {
    const container = document.getElementById('perf-container');
    if (container) Loading.section(container, true);

    try {
      const [data, platforms] = await Promise.all([
        API.getPerformanceData(_weeks, _platform),
        API.getPlatforms().catch(() => []),
      ]);

      _populatePlatformSelect(platforms);
      _renderWeeklyChart(data.weekly    || []);
      _renderPlatformChart(data.platforms || []);
      _renderMonthlyTable(data.monthly  || []);
    } catch (err) {
      Notify.apiError(err);
    } finally {
      if (container) Loading.section(container, false);
    }
  }

  function _populatePlatformSelect(platforms) {
    const sel = document.getElementById('perf-platform-select');
    if (!sel || sel.options.length > 1) return;
    platforms.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      sel.appendChild(opt);
    });
    sel.value = _platform;
  }

  function _renderWeeklyChart(weekly) {
    const canvas = document.getElementById('chart-weekly');
    if (!canvas) return;

    if (_weeklyChart) _weeklyChart.destroy();

    const labels = weekly.map(w => w.week_label || w.week_start || '');
    const sold   = weekly.map(w => w.units_sold  || 0);
    const orders = weekly.map(w => w.order_count || 0);

    _weeklyChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Units Sold',
            data: sold,
            backgroundColor: 'rgba(37,99,235,0.15)',
            borderColor: '#2563eb',
            borderWidth: 2,
            borderRadius: 4,
            yAxisID: 'y',
          },
          {
            label: 'Order Count',
            data: orders,
            type: 'line',
            borderColor: '#16a34a',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#16a34a',
            tension: 0.3,
            yAxisID: 'y1',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true } },
        scales: {
          y:  { position: 'left',  beginAtZero: true, grid: { color: 'rgba(0,0,0,.05)' }, title: { display: true, text: 'Units Sold' } },
          y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'Orders' } },
        },
      },
    });
  }

  function _renderPlatformChart(platforms) {
    const canvas   = document.getElementById('chart-platform');
    const legendEl = document.getElementById('platform-legend');
    if (!canvas) return;

    if (_platformChart) _platformChart.destroy();

    if (!platforms.length) {
      if (legendEl) legendEl.innerHTML = `<div style="color:var(--txt-4);font-size:13px;padding:12px 0">No platform data</div>`;
      return;
    }

    const total = platforms.reduce((s, p) => s + p.units_sold, 0);

    _platformChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels:   platforms.map(p => p.platform),
        datasets: [{
          data:            platforms.map(p => p.units_sold),
          backgroundColor: platforms.map((_, i) => PLATFORM_COLORS[i % PLATFORM_COLORS.length]),
          borderWidth:     3,
          borderColor:     '#fff',
          hoverOffset:     10,
        }],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const pct = total > 0 ? Math.round(ctx.parsed / total * 100) : 0;
                return ` ${Utils.formatNumber(ctx.parsed)} units (${pct}%)`;
              },
            },
          },
        },
        cutout: '68%',
      },
    });

    if (legendEl) {
      legendEl.innerHTML = platforms.map((p, i) => {
        const pct   = total > 0 ? Math.round(p.units_sold / total * 100) : 0;
        const color = PLATFORM_COLORS[i % PLATFORM_COLORS.length];
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--border)">
            <span style="display:flex;align-items:center;gap:10px">
              <span style="width:12px;height:12px;border-radius:3px;background:${color};flex-shrink:0"></span>
              <span style="font-size:14px;font-weight:500;color:var(--txt-2)">${Utils.escapeHtml(p.platform)}</span>
            </span>
            <span style="display:flex;align-items:center;gap:14px">
              <span style="font-size:12px;color:var(--txt-4);min-width:32px;text-align:right">${pct}%</span>
              <span style="font-size:15px;font-weight:700;color:var(--txt-1);min-width:64px;text-align:right">${Utils.formatNumber(p.units_sold)}</span>
            </span>
          </div>`;
      }).join('');
    }
  }

  function _renderMonthlyTable(monthly) {
    const tbody = document.getElementById('monthly-tbody');
    if (!tbody) return;
    if (!monthly.length) {
      tbody.innerHTML = `<tr><td colspan="4">${Loading.empty('calendar', 'No data')}</td></tr>`;
      return;
    }

    tbody.innerHTML = monthly.map(m => `
      <tr>
        <td>${Utils.escapeHtml(m.month_label || m.month)}</td>
        <td class="num">${Utils.formatNumber(m.order_count)}</td>
        <td class="num">${Utils.formatNumber(m.units_sold)}</td>
        <td>${Utils.escapeHtml(m.top_platform || '&mdash;')}</td>
      </tr>`).join('');
  }

  function setWeeks(w) {
    _weeks = parseInt(w) || 12;
    load();
  }

  function setPlatform(p) {
    _platform = p || '';
    load();
  }

  function init() {
    const sel     = document.getElementById('perf-weeks-select');
    const platSel = document.getElementById('perf-platform-select');
    if (sel)     sel.addEventListener('change', e => setWeeks(e.target.value));
    if (platSel) platSel.addEventListener('change', e => setPlatform(e.target.value));
  }

  return { load, init };
})();
