/* ============================================================
   dashboard.js — KPI tiles, dashboard page, performance charts
   ============================================================ */

/* ── Dashboard (Overview page) ──────────────────────────────── */
const Dashboard = (() => {

  const KPI_DEFS = [
    { id: 'kpi-total-skus',        label: 'Total SKUs',           icon: '📦', color: 'blue',   field: 'totalSkus',          format: 'number', navigate: 'inventory' },
    { id: 'kpi-total-units',       label: 'Total Units',          icon: '🔢', color: 'purple', field: 'totalUnits',         format: 'number', navigate: 'inventory' },
    { id: 'kpi-units-sold',        label: 'Units Sold',           icon: '🛒', color: 'orange', field: 'unitsSold',          format: 'number', navigate: 'orders' },
    { id: 'kpi-total-orders',      label: 'Total Orders',         icon: '📋', color: 'cyan',   field: 'totalOrders',        format: 'number', navigate: 'orders' },
    { id: 'kpi-remaining-stock',   label: 'Remaining Stock',      icon: '🏭', color: 'green',  field: 'remainingStock',     format: 'number', navigate: 'inventory' },
    { id: 'kpi-phantom-units',     label: 'Phantom Units',        icon: '👻', color: 'red',    field: 'phantomUnits',       format: 'number', navigate: 'inventory', action: 'phantom' },
    { id: 'kpi-undefined-orders',  label: 'Undefined SKU Orders', icon: '❓', color: 'pink',   field: 'undefinedSkuOrders', format: 'number', navigate: 'orders' },
    { id: 'kpi-undefined-skus',    label: 'Undefined SKUs',       icon: '⚠', color: 'gray',   field: 'undefinedSkus',      format: 'number', navigate: 'inventory', action: 'undefined' },
  ];

  function _renderSkeletons() {
    const grid = document.getElementById('kpi-grid');
    if (grid) grid.innerHTML = Loading.kpiGrid(8);
  }

  function _renderKPIs(data) {
    const grid = document.getElementById('kpi-grid');
    if (!grid) return;

    grid.innerHTML = KPI_DEFS.map(def => {
      let value = data[def.field];
      let display = '—';
      let sub = '';

      if (value != null) {
        if (def.format === 'number') display = Utils.formatNumber(value);
      }

      if (def.field === 'phantomUnits' && data.phantomUnits > 0) {
        sub = 'Units sold exceeding initial stock';
      }
      if (def.field === 'undefinedSkuOrders' && data.undefinedSkuOrders > 0) {
        sub = 'Orders with no inventory record';
      }
      if (def.field === 'remainingStock' && data.remainingStock < 0) {
        sub = 'Negative — oversold';
      }
      if (def.field === 'undefinedSkus' && data.undefinedSkus > 0) {
        sub = 'Inventory rows with NA/blank values';
      }

      const clickable = def.navigate
        ? `data-navigate="${def.navigate}" ${def.action ? `data-action="${def.action}"` : ''} style="cursor:pointer"`
        : '';

      return `
        <div class="kpi-card ${def.color}" ${clickable}>
          <div class="kpi-label">${def.icon} ${Utils.escapeHtml(def.label)}</div>
          <div class="kpi-value" id="${def.id}">${Utils.escapeHtml(String(display))}</div>
          ${sub ? `<div class="kpi-sub">${Utils.escapeHtml(sub)}</div>` : ''}
        </div>`;
    }).join('');

    // Wire up click navigation
    grid.querySelectorAll('.kpi-card[data-navigate]').forEach(card => {
      card.addEventListener('click', () => {
        const target = card.dataset.navigate;
        const action = card.dataset.action;
        App.navigate(target);
        if (action === 'phantom') {
          setTimeout(() => InventoryList.setStatusFilter?.('phantom'), 60);
        } else if (action === 'undefined') {
          setTimeout(() => InventoryList.setStatusFilter?.('undefined'), 60);
        }
      });
    });
  }

  function _renderRecentActivity(items) {
    const el = document.getElementById('recent-activity-list');
    if (!el) return;

    if (!items || !items.length) { el.innerHTML = Loading.empty('📋', 'No recent activity'); return; }

    el.innerHTML = items.map(item => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:18px">${Utils.escapeHtml(item.icon || '📄')}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;color:var(--txt-1)">${Utils.escapeHtml(item.title)}</div>
          <div style="font-size:11.5px;color:var(--txt-4)">${Utils.timeAgo(item.date)}</div>
        </div>
      </div>`).join('');
  }

  async function load() {
    _renderSkeletons();
    try {
      const [kpiData, activityData] = await Promise.all([
        API.getDashboardKPIs(),
        API.getActivity().catch(() => []),
      ]);
      _renderKPIs(kpiData);
      _renderRecentActivity(activityData);

      const lastSyncEl = document.getElementById('last-sync-time');
      if (lastSyncEl) lastSyncEl.textContent = 'Updated ' + Utils.timeAgo(new Date().toISOString());
    } catch (err) {
      const grid = document.getElementById('kpi-grid');
      if (grid) grid.innerHTML = Loading.error('Failed to load dashboard data', load);
      Notify.apiError(err);
    }
  }

  return { load };
})();

/* ── Performance page ───────────────────────────────────────── */
const Perf = (() => {
  let _weeklyChart      = null;
  let _platformChart    = null;
  let _stockStatusChart = null;
  let _topBoxesChart    = null;
  let _healthMonthChart = null;
  let _boxUtilChart     = null;
  let _weeks    = 12;
  let _platform = '';

  const PLATFORM_COLORS = ['#2563eb','#16a34a','#d97706','#dc2626','#7c3aed','#0891b2','#db2777','#64748b'];

  const STATUS_COLORS = {
    'In Stock':  '#16a34a',
    'OOS':       '#ea580c',
    'Phantom':   '#dc2626',
    'Undefined': '#94a3b8',
  };
  const STATUS_ORDER = ['In Stock', 'OOS', 'Phantom', 'Undefined'];

  async function load() {
    const container = document.getElementById('perf-container');
    if (container) Loading.section(container, true);

    try {
      const [data, invData, platforms] = await Promise.all([
        API.getPerformanceData(_weeks, _platform),
        API.getInventoryAnalytics().catch(() => null),
        API.getPlatforms().catch(() => []),
      ]);

      _populatePlatformSelect(platforms);
      _renderWeeklyChart(data.weekly   || []);
      _renderPlatformChart(data.platforms || []);
      _renderMonthlyTable(data.monthly || []);

      if (invData) {
        _renderStockStatus(invData.stockStatus      || []);
        _renderTopBoxes(invData.topBoxes            || []);
        _renderHealthByMonth(invData.healthByMonth  || []);
        _renderOversoldSkus(invData.mostOversoldSkus || []);
        _renderBoxUtilization(invData.boxUtilization || []);
      }
    } catch (err) {
      Notify.apiError(err);
    } finally {
      if (container) Loading.section(container, false);
    }
  }

  function _populatePlatformSelect(platforms) {
    const sel = document.getElementById('perf-platform-select');
    if (!sel || sel.options.length > 1) return; // already populated
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
    if (!monthly.length) { tbody.innerHTML = `<tr><td colspan="4">${Loading.empty('📅', 'No data')}</td></tr>`; return; }

    tbody.innerHTML = monthly.map(m => `
      <tr>
        <td>${Utils.escapeHtml(m.month_label || m.month)}</td>
        <td class="num">${Utils.formatNumber(m.order_count)}</td>
        <td class="num">${Utils.formatNumber(m.units_sold)}</td>
        <td>${Utils.escapeHtml(m.top_platform || '—')}</td>
      </tr>`).join('');
  }

  /* ── Inventory Intelligence ─────────────────────────────────── */

  function _renderStockStatus(statusData) {
    const canvas   = document.getElementById('chart-stock-status');
    const legendEl = document.getElementById('stock-status-legend');
    if (!canvas) return;

    if (_stockStatusChart) _stockStatusChart.destroy();

    const sorted = STATUS_ORDER.map(s => statusData.find(d => d.status === s)).filter(Boolean);

    if (!sorted.length) {
      if (legendEl) legendEl.innerHTML = `<div style="color:var(--txt-4);font-size:13px">No inventory data</div>`;
      return;
    }

    _stockStatusChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels:   sorted.map(d => d.status),
        datasets: [{
          data:            sorted.map(d => d.count),
          backgroundColor: sorted.map(d => STATUS_COLORS[d.status] || '#94a3b8'),
          borderWidth:     3,
          borderColor:     '#fff',
          hoverOffset:     8,
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
                const total = sorted.reduce((s, d) => s + d.count, 0);
                const pct = total > 0 ? Math.round(ctx.parsed / total * 100) : 0;
                return ` ${Utils.formatNumber(ctx.parsed)} SKUs (${pct}%)`;
              },
            },
          },
        },
        cutout: '65%',
      },
    });

    if (legendEl) {
      const total = sorted.reduce((s, d) => s + d.count, 0);
      legendEl.innerHTML = sorted.map(d => {
        const pct   = total > 0 ? Math.round(d.count / total * 100) : 0;
        const color = STATUS_COLORS[d.status] || '#94a3b8';
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border)">
            <span style="display:flex;align-items:center;gap:9px">
              <span style="width:11px;height:11px;border-radius:3px;background:${color};flex-shrink:0"></span>
              <span style="font-size:13px;font-weight:500;color:var(--txt-2)">${d.status}</span>
            </span>
            <span style="display:flex;align-items:center;gap:12px">
              <span style="font-size:12px;color:var(--txt-4);min-width:28px;text-align:right">${pct}%</span>
              <span style="font-size:14px;font-weight:700;color:var(--txt-1);min-width:48px;text-align:right">${Utils.formatNumber(d.count)}</span>
            </span>
          </div>`;
      }).join('');
    }
  }

  function _renderTopBoxes(topBoxes) {
    const canvas = document.getElementById('chart-top-boxes');
    if (!canvas) return;
    if (_topBoxesChart) _topBoxesChart.destroy();

    if (!topBoxes.length) return;

    const labels = topBoxes.map(b => b.box_number);
    const values = topBoxes.map(b => b.remaining_units);

    _topBoxesChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label:           'Remaining Units',
          data:            values,
          backgroundColor: values.map(v => v < 0 ? 'rgba(220,38,38,.2)' : 'rgba(37,99,235,.18)'),
          borderColor:     values.map(v => v < 0 ? '#dc2626' : '#2563eb'),
          borderWidth:     1.5,
          borderRadius:    3,
        }],
      },
      options: {
        indexAxis:           'y',
        responsive:          true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, grid: { color: 'rgba(0,0,0,.04)' } },
          y: { grid: { display: false }, ticks: { font: { size: 11 } } },
        },
      },
    });
  }

  function _renderHealthByMonth(healthData) {
    const canvas = document.getElementById('chart-health-month');
    if (!canvas) return;
    if (_healthMonthChart) _healthMonthChart.destroy();

    if (!healthData.length) return;

    _healthMonthChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: healthData.map(d => d.month),
        datasets: [
          {
            label:           'In Stock',
            data:            healthData.map(d => d.in_stock),
            backgroundColor: 'rgba(22,163,74,.7)',
            stack:           's1',
            borderRadius:    0,
          },
          {
            label:           'OOS',
            data:            healthData.map(d => d.oos),
            backgroundColor: 'rgba(234,88,12,.65)',
            stack:           's1',
            borderRadius:    0,
          },
          {
            label:           'Phantom',
            data:            healthData.map(d => d.phantom),
            backgroundColor: 'rgba(220,38,38,.7)',
            stack:           's1',
            borderRadius:    0,
          },
        ],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels:   { boxWidth: 12, font: { size: 12 } },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { font: { size: 11 } } },
          y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(0,0,0,.04)' } },
        },
      },
    });
  }

  function _renderOversoldSkus(skus) {
    const tbody = document.getElementById('oversold-tbody');
    if (!tbody) return;

    if (!skus.length) {
      tbody.innerHTML = `<tr><td colspan="4">${Loading.empty('✅', 'No oversold SKUs — all stock is healthy')}</td></tr>`;
      return;
    }

    tbody.innerHTML = skus.map(s => `
      <tr>
        <td style="font-size:12px;font-weight:600;color:var(--txt-1);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${Utils.escapeHtml(s.sku)}">${Utils.escapeHtml(s.sku)}</td>
        <td class="num">${Utils.formatNumber(s.original_qty)}</td>
        <td class="num">${Utils.formatNumber(s.units_sold)}</td>
        <td class="num" style="color:var(--error);font-weight:700">${Utils.formatNumber(s.remaining)}</td>
      </tr>`).join('');
  }

  function _renderBoxUtilization(boxes) {
    const canvas = document.getElementById('chart-box-util');
    if (!canvas) return;
    if (_boxUtilChart) _boxUtilChart.destroy();

    if (!boxes.length) return;

    _boxUtilChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: boxes.map(b => b.box_number),
        datasets: [
          {
            label:           'Total SKUs',
            data:            boxes.map(b => b.total_skus),
            backgroundColor: 'rgba(37,99,235,.18)',
            borderColor:     '#2563eb',
            borderWidth:     1.5,
            borderRadius:    3,
          },
          {
            label:           'Active SKUs',
            data:            boxes.map(b => b.active_skus),
            backgroundColor: 'rgba(22,163,74,.28)',
            borderColor:     '#16a34a',
            borderWidth:     1.5,
            borderRadius:    3,
          },
        ],
      },
      options: {
        indexAxis:           'y',
        responsive:          true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels:   { boxWidth: 12, font: { size: 12 } },
          },
        },
        scales: {
          x: { beginAtZero: true, grid: { color: 'rgba(0,0,0,.04)' } },
          y: { grid: { display: false }, ticks: { font: { size: 11 } } },
        },
      },
    });
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
