/* ============================================================
   orders.js — Orders page: filter bar, table, pagination
   ============================================================ */

const Orders = (() => {
  let _page      = 1;
  let _filters   = {};
  let _total     = 0;
  let _loading   = false;
  let _platforms = [];

  const COLS = ['Order ID', 'Date', 'SKU', 'UPC', 'Platform', 'Qty Sold', 'Shipped From', 'Status'];

  /* ── Render ─────────────────────────────────────────────── */
  function _renderTable(rows, total) {
    _total = total || 0;
    const tbody = document.getElementById('orders-tbody');
    const info  = document.getElementById('orders-info');
    if (!tbody) return;

    if (!rows || !rows.length) {
      tbody.innerHTML = `<tr><td colspan="${COLS.length}" style="padding:0">${Loading.empty('🛒', 'No orders found', 'Adjust your filters or upload order data')}</td></tr>`;
      if (info) info.textContent = '';
      Pagination.render('orders-pagination', 1, 0, () => {});
      return;
    }

    tbody.innerHTML = rows.map(row => {
      const isUndefined = !row.sku || row.sku === 'UNKNOWN';
      return `<tr class="${isUndefined ? 'row-undef' : ''}">
        <td style="font-family:monospace;font-size:12px">${Utils.escapeHtml(row.order_id || '—')}</td>
        <td>${Utils.formatDate(row.order_date)}</td>
        <td style="font-weight:500">${Utils.escapeHtml(row.sku || '—')}</td>
        <td style="font-family:monospace;font-size:12px">${Utils.escapeHtml(row.upc || '—')}</td>
        <td>${_platformBadge(row.platform)}</td>
        <td class="num"><strong>${Utils.formatNumber(row.quantity_sold)}</strong></td>
        <td>${Utils.escapeHtml(row.shipped_from_box || '—')}</td>
        <td>${isUndefined ? Utils.badgeHtml('warning', 'Undefined SKU') : Utils.badgeHtml('success', 'Matched')}</td>
      </tr>`;
    }).join('');

    if (info) {
      const ps    = CONFIG.PAGE_SIZE;
      const start = ((_page - 1) * ps) + 1;
      const end   = Math.min(_page * ps, _total);
      info.textContent = `Showing ${start}–${end} of ${Utils.formatNumber(_total)} orders`;
    }

    Pagination.render('orders-pagination', _page, Math.ceil(_total / CONFIG.PAGE_SIZE), p => { _page = p; load(); });
  }

  function _platformBadge(platform) {
    if (!platform) return '<span style="color:var(--txt-4)">—</span>';
    const colors = {
      amazon: 'info', ebay: 'warning', walmart: 'primary', shopify: 'success',
    };
    const key = platform.toLowerCase();
    const variant = colors[key] || 'gray';
    return Utils.badgeHtml(variant, platform);
  }

  /* ── Load ────────────────────────────────────────────────── */
  async function load() {
    if (_loading) return;
    _loading = true;

    // Lazy-load platforms on first visit — never before auth is confirmed
    if (_platforms.length === 0) await _loadPlatforms();

    const tbody = document.getElementById('orders-tbody');
    if (tbody) tbody.innerHTML = Loading.tableRows(COLS.length, 8);

    try {
      const data = await API.getOrders(_page, CONFIG.PAGE_SIZE, _filters);
      _renderTable(data.rows || data.orders || [], data.total || 0);
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="${COLS.length}">${Loading.error('Failed to load orders')}</td></tr>`;
      Notify.apiError(err);
    } finally {
      _loading = false;
    }
  }

  /* ── Platform select ─────────────────────────────────────── */
  async function _loadPlatforms() {
    const sel = document.getElementById('filter-platform');
    if (!sel) return;
    try {
      _platforms = await API.getPlatforms();
      const opts = _platforms.map(p => `<option value="${Utils.escapeHtml(p)}">${Utils.escapeHtml(p)}</option>`).join('');
      sel.innerHTML = `<option value="">All Platforms</option>${opts}`;
    } catch { /* not critical */ }
  }

  /* ── Filter helpers ──────────────────────────────────────── */
  function _collectFilters() {
    _filters = {};
    const platform = document.getElementById('filter-platform')?.value;
    const dateFrom = document.getElementById('filter-date-from')?.value;
    const dateTo   = document.getElementById('filter-date-to')?.value;
    const search   = document.getElementById('orders-search')?.value.trim();
    const status   = document.getElementById('filter-status')?.value;

    if (platform) _filters.platform = platform;
    if (dateFrom) _filters.dateFrom = dateFrom;
    if (dateTo)   _filters.dateTo   = dateTo;
    if (search)   _filters.search   = search;
    if (status)   _filters.status   = status;
  }

  function _resetFilters() {
    ['filter-platform','filter-date-from','filter-date-to','orders-search','filter-status'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    _filters = {};
    _page = 1;
    load();
  }

  /* ── Export ──────────────────────────────────────────────── */
  function _exportCSV() {
    const tbody = document.getElementById('orders-tbody');
    if (!tbody) return;

    const rows   = Array.from(tbody.querySelectorAll('tr'));
    const header = COLS.join(',');
    const lines  = rows.map(tr =>
      Array.from(tr.querySelectorAll('td'))
        .map(td => `"${td.textContent.trim().replace(/"/g, '""')}"`)
        .join(',')
    );

    const csv  = [header, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `orders-export-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ── Init ────────────────────────────────────────────────── */
  function init() {
    const applyBtn  = document.getElementById('orders-apply-filters');
    const resetBtn  = document.getElementById('orders-reset-filters');
    const exportBtn = document.getElementById('orders-export');
    const searchEl  = document.getElementById('orders-search');

    if (applyBtn) applyBtn.addEventListener('click', () => { _collectFilters(); _page = 1; load(); });
    if (resetBtn) resetBtn.addEventListener('click', _resetFilters);
    if (exportBtn) exportBtn.addEventListener('click', _exportCSV);

    if (searchEl) {
      searchEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') { _collectFilters(); _page = 1; load(); }
      });
    }
  }

  return { init, load };
})();
