/* ============================================================
   dashboard.js — Dashboard: KPI cards + analytics charts
   ============================================================ */

const Dashboard = (() => {

  /* ── KPI metric definitions ──────────────────────────────── */
  const INVENTORY_METRICS = [
    { id: 'dm-total-skus',   label: 'Total SKUs',     field: 'totalSkus',              navigate: 'inventory' },
    { id: 'dm-instock-skus', label: 'In Stock',       field: 'inStockSkus',            barOf: 'totalSkus',  barColor: '#16a34a', accent: 'green' },
    { id: 'dm-oos-skus',     label: 'OOS',            field: 'oosSkus',                barOf: 'totalSkus',  barColor: '#ea580c', accent: 'orange' },
    { id: 'dm-total-units',  label: 'Total Units',    field: 'totalUnits',             navigate: 'inventory' },
    { id: 'dm-remaining',    label: 'Remaining',      field: 'physicalRemainingUnits', barOf: 'totalUnits', barColor: '#16a34a', accent: 'green', navigate: 'inventory' },
    { id: 'dm-undef-inv',    label: 'Undefined SKUs', field: 'undefinedSkus',          navigate: 'inventory', action: 'undefined', warnIfPositive: true },
  ];

  const SALES_METRICS = [
    { id: 'dm-total-orders', label: 'Total Orders',       field: 'totalOrders',        navigate: 'orders' },
    { id: 'dm-units-sold',   label: 'Units Sold',         field: 'unitsSold',          navigate: 'orders' },
    { id: 'dm-actual-sold',  label: 'Actual Sold',        field: 'actualUnitsSold',    accent: 'teal' },
    { id: 'dm-phantom-u-s',  label: 'Phantom Units',      field: 'phantomUnits',       warnIfPositive: true },
    { id: 'dm-undef-orders', label: 'Unknown SKU Orders', field: 'undefinedSkuOrders', navigate: 'orders', action: 'unknown_orders', warnIfPositive: true },
  ];

  /* ── Chart + filter state ────────────────────────────────── */
  let _weeklyChart   = null;
  let _platformChart = null;
  let _mode          = 'wow'; // 'wow' | 'mom'
  let _weeks         = 12;
  let _months        = 6;
  let _platform      = '';

  const PLATFORM_COLORS = ['#2563eb','#16a34a','#d97706','#dc2626','#7c3aed','#0891b2','#db2777','#64748b'];

  const WOW_RANGES = [
    { value: 4,  label: 'Last 4 weeks'  },
    { value: 8,  label: 'Last 8 weeks'  },
    { value: 12, label: 'Last 12 weeks' },
    { value: 24, label: 'Last 24 weeks' },
    { value: 52, label: 'Last 52 weeks' },
  ];
  const MOM_RANGES = [
    { value: 2,  label: 'Last 2 months'  },
    { value: 4,  label: 'Last 4 months'  },
    { value: 6,  label: 'Last 6 months'  },
    { value: 12, label: 'Last 12 months' },
  ];

  function _weeksParam() {
    return _mode === 'wow' ? _weeks : Math.round(_months * 4.33);
  }

  function _updateRangeSelect() {
    const sel = document.getElementById('dash-range-select');
    if (!sel) return;
    const ranges  = _mode === 'wow' ? WOW_RANGES : MOM_RANGES;
    const current = _mode === 'wow' ? _weeks : _months;
    sel.innerHTML = ranges.map(r =>
      `<option value="${r.value}"${r.value === current ? ' selected' : ''}>${Utils.escapeHtml(r.label)}</option>`
    ).join('');
  }

  /* ── KPI rendering ───────────────────────────────────────── */
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
        <div class="skel skel-line" style="width:56px;height:22px"></div>
      </div>`;
  }

  function _renderPanel(containerId, metrics, data) {
    const el = document.getElementById(containerId);
    if (!el) return;

    el.innerHTML = !data
      ? metrics.map(_skeletonItem).join('')
      : metrics.map(def => _metricItem(def, data)).join('');

    if (data) {
      el.querySelectorAll('.dash-kpi-item[data-navigate]').forEach(item => {
        item.addEventListener('click', () => {
          App.navigate(item.dataset.navigate);
          const action = item.dataset.action;
          if (action === 'undefined')           setTimeout(() => InventoryList.setStatusFilter?.('undefined'), 60);
          else if (action === 'unknown_orders') setTimeout(() => Orders.setStatusFilter?.('unknown'), 60);
        });
      });
    }
  }

  /* ── Chart rendering ─────────────────────────────────────── */
  function _populatePlatformSelect(platforms) {
    const sel = document.getElementById('dash-platform-select');
    if (!sel || sel.options.length > 1) return;
    platforms.forEach(p => {
      const opt = document.createElement('option');
      opt.value       = p;
      opt.textContent = p;
      sel.appendChild(opt);
    });
    sel.value = _platform;
  }

  function _renderTrendChart(data) {
    const canvas = document.getElementById('chart-weekly');
    if (!canvas) return;
    if (_weeklyChart) _weeklyChart.destroy();

    let labels, sold, orders;
    if (_mode === 'wow') {
      const weekly = data.weekly || [];
      labels = weekly.map(w => w.week_label || w.week_start || '');
      sold   = weekly.map(w => w.units_sold  || 0);
      orders = weekly.map(w => w.order_count || 0);
    } else {
      const monthly = [...(data.monthly || [])].slice(0, _months).reverse();
      labels = monthly.map(m => m.month_label || m.month || '');
      sold   = monthly.map(m => m.units_sold  || 0);
      orders = monthly.map(m => m.order_count || 0);
    }

    const titleEl = document.getElementById('chart-trend-title');
    if (titleEl) titleEl.textContent = _mode === 'wow' ? 'Weekly Sales' : 'Monthly Sales';

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
          y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false },   title: { display: true, text: 'Orders' } },
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
      if (legendEl) legendEl.innerHTML = '<div style="color:var(--txt-4);font-size:13px;padding:12px 0">No platform data</div>';
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
          <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border)">
            <span style="display:flex;align-items:center;gap:8px">
              <span style="width:10px;height:10px;border-radius:2px;background:${color};flex-shrink:0"></span>
              <span style="font-size:13px;font-weight:500;color:var(--txt-2)">${Utils.escapeHtml(p.platform)}</span>
            </span>
            <span style="display:flex;align-items:center;gap:12px">
              <span style="font-size:12px;color:var(--txt-4);min-width:28px;text-align:right">${pct}%</span>
              <span style="font-size:14px;font-weight:700;color:var(--txt-1);min-width:56px;text-align:right">${Utils.formatNumber(p.units_sold)}</span>
            </span>
          </div>`;
      }).join('');
    }
  }

  /* ── Data loaders ────────────────────────────────────────── */
  async function _loadKPIs() {
    _renderPanel('panel-inventory-intel', INVENTORY_METRICS, null);
    _renderPanel('panel-sales-intel',     SALES_METRICS,     null);
    try {
      const kpiData = await MetricsEngine.load();
      _renderPanel('panel-inventory-intel', INVENTORY_METRICS, kpiData);
      _renderPanel('panel-sales-intel',     SALES_METRICS,     kpiData);
      const el = document.getElementById('last-sync-time');
      if (el) el.textContent = 'Updated ' + Utils.timeAgo(new Date().toISOString());
    } catch (err) {
      const el = document.getElementById('panel-inventory-intel');
      if (el) el.innerHTML = Loading.error('Failed to load KPI data', load);
      Notify.apiError(err);
    }
  }

  function _showChartSkeletons() {
    const trendWrap = document.getElementById('chart-weekly')?.closest('.chart-wrap');
    const platBody  = document.getElementById('chart-platform')?.closest('.dash-platform-body');
    if (trendWrap) trendWrap.innerHTML = `<div class="skel skel-rect" style="width:100%;min-height:220px;border-radius:6px;display:block"></div>`;
    if (platBody)  platBody.innerHTML  = `<div class="skel skel-rect" style="width:100%;min-height:220px;border-radius:6px;display:block"></div>`;
  }

  function _restoreChartContainers() {
    const trendWrap = document.querySelector('.chart-wrap');
    const platBody  = document.querySelector('.dash-platform-body');
    if (trendWrap && !document.getElementById('chart-weekly')) {
      trendWrap.innerHTML = '<canvas id="chart-weekly"></canvas>';
    }
    if (platBody && !document.getElementById('chart-platform')) {
      platBody.innerHTML = `
        <div class="dash-platform-doughnut"><canvas id="chart-platform"></canvas></div>
        <div id="platform-legend" class="dash-platform-legend"></div>`;
    }
  }

  async function _loadCharts() {
    _showChartSkeletons();
    try {
      const [data, platforms] = await Promise.all([
        API.getPerformanceData(_weeksParam(), _platform),
        API.getPlatforms().catch(() => []),
      ]);
      _restoreChartContainers();
      _populatePlatformSelect(platforms);
      _renderTrendChart(data);
      _renderPlatformChart(data.platforms || []);
    } catch (err) {
      _restoreChartContainers();
      Notify.apiError(err);
    }
  }

  async function load() {
    await Promise.all([_loadKPIs(), _loadCharts()]);
  }

  function init() {
    const platSel  = document.getElementById('dash-platform-select');
    const rangeSel = document.getElementById('dash-range-select');
    const modeWow  = document.getElementById('dash-mode-wow');
    const modeMom  = document.getElementById('dash-mode-mom');

    _updateRangeSelect();

    if (platSel) platSel.addEventListener('change', e => {
      _platform = e.target.value || '';
      _loadCharts();
    });

    if (rangeSel) rangeSel.addEventListener('change', e => {
      const v = parseInt(e.target.value) || 12;
      if (_mode === 'wow') _weeks = v; else _months = v;
      _loadCharts();
    });

    if (modeWow) modeWow.addEventListener('click', () => {
      if (_mode === 'wow') return;
      _mode = 'wow';
      modeWow.classList.add('active');
      modeMom.classList.remove('active');
      _updateRangeSelect();
      _loadCharts();
    });

    if (modeMom) modeMom.addEventListener('click', () => {
      if (_mode === 'mom') return;
      _mode = 'mom';
      modeMom.classList.add('active');
      modeWow.classList.remove('active');
      _updateRangeSelect();
      _loadCharts();
    });
  }

  return { load, init };
})();
