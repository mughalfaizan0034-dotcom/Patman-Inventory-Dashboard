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

  const DATA_COLS = ['Order Date', 'SKU', 'Qty Sold', 'Shipped SKU', 'Platform', ''];
  const ALL_COLS  = ['', ...DATA_COLS];

  /* ── SKU parser ──────────────────────────────────────────── */
  function _parseSku(sku) {
    const m = (sku || '').match(/^ARA(\d+)-(.+)-(.+)$/);
    if (!m) return null;
    return { box: m[1], partNumber: m[2], upc: m[3] };
  }

  function _getEffectiveSku(sku, shippedFromBox) {
    if (!sku) return '';
    const parsed = _parseSku(sku);
    if (!parsed) return sku;
    const box = shippedFromBox || parsed.box;
    return `ARA${box}-${parsed.partNumber}-${parsed.upc}`;
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

  /* ── Action menu (kebab) ─────────────────────────────────── */
  let _activeMenu = null;

  function _closeActionMenu() {
    if (_activeMenu) { _activeMenu.remove(); _activeMenu = null; }
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
      tbody.innerHTML = `<tr><td colspan="${ALL_COLS.length}" style="padding:0">${Loading.empty('shopping-cart', 'No orders found', 'Adjust your filters or upload order data')}</td></tr>`;
      if (info) info.textContent = '';
      Pagination.render('orders-pagination', 1, 0, () => {});
      return;
    }

    const statusFilter = _filters.status || 'all';

    tbody.innerHTML = rows.map(row => {
      const id        = row.order_row_id || '';
      const checked   = _selectedIds.has(id) ? ' checked' : '';
      const isUnknown = !!row.is_unknown;

      const parsedSku  = _parseSku(row.sku || '');
      const origBox    = parsedSku?.box || '';
      const effectiveShippedSku = _getEffectiveSku(row.sku || '', row.shipped_from_box || '');
      const shipped    = row.shipped_from_box || '';
      const isOverride = !!(shipped && shipped !== origBox);
      let rowClass = isUnknown ? 'row-unknown' : '';
      if (isOverride) rowClass = rowClass ? `${rowClass} row-override` : 'row-override';
      const trAttr = rowClass ? ` class="${rowClass}"` : '';
      const shippedHtml = isOverride
        ? `<span style="font-weight:500">${Utils.escapeHtml(effectiveShippedSku)}</span><span style="font-size:10px;background:#fef3c7;color:#d97706;padding:1px 5px;border-radius:3px;font-weight:600;margin-left:5px;vertical-align:middle">Override</span><button class="order-edit-btn" style="background:none;border:none;opacity:.45;padding:0 3px;margin-left:4px;cursor:pointer;vertical-align:middle;display:inline-flex;align-items:center" title="Change fulfillment SKU"><i data-lucide="pencil" class="icon" style="width:12px;height:12px"></i></button>`
        : `<span class="order-edit-btn" style="display:inline-flex;align-items:center;gap:3px;background:#dbeafe;border:1.5px solid #93c5fd;border-radius:6px;padding:2px 9px;font-size:12px;font-weight:700;color:#1d4ed8;cursor:pointer" title="Click to change fulfillment SKU">&bull; ${Utils.escapeHtml(effectiveShippedSku || '&mdash;')}</span>`;

      return `<tr data-row-id="${Utils.escapeHtml(id)}"
                data-order-date="${Utils.escapeHtml(row.order_date || '')}"
                data-sku="${Utils.escapeHtml(row.sku || '')}"
                data-qty="${Utils.escapeHtml(String(row.quantity_sold ?? ''))}"
                data-shipped="${Utils.escapeHtml(shipped)}"
                data-platform="${Utils.escapeHtml(row.platform || '')}"${trAttr}>
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
        else _selectedIds.delete(cb.dataset.id);
        _syncSelectAll();
        _updateDeleteBtn();
      });
    });

    tbody.querySelectorAll('.order-edit-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _openInlineSkuSelector(btn.closest('tr'));
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

  /* ── Fulfillment SKU popover ─────────────────────────────── */
  let _activePopover    = null;
  let _popoverListeners = { outside: null, keydown: null };

  function _closeBoxPopover() {
    if (_activePopover) { _activePopover.remove(); _activePopover = null; }
    if (_popoverListeners.outside) { document.removeEventListener('mousedown', _popoverListeners.outside); _popoverListeners.outside = null; }
    if (_popoverListeners.keydown) { document.removeEventListener('keydown',   _popoverListeners.keydown);  _popoverListeners.keydown  = null; }
  }

  function _restoreShippedCell(cell, boxValue) {
    const sku = cell.closest('tr')?.dataset.sku || '';
    const origBox    = _parseSku(sku)?.box || '';
    const shippedSku = _getEffectiveSku(sku, boxValue || '');
    const shipped    = boxValue || '';
    const isOverride = !!(shipped && shipped !== origBox);
    cell.innerHTML   = '';

    if (isOverride) {
      const text = document.createElement('span');
      text.style.fontWeight = '500';
      text.textContent = shippedSku;
      const badge = document.createElement('span');
      badge.textContent = 'Override';
      badge.style.cssText = 'font-size:10px;background:#fef3c7;color:#d97706;padding:1px 5px;border-radius:3px;font-weight:600;margin-left:5px;vertical-align:middle';
      const btn = document.createElement('button');
      btn.style.cssText = 'background:none;border:none;opacity:.45;font-size:11px;padding:0 3px;margin-left:4px;cursor:pointer;vertical-align:middle';
      btn.title = 'Change fulfillment SKU';
      btn.innerHTML = '<i data-lucide="pencil" class="icon" style="width:12px;height:12px"></i>';
      btn.addEventListener('click', e => { e.stopPropagation(); _openInlineSkuSelector(cell.closest('tr')); });
      text.appendChild(badge);
      cell.appendChild(text);
      cell.appendChild(btn);
    } else {
      const chip = document.createElement('span');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:#dbeafe;border:1.5px solid #93c5fd;border-radius:6px;padding:2px 9px;font-size:12px;font-weight:700;color:#1d4ed8;cursor:pointer';
      chip.title = 'Click to change fulfillment SKU';
      chip.textContent = shippedSku ? `• ${shippedSku}` : '—';
      chip.addEventListener('click', e => { e.stopPropagation(); _openInlineSkuSelector(cell.closest('tr')); });
      cell.appendChild(chip);
    }
  }

  function _showSkuPopover(cell, allOptions, pendingBoxInit, onConfirm) {
    _closeBoxPopover();
    let pendingBox = pendingBoxInit;
    const pop = document.createElement('div');
    pop.style.cssText = 'position:fixed;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.13),0 2px 8px rgba(0,0,0,.07);width:320px;display:flex;flex-direction:column;z-index:10001;font-family:inherit;font-size:13px;overflow:hidden';

    const rect = cell.getBoundingClientRect();
    pop.style.top  = (rect.bottom + 6) + 'px';
    pop.style.left = Math.min(rect.left, window.innerWidth - 336) + 'px';

    function _makeOptEl(opt) {
      const isSel = opt.box_number === pendingBox;
      const el = document.createElement('div');
      el.style.cssText = [
        'display:flex;justify-content:space-between;align-items:center',
        'padding:8px 10px;border-radius:7px;cursor:pointer;margin-bottom:2px;transition:background .1s',
        isSel ? 'background:#fef3d8;border:1.5px solid #fbbf24' : 'background:transparent;border:1.5px solid transparent',
      ].join(';');

      const nameEl = document.createElement('span');
      nameEl.style.cssText = opt.isOriginal ? 'font-weight:700;color:#1d4ed8' : 'font-weight:500;color:#1e293b';
      nameEl.textContent = opt.effective_sku;

      const meta = document.createElement('span');
      meta.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px';
      const qtyEl = document.createElement('span');
      qtyEl.style.cssText = 'color:' + (isSel ? '#92400e' : '#64748b');
      qtyEl.textContent = `Qty ${opt.remaining_stock}`;
      meta.appendChild(qtyEl);
      if (opt.isOriginal) {
        const badge = document.createElement('span');
        badge.textContent = 'Original';
        badge.style.cssText = 'background:#e0f2fe;color:#0369a1;padding:2px 6px;border-radius:999px;font-size:11px;font-weight:600';
        meta.appendChild(badge);
      }

      el.appendChild(nameEl);
      el.appendChild(meta);
      el.addEventListener('mouseenter', () => { if (!isSel) el.style.background = '#f8fafc'; });
      el.addEventListener('mouseleave', () => { if (!isSel) el.style.background = 'transparent'; });
      el.addEventListener('click', () => { pendingBox = opt.box_number; _render(); });
      return el;
    }

    function _render() {
      pop.innerHTML = '';

      const title = document.createElement('div');
      title.style.cssText = 'padding:12px 14px;font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #e2e8f0;background:#f8fafc';
      title.textContent = 'Select fulfillment SKU';
      pop.appendChild(title);

      const list = document.createElement('div');
      list.style.cssText = 'padding:10px 12px;overflow-y:auto;max-height:280px';
      if (allOptions.length) {
        allOptions.forEach(opt => list.appendChild(_makeOptEl(opt)));
      } else {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#94a3b8;font-size:12px;text-align:center;padding:24px 0';
        empty.textContent = 'No fulfillment SKUs found for this part or UPC';
        list.appendChild(empty);
      }
      pop.appendChild(list);

      const footer = document.createElement('div');
      footer.style.cssText = 'padding:10px 12px;border-top:1px solid #f1f5f9;display:flex;gap:8px;justify-content:flex-end;background:#f8fafc';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-secondary btn-sm';
      cancelBtn.style.fontSize = '12px';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', e => { e.stopPropagation(); _closeBoxPopover(); });
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn btn-primary btn-sm';
      confirmBtn.style.fontSize = '12px';
      confirmBtn.textContent = 'Confirm';
      confirmBtn.addEventListener('click', e => { e.stopPropagation(); _closeBoxPopover(); onConfirm(pendingBox); });
      footer.appendChild(cancelBtn);
      footer.appendChild(confirmBtn);
      pop.appendChild(footer);
    }

    _render();
    document.body.appendChild(pop);
    _activePopover = pop;

    _popoverListeners.outside = e => { if (!pop.contains(e.target) && !cell.contains(e.target)) _closeBoxPopover(); };
    setTimeout(() => document.addEventListener('mousedown', _popoverListeners.outside), 0);
    _popoverListeners.keydown = e => { if (e.key === 'Escape') { e.preventDefault(); _closeBoxPopover(); } };
    document.addEventListener('keydown', _popoverListeners.keydown);
  }

  async function _openInlineSkuSelector(tr) {
    const rowId      = tr.dataset.rowId;
    const sku        = tr.dataset.sku;
    const parsed     = _parseSku(sku);
    const currentBox = tr.dataset.shipped || '';
    const cell       = tr.querySelector('td.shipped-cell');
    if (!cell) return;

    if (_activePopover?.dataset?.rowId === rowId) { _closeBoxPopover(); return; }
    _closeBoxPopover();

    if (!parsed) { Notify.warning('Cannot edit', 'SKU format not recognized'); return; }

    const trigger = cell.firstElementChild;
    if (trigger) { trigger.style.opacity = '0.5'; trigger.style.pointerEvents = 'none'; }

    try {
      const result = await API.getInventoryAlternatives(sku);
      const { originalBox, originalSku, alternatives } = result || {};
      const effectiveOrigBox = originalBox || parsed.box;
      const effectiveOrigSku = originalSku || _getEffectiveSku(sku, effectiveOrigBox);

      const origData   = (alternatives || []).find(a => a.box_number === effectiveOrigBox);
      const allOptions = [
        { box_number: effectiveOrigBox, effective_sku: effectiveOrigSku, remaining_stock: origData?.remaining_stock ?? 0, isOriginal: true },
        ...(alternatives || [])
          .filter(a => a.box_number !== effectiveOrigBox && a.remaining_stock > 0)
          .sort((a, b) => b.remaining_stock - a.remaining_stock)
          .map(a => ({ ...a, isOriginal: false })),
      ];

      if (trigger) { trigger.style.opacity = ''; trigger.style.pointerEvents = ''; }

      _showSkuPopover(cell, allOptions, currentBox || effectiveOrigBox, async selectedBox => {
        const isOriginalSelected = selectedBox === effectiveOrigBox;
        const newShipped = isOriginalSelected ? '' : selectedBox;
        const prevLabel  = currentBox && currentBox !== effectiveOrigBox ? _getEffectiveSku(sku, currentBox) : `• ${_getEffectiveSku(sku, effectiveOrigBox)}`;
        const nextLabel  = isOriginalSelected ? `• ${_getEffectiveSku(sku, effectiveOrigBox)} (Original)` : _getEffectiveSku(sku, selectedBox);

        _restoreShippedCell(cell, newShipped);
        try {
          await API.updateOrder(rowId, {
            order_date:       tr.dataset.orderDate,
            quantity_sold:    parseInt(tr.dataset.qty, 10),
            platform:         tr.dataset.platform,
            shipped_from_box: newShipped,
          });
          tr.dataset.shipped = newShipped;
          Notify.success('Saved', `Fulfillment SKU: ${prevLabel} → ${nextLabel}`);
        } catch (err) {
          Notify.apiError(err);
          _restoreShippedCell(cell, currentBox);
        }
      });

      if (_activePopover) _activePopover.dataset.rowId = rowId;

    } catch {
      if (trigger) { trigger.style.opacity = ''; trigger.style.pointerEvents = ''; }
      Notify.error('Failed', 'Could not load fulfillment SKU alternatives');
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
    const statusSel = document.getElementById('filter-order-status');

    if (search)   _filters.search     = search;
    if (platform) _filters.platform   = platform;
    if (dateFrom) _filters.start_date = dateFrom;
    if (dateTo)   _filters.end_date   = dateTo;
    const status = statusSel?.value || 'all';
    if (status !== 'all') _filters.status = status;
  }

  function _resetFilters() {
    ['orders-search', 'filter-platform', 'filter-date-from', 'filter-date-to'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const statusSel = document.getElementById('filter-order-status');
    if (statusSel) statusSel.value = 'all';
    _filters = {};
    _page = 1;
    load();
  }

  /* ── Set filter programmatically (from dashboard KPI clicks) */
  function setStatusFilter(status) {
    _filters = {};
    if (status && status !== 'all') _filters.status = status;
    _page = 1;
    const statusSel = document.getElementById('filter-order-status');
    if (statusSel) statusSel.value = status || 'all';
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

  /* ── Export — exports exactly what is currently filtered/visible ── */
  async function _doExport() {
    try {
      const filters = { ..._filters, sort_by: _sortBy, sort_dir: _sortDir };
      const blob = await API.exportOrders(filters);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `orders-export-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      Notify.apiError(err);
    }
  }

  /* ── Init ────────────────────────────────────────────────── */
  function init() {
    const resetBtn     = document.getElementById('orders-reset-filters');
    const exportBtn    = document.getElementById('orders-export');
    const searchEl     = document.getElementById('orders-search');
    const selectAll    = document.getElementById('orders-select-all');
    const deleteSelBtn = document.getElementById('orders-delete-selected');
    const statusSel    = document.getElementById('filter-order-status');
    const platSel      = document.getElementById('filter-platform');
    const dateFrom     = document.getElementById('filter-date-from');
    const dateTo       = document.getElementById('filter-date-to');

    if (resetBtn)     resetBtn.addEventListener('click',     _resetFilters);
    if (exportBtn)    exportBtn.addEventListener('click',    _doExport);
    if (deleteSelBtn) deleteSelBtn.addEventListener('click', _deleteSelected);
    if (statusSel)    statusSel.addEventListener('change',   () => { _collectFilters(); _page = 1; load(); });
    if (platSel)      platSel.addEventListener('change',     () => { _collectFilters(); _page = 1; load(); });
    if (dateFrom)     dateFrom.addEventListener('change',    () => { _collectFilters(); _page = 1; load(); });
    if (dateTo)       dateTo.addEventListener('change',      () => { _collectFilters(); _page = 1; load(); });

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
      let _debounce;
      searchEl.addEventListener('input', () => {
        clearTimeout(_debounce);
        _debounce = setTimeout(() => { _collectFilters(); _page = 1; load(); }, 300);
      });
      searchEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(_debounce); _collectFilters(); _page = 1; load(); }
      });
    }

    _initSortHeaders();
    _updateDeleteBtn();
  }

  return { init, load, clearSelection, setStatusFilter };
})();
