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
      const id      = row.order_row_id || '';
      const checked = _selectedIds.has(id) ? ' checked' : '';
      const trStyle = isPhantom ? ' style="background:rgba(220,38,38,.06)"' : '';
      return `<tr data-row-id="${Utils.escapeHtml(id)}"
                  data-order-date="${Utils.escapeHtml(row.order_date || '')}"
                  data-sku="${Utils.escapeHtml(row.sku || '')}"
                  data-qty="${Utils.escapeHtml(String(row.quantity_sold ?? ''))}"
                  data-shipped="${Utils.escapeHtml(row.shipped_from_box || '')}"
                  data-platform="${Utils.escapeHtml(row.platform || '')}"${trStyle}>
        <td style="width:36px;text-align:center;padding:0 4px">
          <input type="checkbox" class="order-row-cb" data-id="${Utils.escapeHtml(id)}"${checked} style="cursor:pointer">
        </td>
        <td>${Utils.escapeHtml(row.order_date || '-')}</td>
        <td style="font-weight:500">${Utils.escapeHtml(row.sku || '-')}</td>
        <td class="num"><strong>${Utils.formatNumber(row.quantity_sold)}</strong></td>
        <td class="shipped-cell" style="white-space:nowrap">
          <span>${Utils.escapeHtml(row.shipped_from_box || '-')}</span><button class="btn btn-ghost btn-icon btn-sm order-edit-btn" title="Edit shipped from box" style="opacity:.45;font-size:11px;padding:0 3px;margin-left:5px;vertical-align:middle">✏️</button>
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

  /* ── Inline box selector ────────────────────────────────── */
  function _closeInlineSelector() {
    document.getElementById('inline-box-selector-row')?.remove();
    document.querySelector('tr.inline-edit-active')?.classList.remove('inline-edit-active');
  }

  async function _openInlineBoxSelector(tr) {
    const rowId      = tr.dataset.rowId;
    const sku        = tr.dataset.sku;
    const parsed     = _parseSku(sku);
    const currentBox = tr.dataset.shipped || '';

    // Toggle off if already open for this row
    const existing = document.getElementById('inline-box-selector-row');
    if (existing && existing.previousElementSibling === tr) {
      _closeInlineSelector();
      return;
    }
    _closeInlineSelector();

    tr.classList.add('inline-edit-active');

    const inlineRow = document.createElement('tr');
    inlineRow.id = 'inline-box-selector-row';
    inlineRow.innerHTML = `<td colspan="${ALL_COLS.length}" style="padding:0;border-top:none">
      <div style="padding:10px 14px;background:var(--surface-2);border-bottom:2px solid var(--primary)">
        <div style="font-size:11px;color:var(--txt-3);font-weight:700;letter-spacing:.04em;margin-bottom:8px">
          SHIPPED FROM BOX — CLICK TO AUTO-SAVE
          <button id="inline-box-close" style="float:right;background:none;border:none;cursor:pointer;color:var(--txt-4);font-size:14px;line-height:1;padding:0" title="Close">✕</button>
        </div>
        <div id="inline-box-cards" style="font-size:12px;color:var(--txt-4)">Loading alternatives…</div>
      </div>
    </td>`;
    tr.after(inlineRow);

    document.getElementById('inline-box-close')?.addEventListener('click', e => {
      e.stopPropagation();
      _closeInlineSelector();
    });

    const cardsWrap = document.getElementById('inline-box-cards');

    if (!parsed) {
      cardsWrap.innerHTML = `<span style="color:var(--txt-4)">SKU structure not recognized — cannot look up alternative boxes</span>`;
      return;
    }

    try {
      const result = await API.getInventoryAlternatives(sku);
      const { originalBox, inStock } = result || {};

      if (!inStock?.length) {
        cardsWrap.innerHTML = `<span style="color:var(--txt-4)">No alternative boxes in stock for this SKU</span>`;
        return;
      }

      const allOptions = inStock.map(a => ({
        ...a,
        isOriginal: a.box_number === originalBox,
      })).sort((a, b) => {
        if (a.isOriginal && !b.isOriginal) return -1;
        if (!a.isOriginal && b.isOriginal) return 1;
        return b.remaining_stock - a.remaining_stock;
      });

      cardsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
      cardsWrap.innerHTML = allOptions.map(opt => {
        const isSelected = opt.box_number === currentBox;
        const border = isSelected
          ? '2px solid var(--primary)'
          : (opt.isOriginal ? '2px solid #fbbf24' : '2px solid var(--border)');
        const bg = opt.isOriginal ? 'rgba(251,191,36,.08)' : '#fff';
        const shadow = isSelected ? 'box-shadow:0 0 0 3px rgba(37,99,235,.12);' : '';
        return `
          <div class="inline-box-opt" data-box="${Utils.escapeHtml(opt.box_number)}"
            style="border:${border};border-radius:8px;padding:8px 12px;cursor:pointer;background:${bg};
                   transition:border-color .15s,box-shadow .15s;min-width:130px;${shadow}">
            <div style="font-size:11px;color:var(--txt-4);font-weight:600;margin-bottom:2px">
              ${opt.isOriginal ? '📦 Original' : '📫 Alternative'}${isSelected ? ' <span style="color:var(--primary)">✓</span>' : ''}
            </div>
            <div style="font-weight:700;font-size:13px;color:var(--txt-1)">${Utils.escapeHtml(opt.box_number)}</div>
            <div style="font-size:11.5px;color:var(--txt-3);margin-top:2px">${Utils.formatNumber(opt.remaining_stock)} in stock</div>
          </div>`;
      }).join('');

      cardsWrap.querySelectorAll('.inline-box-opt').forEach(el => {
        el.addEventListener('click', async () => {
          const selectedBox = el.dataset.box;
          el.style.opacity = '0.6';
          try {
            await API.updateOrder(rowId, {
              order_date:       tr.dataset.orderDate,
              quantity_sold:    parseInt(tr.dataset.qty, 10),
              platform:         tr.dataset.platform,
              shipped_from_box: selectedBox,
            });
            const shippedCell = tr.querySelector('td.shipped-cell');
            if (shippedCell) shippedCell.firstChild.textContent = selectedBox;
            tr.dataset.shipped = selectedBox;
            Notify.success('Saved', `Shipped from box updated to ${selectedBox}`);
            _closeInlineSelector();
          } catch (err) {
            Notify.apiError(err);
            el.style.opacity = '1';
          }
        });
      });
    } catch {
      cardsWrap.innerHTML = `<span style="color:var(--txt-4)">Failed to load alternatives</span>`;
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

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') _closeInlineSelector();
    });
    document.addEventListener('click', e => {
      const sel = document.getElementById('inline-box-selector-row');
      if (!sel) return;
      const active = document.querySelector('tr.inline-edit-active');
      if (active && !active.contains(e.target) && !sel.contains(e.target)) {
        _closeInlineSelector();
      }
    });
  }

  return { init, load, clearSelection, setPhantomFilter };
})();
