/* ============================================================
   orders.js — Orders page: filter bar, table, pagination, bulk delete
   ============================================================ */

const Orders = (() => {
  let _page        = 1;
  let _filters     = {};
  let _total       = 0;
  let _loading     = false;
  let _platforms   = [];
  let _selectedIds = new Set();

  const COLS = ['', 'Order Date', 'SKU', 'Qty Sold', 'Shipped From Box', 'Platform'];

  /* ── Render ─────────────────────────────────────────────── */
  function _renderTable(rows, total) {
    _total = total || 0;
    const tbody = document.getElementById('orders-tbody');
    const info  = document.getElementById('orders-info');
    if (!tbody) return;

    if (!rows || !rows.length) {
      _selectedIds.clear();
      _updateDeleteBar();
      tbody.innerHTML = `<tr><td colspan="${COLS.length}" style="padding:0">${Loading.empty('🛒', 'No orders found', 'Adjust your filters or upload order data')}</td></tr>`;
      if (info) info.textContent = '';
      Pagination.render('orders-pagination', 1, 0, () => {});
      return;
    }

    tbody.innerHTML = rows.map(row => {
      const id      = row.order_row_id || '';
      const checked = _selectedIds.has(id) ? ' checked' : '';
      return `<tr data-row-id="${Utils.escapeHtml(id)}">
        <td style="width:36px;text-align:center;padding:0 4px">
          <input type="checkbox" class="order-row-cb" data-id="${Utils.escapeHtml(id)}"${checked} style="cursor:pointer">
        </td>
        <td>${Utils.escapeHtml(row.order_date || '—')}</td>
        <td style="font-weight:500">${Utils.escapeHtml(row.sku || '—')}</td>
        <td class="num"><strong>${Utils.formatNumber(row.quantity_sold)}</strong></td>
        <td>${Utils.escapeHtml(row.shipped_from_box || '—')}</td>
        <td>${_platformBadge(row.platform)}</td>
      </tr>`;
    }).join('');

    // Row checkbox events
    tbody.querySelectorAll('.order-row-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.id;
        if (cb.checked) _selectedIds.add(id);
        else            _selectedIds.delete(id);
        _syncSelectAll();
        _updateDeleteBar();
      });
    });

    _syncSelectAll();
    _updateDeleteBar();

    if (info) {
      const ps    = CONFIG.PAGE_SIZE;
      const start = ((_page - 1) * ps) + 1;
      const end   = Math.min(_page * ps, _total);
      info.textContent = `Showing ${start}–${end} of ${Utils.formatNumber(_total)} orders`;
    }

    Pagination.render('orders-pagination', _page, Math.ceil(_total / CONFIG.PAGE_SIZE), p => { _page = p; load(); });
  }

  function _syncSelectAll() {
    const allCb  = document.getElementById('orders-select-all');
    if (!allCb) return;
    const boxes  = Array.from(document.querySelectorAll('.order-row-cb'));
    const allChk = boxes.length > 0 && boxes.every(b => b.checked);
    const anyChk = boxes.some(b => b.checked);
    allCb.checked       = allChk;
    allCb.indeterminate = !allChk && anyChk;
  }

  function _updateDeleteBar() {
    const bar = document.getElementById('orders-delete-bar');
    const cnt = document.getElementById('orders-selected-count');
    if (!bar) return;
    if (_selectedIds.size > 0) {
      bar.style.display = 'flex';
      if (cnt) cnt.textContent = `${_selectedIds.size} selected`;
    } else {
      bar.style.display = 'none';
    }
  }

  function _platformBadge(platform) {
    if (!platform) return '<span style="color:var(--txt-4)">—</span>';
    const colors = { amazon: 'info', ebay: 'warning', walmart: 'primary', shopify: 'success' };
    return Utils.badgeHtml(colors[platform.toLowerCase()] || 'gray', platform);
  }

  /* ── Load ────────────────────────────────────────────────── */
  async function load() {
    if (_loading) return;
    _loading = true;

    if (_platforms.length === 0) await _loadPlatforms();

    const tbody = document.getElementById('orders-tbody');
    if (tbody) tbody.innerHTML = Loading.tableRows(COLS.length, 8);

    try {
      const data = await API.getOrders(_page, CONFIG.PAGE_SIZE, _filters);
      _renderTable(data.items || [], data.total || 0);
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
    const search     = document.getElementById('orders-search')?.value.trim();
    const platform   = document.getElementById('filter-platform')?.value;
    const dateFrom   = document.getElementById('filter-date-from')?.value;
    const dateTo     = document.getElementById('filter-date-to')?.value;

    if (search)   _filters.search     = search;
    if (platform) _filters.platform   = platform;
    if (dateFrom) _filters.start_date = dateFrom;
    if (dateTo)   _filters.end_date   = dateTo;
  }

  function _resetFilters() {
    ['orders-search', 'filter-platform', 'filter-date-from', 'filter-date-to'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    _filters = {};
    _page = 1;
    load();
  }

  /* ── Bulk delete ─────────────────────────────────────────── */
  function _confirmAndDelete({ label, payload }) {
    const modal = document.getElementById('orders-delete-modal');
    const msg   = document.getElementById('orders-delete-modal-msg');
    if (!modal) return;
    if (msg) msg.textContent = label;
    modal.style.display = 'flex';

    const confirmBtn = document.getElementById('orders-delete-confirm');
    const cancelBtn  = document.getElementById('orders-delete-cancel');

    const cleanup = () => { modal.style.display = 'none'; };

    const onConfirm = async () => {
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      cleanup();
      try {
        confirmBtn.disabled = true;
        const result = await API.deleteOrders(payload);
        _selectedIds.clear();
        Notify.success(`Deleted ${result.deleted ?? '?'} order${result.deleted !== 1 ? 's' : ''}`);
        _page = 1;
        load();
      } catch (err) {
        Notify.apiError(err);
      } finally {
        confirmBtn.disabled = false;
      }
    };

    const onCancel = () => {
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      cleanup();
    };

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click',  onCancel);
  }

  function _deleteSelected() {
    if (_selectedIds.size === 0) return;
    const ids = Array.from(_selectedIds);
    _confirmAndDelete({
      label:   `Delete ${ids.length} selected order${ids.length !== 1 ? 's' : ''}? This cannot be undone.`,
      payload: { row_ids: ids },
    });
  }

  function _deleteFiltered() {
    _collectFilters();
    const hasFilter = Object.keys(_filters).length > 0;
    if (!hasFilter) {
      Notify.warning('No filter applied', 'Apply at least one filter before using Delete Filtered.');
      return;
    }
    const parts = [];
    if (_filters.platform)   parts.push(`platform: ${_filters.platform}`);
    if (_filters.start_date) parts.push(`from: ${_filters.start_date}`);
    if (_filters.end_date)   parts.push(`to: ${_filters.end_date}`);
    if (_filters.search)     parts.push(`SKU contains: "${_filters.search}"`);
    _confirmAndDelete({
      label:   `Delete ALL orders matching [${parts.join(', ')}]? This cannot be undone.`,
      payload: {
        filters: {
          platform:   _filters.platform   || undefined,
          start_date: _filters.start_date || undefined,
          end_date:   _filters.end_date   || undefined,
          search:     _filters.search     || undefined,
        },
      },
    });
  }

  /* ── Export ──────────────────────────────────────────────── */
  function _exportCSV() {
    const tbody = document.getElementById('orders-tbody');
    if (!tbody) return;

    const dataHeaders = COLS.slice(1);
    const rows  = Array.from(tbody.querySelectorAll('tr'));
    const lines = rows.map(tr =>
      Array.from(tr.querySelectorAll('td')).slice(1)
        .map(td => `"${td.textContent.trim().replace(/"/g, '""')}"`)
        .join(',')
    );

    const csv  = [dataHeaders.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `orders-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ── Init ────────────────────────────────────────────────── */
  function init() {
    const applyBtn       = document.getElementById('orders-apply-filters');
    const resetBtn       = document.getElementById('orders-reset-filters');
    const exportBtn      = document.getElementById('orders-export');
    const searchEl       = document.getElementById('orders-search');
    const selectAll      = document.getElementById('orders-select-all');
    const deleteSelBtn   = document.getElementById('orders-delete-selected');
    const deleteFilBtn   = document.getElementById('orders-delete-filtered');

    if (applyBtn)     applyBtn.addEventListener('click', () => { _collectFilters(); _page = 1; load(); });
    if (resetBtn)     resetBtn.addEventListener('click', _resetFilters);
    if (exportBtn)    exportBtn.addEventListener('click', _exportCSV);
    if (deleteSelBtn) deleteSelBtn.addEventListener('click', _deleteSelected);
    if (deleteFilBtn) deleteFilBtn.addEventListener('click', _deleteFiltered);

    if (selectAll) {
      selectAll.addEventListener('change', () => {
        document.querySelectorAll('.order-row-cb').forEach(cb => {
          cb.checked = selectAll.checked;
          const id = cb.dataset.id;
          if (selectAll.checked) _selectedIds.add(id);
          else                   _selectedIds.delete(id);
        });
        _updateDeleteBar();
      });
    }

    if (searchEl) {
      searchEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') { _collectFilters(); _page = 1; load(); }
      });
    }
  }

  return { init, load };
})();
