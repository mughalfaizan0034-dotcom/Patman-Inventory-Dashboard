/* ============================================================
   orders.js — Orders page: filter bar, table, pagination, bulk delete, inline edit
   ============================================================ */

const Orders = (() => {
  let _page        = 1;
  let _filters     = {};
  let _total       = 0;
  let _loading     = false;
  let _platforms   = [];
  let _selectedIds = new Set();
  let _sortBy      = 'order_date';
  let _sortDir     = 'desc';

  const DATA_COLS = ['Order Date', 'SKU', 'Qty Sold', 'Shipped From Box', 'Platform'];
  const ALL_COLS  = ['', ...DATA_COLS];

  /* ── SKU parser ──────────────────────────────────────────── */
  function _parseSku(sku) {
    const m = (sku || '').match(/^ARA(\d+)-(.+)-(.+)$/);
    if (!m) return null;
    return { box: m[1], partNumber: m[2], upc: m[3] };
  }

  /* ── Platform badge ──────────────────────────────────────── */
  function _platformBadge(platform) {
    if (!platform) return '<span style="color:var(--txt-4)">-</span>';
    const colors = { amazon: 'info', ebay: 'warning', walmart: 'primary', shopify: 'success' };
    return Utils.badgeHtml(colors[platform.toLowerCase()] || 'gray', platform);
  }

  /* ── Sort headers ────────────────────────────────────────── */
  function _initSortHeaders() {
    const table = document.getElementById('orders-table');
    if (!table) return;
    table.querySelectorAll('th[data-sort]').forEach(th => {
      th.style.cursor = 'pointer';
      th.style.userSelect = 'none';
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.style.cssText = 'margin-left:4px;opacity:.3;font-size:11px';
      arrow.textContent = '↕';
      th.appendChild(arrow);
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (_sortBy === field) _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
        else { _sortBy = field; _sortDir = 'desc'; }
        _page = 1;
        _updateSortHeaders();
        load();
      });
    });
    _updateSortHeaders();
  }

  function _updateSortHeaders() {
    const table = document.getElementById('orders-table');
    if (!table) return;
    table.querySelectorAll('th[data-sort]').forEach(th => {
      const arrow = th.querySelector('.sort-arrow');
      if (!arrow) return;
      if (th.dataset.sort === _sortBy) {
        arrow.textContent = _sortDir === 'asc' ? '↑' : '↓';
        arrow.style.opacity = '1';
        arrow.style.color = 'var(--primary)';
      } else {
        arrow.textContent = '↕';
        arrow.style.opacity = '0.3';
        arrow.style.color = '';
      }
    });
  }

  /* ── Render table ────────────────────────────────────────── */
  function _renderTable(rows, total) {
    _total = total || 0;
    const tbody = document.getElementById('orders-tbody');
    const info  = document.getElementById('orders-info');
    if (!tbody) return;

    if (!rows || !rows.length) {
      _selectedIds.clear();
      _updateDeleteBtn();
      tbody.innerHTML = `<tr><td colspan="${ALL_COLS.length}" style="padding:0">${Loading.empty('🛒', 'No orders found', 'Adjust your filters or upload order data')}</td></tr>`;
      if (info) info.textContent = '';
      Pagination.render('orders-pagination', 1, 0, () => {});
      return;
    }

    const isPhantom = _filters.phantom_only;

    tbody.innerHTML = rows.map(row => {
      const id         = row.order_row_id || '';
      const checked    = _selectedIds.has(id) ? ' checked' : '';
      const trStyle    = isPhantom ? ' style="background:rgba(220,38,38,.06)"' : '';
      const parsedSku  = _parseSku(row.sku || '');
      const origBox    = parsedSku?.box || '';
      const shipped    = row.shipped_from_box || '';
      const isOverride = !!(shipped && shipped !== origBox);
      const shippedHtml = isOverride
        ? `<span style="font-weight:500">${Utils.escapeHtml(shipped)}</span><span style="font-size:10px;background:#fef3c7;color:#d97706;padding:1px 5px;border-radius:3px;font-weight:600;margin-left:5px;vertical-align:middle">Override</span><button class="order-edit-btn" style="background:none;border:none;opacity:.45;font-size:11px;padding:0 3px;margin-left:4px;cursor:pointer;vertical-align:middle" title="Change fulfillment box">✏️</button>`
        : `<span class="order-edit-btn" style="display:inline-flex;align-items:center;gap:3px;background:#dbeafe;border:1.5px solid #93c5fd;border-radius:6px;padding:2px 9px;font-size:12px;font-weight:700;color:#1d4ed8;cursor:pointer" title="Click to change fulfillment box">★ ${Utils.escapeHtml(origBox || '—')}</span>`;
      return `<tr data-row-id="${Utils.escapeHtml(id)}"
                  data-order-date="${Utils.escapeHtml(row.order_date || '')}"
                  data-sku="${Utils.escapeHtml(row.sku || '')}"
                  data-qty="${Utils.escapeHtml(String(row.quantity_sold ?? ''))}"
                  data-shipped="${Utils.escapeHtml(shipped)}"
                  data-platform="${Utils.escapeHtml(row.platform || '')}"${trStyle}>
        <td style="width:36px;text-align:center;padding:0 4px">
          <input type="checkbox" class="order-row-cb" data-id="${Utils.escapeHtml(id)}"${checked} style="cursor:pointer">
        </td>
        <td>${Utils.escapeHtml(row.order_date || '-')}</td>
        <td style="font-weight:500">${Utils.escapeHtml(row.sku || '-')}</td>
        <td class="num"><strong>${Utils.formatNumber(row.quantity_sold)}</strong></td>
        <td class="shipped-cell" style="white-space:nowrap">
          ${shippedHtml}
        </td>
        <td>${_platformBadge(row.platform)}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.order-row-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _selectedIds.add(cb.dataset.id);
        else            _selectedIds.delete(cb.dataset.id);
        _syncSelectAll();
        _updateDeleteBtn();
      });
    });

    tbody.querySelectorAll('.order-edit-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _openInlineBoxSelector(btn.closest('tr'));
      });
    });

    _syncSelectAll();
    _updateDeleteBtn();

    const ps = CONFIG.getPageSize();
    if (info) {
      const start = ((_page - 1) * ps) + 1;
      const end   = Math.min(_page * ps, _total);
      info.textContent = `Showing ${start}–${end} of ${Utils.formatNumber(_total)} orders`;
    }

    Pagination.render('orders-pagination', _page, Math.ceil(_total / ps), p => { _page = p; load(); });
  }

  /* ── Selection helpers ───────────────────────────────────── */
  function _syncSelectAll() {
    const allCb = document.getElementById('orders-select-all');
    if (!allCb) return;
    const boxes = Array.from(document.querySelectorAll('.order-row-cb'));
    const allChk = boxes.length > 0 && boxes.every(b => b.checked);
    const anyChk = boxes.some(b => b.checked);
    allCb.checked       = allChk;
    allCb.indeterminate = !allChk && anyChk;
  }

  function _updateDeleteBtn() {
    const btn = document.getElementById('orders-delete-selected');
    if (!btn) return;
    btn.disabled = _selectedIds.size === 0;
    btn.textContent = _selectedIds.size > 0
      ? `Delete (${_selectedIds.size} selected)`
      : 'Delete Selected';
  }

  function clearSelection() {
    _selectedIds.clear();
    document.querySelectorAll('.order-row-cb').forEach(cb => { cb.checked = false; });
    const allCb = document.getElementById('orders-select-all');
    if (allCb) { allCb.checked = false; allCb.indeterminate = false; }
    _updateDeleteBtn();
  }

  /* ── Inline box select (in shipped-from-box cell) ───────── */
  function _restoreShippedCell(cell, boxValue) {
    const origBox  = _parseSku(cell.closest('tr')?.dataset.sku || '')?.box || '';
    const shipped  = boxValue || '';
    const isOverride = !!(shipped && shipped !== origBox);

    cell.innerHTML = '';
    const span = document.createElement('span');

    if (isOverride) {
      span.textContent = shipped;
      const badge = document.createElement('span');
      badge.textContent = 'Override';
      badge.style.cssText = 'font-size:10px;background:#fef3c7;color:#d97706;padding:1px 5px;border-radius:3px;font-weight:600;margin-left:5px;vertical-align:middle';
      span.appendChild(badge);
    } else {
      span.textContent = origBox ? `★ ${origBox}` : '—';
      span.style.cssText = 'color:var(--primary);font-weight:600';
    }

    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-icon btn-sm order-edit-btn';
    btn.title = 'Change shipped from box';
    btn.style.cssText = 'opacity:.45;font-size:11px;padding:0 3px;margin-left:5px;vertical-align:middle';
    btn.textContent = '✏️';
    btn.addEventListener('click', e => { e.stopPropagation(); _openInlineBoxSelector(cell.closest('tr')); });
    cell.appendChild(span);
    cell.appendChild(btn);
  }

  function _showBoxSelect(cell, options, selectedBox, disabled, placeholder, onChange) {
    cell.innerHTML = '';
    const select = document.createElement('select');
    select.className = 'box-select';
    select.style.cssText = 'max-width:220px;height:28px;font-size:12px;border:1.5px solid var(--primary);border-radius:4px;background:#fff;color:var(--txt-1);padding:0 6px;cursor:' + (disabled ? 'not-allowed' : 'pointer') + ';outline:none;vertical-align:middle';
    select.disabled = disabled;

    if (!options.length) {
      const opt = document.createElement('option');
      opt.textContent = placeholder || '—';
      select.appendChild(opt);
    } else {
      options.forEach(opt => {
        const el = document.createElement('option');
        el.value = opt.box_number;
        if (opt.isOriginal) {
          el.textContent = `★ Box ${opt.box_number} (Original) • Qty ${opt.remaining_stock}`;
          el.style.backgroundColor = '#dbeafe';
          el.style.fontWeight = 'bold';
          el.style.color = '#1d4ed8';
        } else {
          el.textContent = `Box ${opt.box_number} • Qty ${opt.remaining_stock}`;
        }
        if (opt.box_number === selectedBox) el.selected = true;
        select.appendChild(el);
      });
    }

    cell.appendChild(select);

    if (!disabled && onChange) {
      select.addEventListener('change', () => onChange(select.value));
      select.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          _restoreShippedCell(cell, cell.closest('tr')?.dataset.shipped || '');
        }
      });
    }
  }

  async function _openInlineBoxSelector(tr) {
    const rowId      = tr.dataset.rowId;
    const sku        = tr.dataset.sku;
    const parsed     = _parseSku(sku);
    const currentBox = tr.dataset.shipped || '';
    const cell       = tr.querySelector('td.shipped-cell');
    if (!cell) return;

    // Toggle off if already showing
    if (cell.querySelector('select.box-select')) {
      _restoreShippedCell(cell, currentBox);
      return;
    }

    // Close any other open selects
    document.querySelectorAll('td.shipped-cell').forEach(c => {
      if (c !== cell && c.querySelector('select.box-select')) {
        _restoreShippedCell(c, c.closest('tr')?.dataset.shipped || '');
      }
    });

    if (!parsed) {
      _showBoxSelect(cell, [], '', true, 'Invalid SKU');
      return;
    }

    _showBoxSelect(cell, [], '', true, 'Loading…');

    try {
      const result = await API.getInventoryAlternatives(sku);
      const { originalBox, alternatives } = result || {};
      const effectiveOrigBox = originalBox || parsed.box;

      // Original box is ALWAYS first, even if OOS
      const origData = (alternatives || []).find(a => a.box_number === effectiveOrigBox);
      const allOptions = [
        {
          box_number:      effectiveOrigBox,
          remaining_stock: origData?.remaining_stock ?? 0,
          isOriginal:      true,
        },
        ...(alternatives || [])
          .filter(a => a.box_number !== effectiveOrigBox && a.remaining_stock > 0)
          .sort((a, b) => b.remaining_stock - a.remaining_stock)
          .map(a => ({ ...a, isOriginal: false })),
      ];

      // Pre-select: current override, or the original box if no override
      const selectedDisplay = currentBox || effectiveOrigBox;

      _showBoxSelect(cell, allOptions, selectedDisplay, false, null, async selectedBox => {
        const isOriginalSelected = selectedBox === effectiveOrigBox;
        // Save '' (empty string) to clear override back to original; backend converts '' → NULL
        const newShipped  = isOriginalSelected ? '' : selectedBox;
        const prevLabel   = currentBox && currentBox !== effectiveOrigBox ? currentBox : `★ ${effectiveOrigBox}`;
        const nextLabel   = isOriginalSelected ? `★ ${effectiveOrigBox} (Original)` : selectedBox;

        _restoreShippedCell(cell, newShipped);
        try {
          await API.updateOrder(rowId, {
            order_date:       tr.dataset.orderDate,
            quantity_sold:    parseInt(tr.dataset.qty, 10),
            platform:         tr.dataset.platform,
            shipped_from_box: newShipped,
          });
          tr.dataset.shipped = newShipped;
          Notify.success('Saved', `Fulfillment: ${prevLabel} → ${nextLabel}`);
        } catch (err) {
          Notify.apiError(err);
          _restoreShippedCell(cell, currentBox);
        }
      });
    } catch {
      _showBoxSelect(cell, [], '', true, 'Load failed');
    }
  }

  /* ── Load ────────────────────────────────────────────────── */
  async function load() {
    if (_loading) return;
    _loading = true;

    if (_platforms.length === 0) await _loadPlatforms();

    const tbody = document.getElementById('orders-tbody');
    if (tbody) tbody.innerHTML = Loading.tableRows(ALL_COLS.length, 8);

    const ps = CONFIG.getPageSize();

    try {
      const data = await API.getOrders(_page, ps, {
        ..._filters,
        sort_by:  _sortBy,
        sort_dir: _sortDir,
      });
      _renderTable(data.items || [], data.total || 0);
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="${ALL_COLS.length}">${Loading.error('Failed to load orders')}</td></tr>`;
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
    const search    = document.getElementById('orders-search')?.value.trim();
    const platform  = document.getElementById('filter-platform')?.value;
    const dateFrom  = document.getElementById('filter-date-from')?.value;
    const dateTo    = document.getElementById('filter-date-to')?.value;
    const phantomCb = document.getElementById('filter-phantom');

    if (search)   _filters.search      = search;
    if (platform) _filters.platform    = platform;
    if (dateFrom) _filters.start_date  = dateFrom;
    if (dateTo)   _filters.end_date    = dateTo;
    if (phantomCb?.checked) _filters.phantom_only = true;
  }

  function _resetFilters() {
    ['orders-search', 'filter-platform', 'filter-date-from', 'filter-date-to'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const phantomCb = document.getElementById('filter-phantom');
    if (phantomCb) phantomCb.checked = false;
    _filters = {};
    _page = 1;
    load();
  }

  /* ── Set filter programmatically (from dashboard KPI clicks) */
  function setPhantomFilter() {
    _filters = { phantom_only: true };
    _page = 1;
    const phantomCb = document.getElementById('filter-phantom');
    if (phantomCb) phantomCb.checked = true;
    load();
  }

  /* ── Bulk delete (selected rows) ─────────────────────────── */
  function _deleteSelected() {
    if (_selectedIds.size === 0) return;
    const ids = Array.from(_selectedIds);

    const modal    = document.getElementById('orders-delete-modal');
    const msg      = document.getElementById('orders-delete-modal-msg');
    const confirmB = document.getElementById('orders-delete-confirm');
    const cancelB  = document.getElementById('orders-delete-cancel');
    if (!modal) return;
    if (msg) msg.textContent = `Delete ${ids.length} selected order${ids.length !== 1 ? 's' : ''}? This cannot be undone.`;
    modal.style.display = 'flex';

    const cleanup = () => { modal.style.display = 'none'; };

    const onConfirm = async () => {
      confirmB.removeEventListener('click', onConfirm);
      cancelB.removeEventListener('click', onCancel);
      cleanup();
      try {
        confirmB.disabled = true;
        const result = await API.deleteOrders({ row_ids: ids });
        _selectedIds.clear();
        Notify.success('Deleted', `Removed ${result.deleted ?? '?'} order${result.deleted !== 1 ? 's' : ''}`);
        _page = 1;
        load();
      } catch (err) {
        Notify.apiError(err);
      } finally {
        confirmB.disabled = false;
      }
    };
    const onCancel = () => {
      confirmB.removeEventListener('click', onConfirm);
      cancelB.removeEventListener('click', onCancel);
      cleanup();
    };
    confirmB.addEventListener('click', onConfirm);
    cancelB.addEventListener('click',  onCancel);
  }

  /* ── Export modal ────────────────────────────────────────── */
  function _openExportModal() {
    const m = new Modal({
      title: 'Export Orders',
      body: `
        <div id="export-modal-content" style="display:grid;gap:10px">
          <button class="btn btn-secondary btn-sm" data-export="alltime" style="text-align:left;justify-content:flex-start">
            📥 Download All Time Orders
          </button>
          <button class="btn btn-secondary btn-sm" data-export="daterange" style="text-align:left;justify-content:flex-start">
            📅 Select Date Range…
          </button>
        </div>`,
      footer: `<button class="btn btn-ghost btn-sm" data-action="cancel">Cancel</button>`,
      maxWidth: '380px',
    });
    m.show();

    m.bodyEl.addEventListener('click', async e => {
      const btn = e.target.closest('[data-export]');
      if (!btn) return;
      const mode = btn.dataset.export;

      if (mode === 'alltime') {
        m.hide(); m.destroy();
        await _doExport('alltime');
      } else if (mode === 'daterange') {
        document.getElementById('export-modal-content').innerHTML = `
          <div style="display:grid;gap:12px">
            <div>
              <label style="font-size:12px;color:var(--txt-3);font-weight:600;display:block;margin-bottom:4px">FROM DATE</label>
              <input class="form-input" id="export-date-from" type="date">
            </div>
            <div>
              <label style="font-size:12px;color:var(--txt-3);font-weight:600;display:block;margin-bottom:4px">TO DATE</label>
              <input class="form-input" id="export-date-to" type="date">
            </div>
            <button class="btn btn-primary btn-sm" id="export-daterange-dl">Download</button>
          </div>`;
        document.getElementById('export-daterange-dl')?.addEventListener('click', async () => {
          const from = document.getElementById('export-date-from')?.value;
          const to   = document.getElementById('export-date-to')?.value;
          m.hide(); m.destroy();
          await _doExport('daterange', { from, to });
        });
      }
    });
    m.footerEl.addEventListener('click', e => {
      if (e.target.closest('[data-action="cancel"]')) { m.hide(); m.destroy(); }
    });
  }

  async function _doExport(mode, options = {}) {
    let rows;
    try {
      if (mode === 'alltime') {
        const data = await API.getOrders(1, 5000, {});
        rows = data.items || [];
      } else {
        const filters = {};
        if (options.from) filters.start_date = options.from;
        if (options.to)   filters.end_date   = options.to;
        const data = await API.getOrders(1, 5000, filters);
        rows = data.items || [];
      }
    } catch (err) {
      Notify.apiError(err);
      return;
    }

    const header = DATA_COLS.join(',');
    const lines  = rows.map(r => [
      r.order_date       || '',
      r.sku              || '',
      r.quantity_sold    ?? '',
      r.shipped_from_box || '',
      r.platform         || '',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

    const csv  = [header, ...lines].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `orders-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ── Init ────────────────────────────────────────────────── */
  function init() {
    const applyBtn     = document.getElementById('orders-apply-filters');
    const resetBtn     = document.getElementById('orders-reset-filters');
    const exportBtn    = document.getElementById('orders-export');
    const searchEl     = document.getElementById('orders-search');
    const selectAll    = document.getElementById('orders-select-all');
    const deleteSelBtn = document.getElementById('orders-delete-selected');
    const phantomCb    = document.getElementById('filter-phantom');

    if (applyBtn)     applyBtn.addEventListener('click',     () => { _collectFilters(); _page = 1; load(); });
    if (resetBtn)     resetBtn.addEventListener('click',     _resetFilters);
    if (exportBtn)    exportBtn.addEventListener('click',    _openExportModal);
    if (deleteSelBtn) deleteSelBtn.addEventListener('click', _deleteSelected);
    if (phantomCb)    phantomCb.addEventListener('change',   () => { _collectFilters(); _page = 1; load(); });

    if (selectAll) {
      selectAll.addEventListener('change', () => {
        document.querySelectorAll('.order-row-cb').forEach(cb => {
          cb.checked = selectAll.checked;
          if (selectAll.checked) _selectedIds.add(cb.dataset.id);
          else                   _selectedIds.delete(cb.dataset.id);
        });
        _updateDeleteBtn();
      });
    }

    if (searchEl) {
      searchEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') { _collectFilters(); _page = 1; load(); }
      });
    }

    _initSortHeaders();
    _updateDeleteBtn();
  }

  return { init, load, clearSelection, setPhantomFilter };
})();
