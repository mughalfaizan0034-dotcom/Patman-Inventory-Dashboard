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
      const trStyle    = isPhantom ? ' class="row-phantom"' : '';
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

  /* ── Fulfillment box popover ─────────────────────────────── */
  let _activePopover    = null;
  let _popoverListeners = { outside: null, keydown: null };

  function _closeBoxPopover() {
    if (_activePopover) { _activePopover.remove(); _activePopover = null; }
    if (_popoverListeners.outside) { document.removeEventListener('mousedown', _popoverListeners.outside); _popoverListeners.outside = null; }
    if (_popoverListeners.keydown) { document.removeEventListener('keydown',   _popoverListeners.keydown);  _popoverListeners.keydown  = null; }
  }

  function _restoreShippedCell(cell, boxValue) {
    const origBox    = _parseSku(cell.closest('tr')?.dataset.sku || '')?.box || '';
    const shipped    = boxValue || '';
    const isOverride = !!(shipped && shipped !== origBox);
    cell.innerHTML   = '';

    if (isOverride) {
      const text = document.createElement('span');
      text.style.fontWeight = '500';
      text.textContent = shipped;
      const badge = document.createElement('span');
      badge.textContent = 'Override';
      badge.style.cssText = 'font-size:10px;background:#fef3c7;color:#d97706;padding:1px 5px;border-radius:3px;font-weight:600;margin-left:5px;vertical-align:middle';
      const btn = document.createElement('button');
      btn.style.cssText = 'background:none;border:none;opacity:.45;font-size:11px;padding:0 3px;margin-left:4px;cursor:pointer;vertical-align:middle';
      btn.title = 'Change fulfillment box';
      btn.textContent = '✏️';
      btn.addEventListener('click', e => { e.stopPropagation(); _openInlineBoxSelector(cell.closest('tr')); });
      text.appendChild(badge);
      cell.appendChild(text);
      cell.appendChild(btn);
    } else {
      const chip = document.createElement('span');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:#dbeafe;border:1.5px solid #93c5fd;border-radius:6px;padding:2px 9px;font-size:12px;font-weight:700;color:#1d4ed8;cursor:pointer';
      chip.title = 'Click to change fulfillment box';
      chip.textContent = origBox ? `★ ${origBox}` : '—';
      chip.addEventListener('click', e => { e.stopPropagation(); _openInlineBoxSelector(cell.closest('tr')); });
      cell.appendChild(chip);
    }
  }

  function _showBoxPopover(cell, allOptions, pendingBoxInit, onConfirm) {
    _closeBoxPopover();
    let pendingBox = pendingBoxInit;
    const orig = allOptions.find(o => o.isOriginal);
    const alts = allOptions.filter(o => !o.isOriginal);

    const pop = document.createElement('div');
    pop.style.cssText = 'position:fixed;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.13),0 2px 8px rgba(0,0,0,.07);width:272px;display:flex;flex-direction:column;z-index:10001;font-family:inherit;font-size:13px;overflow:hidden';

    const rect = cell.getBoundingClientRect();
    pop.style.top  = (rect.bottom + 6) + 'px';
    pop.style.left = Math.min(rect.left, window.innerWidth - 284) + 'px';

    function _makeOptEl(opt) {
      const isSel = opt.box_number === pendingBox;
      const el = document.createElement('div');
      el.style.cssText = [
        'display:flex;justify-content:space-between;align-items:center',
        'padding:8px 10px;border-radius:7px;cursor:pointer;margin-bottom:2px;transition:background .1s',
        opt.isOriginal
          ? (isSel ? 'background:#dbeafe;border:1.5px solid #93c5fd' : 'background:#eff6ff;border:1.5px solid #bfdbfe')
          : (isSel ? 'background:#e0e7ff;border:1.5px solid #a5b4fc' : 'background:transparent;border:1.5px solid transparent'),
      ].join(';');

      const nameEl = document.createElement('span');
      nameEl.style.cssText = opt.isOriginal ? 'font-weight:700;color:#1d4ed8'
        : isSel ? 'font-weight:600;color:#3730a3' : 'font-weight:500;color:#1e293b';
      nameEl.textContent = opt.isOriginal ? `★ Box ${opt.box_number} (Original)` : `Box ${opt.box_number}`;

      const qtyEl = document.createElement('span');
      qtyEl.style.cssText = 'font-size:12px;color:' + (opt.isOriginal ? '#3b82f6' : isSel ? '#6366f1' : '#64748b');
      qtyEl.textContent = `Qty ${opt.remaining_stock}`;

      el.appendChild(nameEl);
      el.appendChild(qtyEl);
      el.addEventListener('mouseenter', () => { if (opt.box_number !== pendingBox) el.style.background = opt.isOriginal ? '#dbeafe' : '#f8fafc'; });
      el.addEventListener('mouseleave', () => { if (opt.box_number !== pendingBox) el.style.background = opt.isOriginal ? '#eff6ff' : 'transparent'; });
      el.addEventListener('click', () => { pendingBox = opt.box_number; _render(); });
      return el;
    }

    function _render() {
      pop.innerHTML = '';

      // Original section
      const origSect = document.createElement('div');
      origSect.style.cssText = 'padding:10px 12px 8px;border-bottom:1px solid #f1f5f9';
      const origLbl = document.createElement('div');
      origLbl.style.cssText = 'font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:.07em;text-transform:uppercase;margin-bottom:6px';
      origLbl.textContent = 'Original Box';
      origSect.appendChild(origLbl);
      if (orig) origSect.appendChild(_makeOptEl(orig));
      pop.appendChild(origSect);

      // Alternatives section
      const altSect = document.createElement('div');
      altSect.style.cssText = 'padding:10px 12px 8px;overflow-y:auto;max-height:210px';
      const altLbl = document.createElement('div');
      altLbl.style.cssText = 'font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:.07em;text-transform:uppercase;margin-bottom:6px';
      altLbl.textContent = 'Alternative In-Stock Boxes';
      altSect.appendChild(altLbl);
      if (alts.length) {
        alts.forEach(a => altSect.appendChild(_makeOptEl(a)));
      } else {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#94a3b8;font-size:12px;text-align:center;padding:10px 0';
        empty.textContent = 'No alternative in-stock boxes';
        altSect.appendChild(empty);
      }
      pop.appendChild(altSect);

      // Footer
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

  async function _openInlineBoxSelector(tr) {
    const rowId      = tr.dataset.rowId;
    const sku        = tr.dataset.sku;
    const parsed     = _parseSku(sku);
    const currentBox = tr.dataset.shipped || '';
    const cell       = tr.querySelector('td.shipped-cell');
    if (!cell) return;

    // Toggle: clicking chip/button while popover is open for same row closes it
    if (_activePopover?.dataset?.rowId === rowId) { _closeBoxPopover(); return; }
    _closeBoxPopover();

    if (!parsed) { Notify.warning('Cannot edit', 'SKU format not recognized'); return; }

    // Dim cell while loading
    const trigger = cell.firstElementChild;
    if (trigger) { trigger.style.opacity = '0.5'; trigger.style.pointerEvents = 'none'; }

    try {
      const result = await API.getInventoryAlternatives(sku);
      const { originalBox, alternatives } = result || {};
      const effectiveOrigBox = originalBox || parsed.box;

      const origData   = (alternatives || []).find(a => a.box_number === effectiveOrigBox);
      const allOptions = [
        { box_number: effectiveOrigBox, remaining_stock: origData?.remaining_stock ?? 0, isOriginal: true },
        ...(alternatives || [])
          .filter(a => a.box_number !== effectiveOrigBox && a.remaining_stock > 0)
          .sort((a, b) => b.remaining_stock - a.remaining_stock)
          .map(a => ({ ...a, isOriginal: false })),
      ];

      if (trigger) { trigger.style.opacity = ''; trigger.style.pointerEvents = ''; }

      _showBoxPopover(cell, allOptions, currentBox || effectiveOrigBox, async selectedBox => {
        const isOriginalSelected = selectedBox === effectiveOrigBox;
        const newShipped = isOriginalSelected ? '' : selectedBox;
        const prevLabel  = currentBox && currentBox !== effectiveOrigBox ? currentBox : `★ ${effectiveOrigBox}`;
        const nextLabel  = isOriginalSelected ? `★ ${effectiveOrigBox} (Original)` : selectedBox;

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

      if (_activePopover) _activePopover.dataset.rowId = rowId;

    } catch {
      if (trigger) { trigger.style.opacity = ''; trigger.style.pointerEvents = ''; }
      Notify.error('Failed', 'Could not load box alternatives');
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
    try {
      const filters = { ..._filters };
      if (mode === 'daterange') {
        if (options.from) filters.start_date = options.from;
        if (options.to)   filters.end_date   = options.to;
      }
      filters.sort_by  = _sortBy;
      filters.sort_dir = _sortDir;

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
    const phantomCb    = document.getElementById('filter-phantom');
    const platSel      = document.getElementById('filter-platform');
    const dateFrom     = document.getElementById('filter-date-from');
    const dateTo       = document.getElementById('filter-date-to');

    if (resetBtn)     resetBtn.addEventListener('click',     _resetFilters);
    if (exportBtn)    exportBtn.addEventListener('click',    _openExportModal);
    if (deleteSelBtn) deleteSelBtn.addEventListener('click', _deleteSelected);
    if (phantomCb)    phantomCb.addEventListener('change',   () => { _collectFilters(); _page = 1; load(); });
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

  return { init, load, clearSelection, setPhantomFilter };
})();
