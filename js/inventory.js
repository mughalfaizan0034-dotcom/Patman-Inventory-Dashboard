/* ============================================================
   inventory.js — Box Lookup page + Inventory List page
   ============================================================ */

const BoxLookup = (() => {
  let _lastData  = null;
  let _activeTab = 'instock';

  /* ── Status pill ─────────────────────────────────────────── */
  function _statusPill(rem, large = false) {
    const pad = large ? '4px 14px' : '2px 9px';
    const fs  = large ? '12.5px'   : '11.5px';
    if (rem > 0)
      return `<span style="display:inline-flex;align-items:center;padding:${pad};border-radius:9999px;font-size:${fs};font-weight:600;background:rgba(22,163,74,.12);color:#15803d;white-space:nowrap">In Stock</span>`;
    if (rem === 0)
      return `<span style="display:inline-flex;align-items:center;padding:${pad};border-radius:9999px;font-size:${fs};font-weight:600;background:rgba(234,88,12,.1);color:#c2410c;white-space:nowrap">OOS</span>`;
    return `<span style="display:inline-flex;align-items:center;padding:${pad};border-radius:9999px;font-size:${fs};font-weight:600;background:rgba(220,38,38,.1);color:#dc2626;white-space:nowrap">Phantom</span>`;
  }

  /* ── Remaining colour ────────────────────────────────────── */
  function _remColor(rem) {
    return rem > 0 ? '#15803d' : rem === 0 ? 'var(--txt-4)' : '#dc2626';
  }

  /* ── UPC totals card ─────────────────────────────────────── */
  function _upcSummaryCard(upc, totalInitial, totalSold, totalRemaining) {
    const rem = Number(totalRemaining);
    return `
      <div style="margin-bottom:14px">
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px">
          <span style="font-size:10.5px;font-weight:700;color:var(--txt-4);letter-spacing:.08em;text-transform:uppercase">UPC</span>
          <span style="font-size:14px;font-weight:700;color:var(--txt-1);font-family:'Courier New',monospace;letter-spacing:.04em">${Utils.escapeHtml(upc || '—')}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <div style="padding:12px 16px;border-right:1px solid var(--border)">
            <div style="font-size:10.5px;font-weight:600;color:var(--txt-4);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Initial</div>
            <div style="font-size:22px;font-weight:700;color:var(--txt-2);line-height:1">${Utils.formatNumber(totalInitial)}</div>
          </div>
          <div style="padding:12px 16px;border-right:1px solid var(--border)">
            <div style="font-size:10.5px;font-weight:600;color:var(--txt-4);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Sold</div>
            <div style="font-size:22px;font-weight:700;color:var(--txt-2);line-height:1">${Utils.formatNumber(totalSold)}</div>
          </div>
          <div style="padding:12px 16px;border-right:1px solid var(--border)">
            <div style="font-size:10.5px;font-weight:600;color:var(--txt-4);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Remaining</div>
            <div style="font-size:22px;font-weight:700;color:${_remColor(rem)};line-height:1">${Utils.formatNumber(rem)}</div>
          </div>
          <div style="padding:12px 16px;display:flex;align-items:center;justify-content:center;min-width:90px">
            ${_statusPill(rem, true)}
          </div>
        </div>
      </div>`;
  }

  /* ── Box-level table row ─────────────────────────────────── */
  function _boxRow(box) {
    const rem      = Number(box.remaining_stock ?? 0);
    const rowBg    = rem < 0 ? 'background:rgba(220,38,38,.035)' : rem === 0 ? 'background:rgba(0,0,0,.02)' : '';
    return `
      <tr style="${rowBg}">
        <td style="font-weight:600;color:var(--txt-1)">${Utils.escapeHtml(box.box_number || '—')}</td>
        <td class="num">${Utils.formatNumber(box.initial_stock)}</td>
        <td class="num">${Utils.formatNumber(box.units_sold)}</td>
        <td class="num" style="font-weight:600;color:${_remColor(rem)}">${Utils.formatNumber(rem)}</td>
        <td>${_statusPill(rem)}</td>
      </tr>`;
  }

  /* ── Merge boxes with same (box_number, part_number, upc) ── */
  function _mergeByBox(boxes) {
    const map = new Map();
    for (const b of (boxes || [])) {
      const key = `${b.box_number}|${b.part_number}|${b.upc}`;
      if (map.has(key)) {
        const m = map.get(key);
        m.initial_stock  += Number(b.initial_stock  ?? 0);
        m.units_sold     += Number(b.units_sold      ?? 0);
        m.remaining_stock = m.initial_stock - m.units_sold;
      } else {
        map.set(key, { ...b,
          initial_stock:   Number(b.initial_stock   ?? 0),
          units_sold:      Number(b.units_sold       ?? 0),
          remaining_stock: Number(b.remaining_stock  ?? 0),
        });
      }
    }
    return Array.from(map.values());
  }

  /* ── Render one UPC block (summary card + box table) ─────── */
  function _renderUpcBlock(upcLabel, totalInitial, totalSold, totalRemaining, visibleBoxes) {
    return `
      <div>
        ${_upcSummaryCard(upcLabel, totalInitial, totalSold, totalRemaining)}
        <div class="table-wrap" style="border:none;margin:0">
          <table class="data-table">
            <thead>
              <tr>
                <th>Box #</th>
                <th class="num">Initial</th>
                <th class="num">Sold</th>
                <th class="num">Remaining</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>${visibleBoxes.map(b => _boxRow(b)).join('')}</tbody>
          </table>
        </div>
      </div>`;
  }

  /* ── Build section HTML for one part-number or UPC group ─── */
  function _renderGroup(group, tab) {
    const isInstockTab = tab === 'instock';
    const sectionHtml  = [];

    for (const section of group) {
      const subSections = section.upcs || section.part_numbers || [];

      const headerLabel = section.part_number != null
        ? section.part_number
        : section.upc != null ? section.upc : '—';
      const headerType = section.part_number != null ? 'Part Number' : 'UPC';

      const upcBlocks = [];

      for (const sub of subSections) {
        const allBoxes       = _mergeByBox(sub.boxes);
        const totalInitial   = allBoxes.reduce((s, b) => s + Number(b.initial_stock   ?? 0), 0);
        const totalSold      = allBoxes.reduce((s, b) => s + Number(b.units_sold       ?? 0), 0);
        const totalRemaining = allBoxes.reduce((s, b) => s + Number(b.remaining_stock  ?? 0), 0);

        // In Stock tab: show UPC if ANY individual box has remaining > 0
        const hasAnyInStock = allBoxes.some(b => Number(b.remaining_stock ?? 0) > 0);
        if (isInstockTab && !hasAnyInStock) continue;

        const visibleBoxes = isInstockTab
          ? allBoxes.filter(b => Number(b.remaining_stock ?? 0) > 0)
          : allBoxes;

        if (!visibleBoxes.length) continue;

        const upcLabel = sub.upc ?? sub.part_number ?? '—';
        upcBlocks.push(_renderUpcBlock(upcLabel, totalInitial, totalSold, totalRemaining, visibleBoxes));
      }

      if (!upcBlocks.length) continue;

      // Separate multiple UPC blocks with a subtle divider
      const blocksHtml = upcBlocks.join(`
        <div style="border-top:1px solid var(--border);margin:20px 0"></div>`);

      sectionHtml.push(`
        <div class="card" style="margin-bottom:16px;padding:0;overflow:hidden">
          <div style="background:var(--surface-2);padding:10px 20px;border-bottom:1px solid var(--border)">
            <div style="font-size:10.5px;font-weight:700;color:var(--txt-4);letter-spacing:.08em;text-transform:uppercase;margin-bottom:2px">${headerType}</div>
            <div style="font-size:17px;font-weight:700;color:var(--txt-1);letter-spacing:.01em">${Utils.escapeHtml(headerLabel)}</div>
          </div>
          <div style="padding:18px 20px 20px">
            ${blocksHtml}
          </div>
        </div>`);
    }

    return sectionHtml.join('');
  }

  /* ── Render results into a tab panel ─────────────────────── */
  function _renderResults(data, tab) {
    const group = data.byPartNumber?.length ? data.byPartNumber : data.byUpc || [];
    const html  = _renderGroup(group, tab);
    const el    = tab === 'instock'
      ? document.getElementById('lookup-instock')
      : document.getElementById('lookup-all');
    if (!el) return;
    el.innerHTML = html || Loading.empty(
      '📦',
      tab === 'instock' ? 'No in-stock inventory found' : 'No inventory found',
      'Try a different Part Number or UPC'
    );
  }

  function _showResults(data) {
    _lastData = data;
    const hasResults = (data.byPartNumber?.length || data.byUpc?.length);

    const tabsEl = document.getElementById('lookup-tabs');
    if (tabsEl) tabsEl.style.display = hasResults ? 'block' : 'none';

    _renderResults(data, 'instock');
    _renderResults(data, 'all');

    const inStockEl = document.getElementById('lookup-instock');
    const allEl     = document.getElementById('lookup-all');
    if (inStockEl) inStockEl.style.display = _activeTab === 'instock' ? '' : 'none';
    if (allEl)     allEl.style.display     = _activeTab === 'all'     ? '' : 'none';

    _updateTabUI();
  }

  function _updateTabUI() {
    document.querySelectorAll('.lookup-tab').forEach(btn => {
      const isActive = btn.dataset.tab === _activeTab;
      btn.style.color        = isActive ? 'var(--primary)' : 'var(--txt-3)';
      btn.style.fontWeight   = isActive ? '600' : '500';
      btn.style.borderBottom = isActive ? '2px solid var(--primary)' : '2px solid transparent';
    });
  }

  async function search(query) {
    query = (query || '').trim();
    const clearBtn  = document.getElementById('box-clear-btn');
    const inStockEl = document.getElementById('lookup-instock');
    const allEl     = document.getElementById('lookup-all');
    const tabsEl    = document.getElementById('lookup-tabs');

    if (!query) {
      if (inStockEl) inStockEl.innerHTML = '';
      if (allEl)     allEl.innerHTML     = '';
      if (tabsEl)    tabsEl.style.display = 'none';
      if (clearBtn)  clearBtn.style.display = 'none';
      return;
    }
    if (clearBtn) clearBtn.style.display = '';

    if (inStockEl) inStockEl.innerHTML = `<div style="display:flex;justify-content:center;padding:40px">${Loading.spinnerHtml()}</div>`;
    if (allEl)     allEl.innerHTML     = '';
    if (tabsEl)    tabsEl.style.display = 'none';

    try {
      const data = await API.lookup(query);
      _showResults(data);
    } catch (err) {
      if (inStockEl) inStockEl.innerHTML = Loading.error('Search failed. Please try again.');
      Notify.apiError(err);
    }
  }

  function init() {
    const input    = document.getElementById('box-search-input');
    const clearBtn = document.getElementById('box-clear-btn');
    const tabsEl   = document.getElementById('lookup-tabs');
    if (!input) return;

    let _debounce;
    input.addEventListener('input', () => {
      clearTimeout(_debounce);
      _debounce = setTimeout(() => search(input.value), 300);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(_debounce); search(input.value); }
    });
    if (clearBtn) clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.style.display = 'none';
      search('');
    });

    if (tabsEl) {
      tabsEl.addEventListener('click', e => {
        const tab = e.target.closest('.lookup-tab')?.dataset.tab;
        if (!tab || tab === _activeTab) return;
        _activeTab = tab;
        _updateTabUI();
        const is  = document.getElementById('lookup-instock');
        const all = document.getElementById('lookup-all');
        if (is)  is.style.display  = tab === 'instock' ? '' : 'none';
        if (all) all.style.display = tab === 'all'     ? '' : 'none';
        if (_lastData) _renderResults(_lastData, tab);
      });
    }
  }

  return { init, search };
})();

/* ── Inventory List page ────────────────────────────────────── */
const InventoryList = (() => {
  let _page          = 1;
  let _search        = '';
  let _total         = 0;
  let _loading       = false;
  let _selectedSkus  = new Set();
  let _sortBy        = 'date_added';
  let _sortDir       = 'desc';
  let _statusFilter  = 'all';

  const COLS = ['', 'SKU', 'Box #', 'Part #', 'UPC', 'Qty', 'Sold', 'Remaining', 'Date Added', 'Notes', ''];

  /* ── Undefined SKU check ─────────────────────────────────── */
  function _isUndefined(val) {
    const v = (val || '').trim().toUpperCase();
    return v === '' || v === 'NA' || v === 'N/A';
  }

  /* ── Sort headers ────────────────────────────────────────── */
  function _initSortHeaders() {
    const table = document.getElementById('inventory-table');
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
    const table = document.getElementById('inventory-table');
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

  /* ── Render ─────────────────────────────────────────────── */
  function _renderTable(items, total) {
    _total = total || 0;
    const tbody = document.getElementById('inventory-tbody');
    const info  = document.getElementById('inventory-info');
    if (!tbody) return;

    if (!items || !items.length) {
      _selectedSkus.clear();
      _updateDeleteBar();
      tbody.innerHTML = `<tr><td colspan="${COLS.length}" style="padding:0">${Loading.empty('📦', 'No inventory records', 'Upload inventory data to get started')}</td></tr>`;
      if (info) info.textContent = '';
      return;
    }

    tbody.innerHTML = items.map(item => {
      const qty       = Number(item.quantity       ?? 0);
      const sold      = Number(item.units_sold     ?? 0);
      const remaining = Number(item.remaining_stock ?? qty - sold);
      const checked   = _selectedSkus.has(item.sku) ? ' checked' : '';
      const remColor  = remaining < 0 ? 'color:var(--error);font-weight:700' : remaining === 0 ? 'color:var(--txt-4)' : 'color:var(--success);font-weight:600';

      const isUndef    = _isUndefined(item.sku) || _isUndefined(item.upc) || _isUndefined(item.part_number);
      const isPhantom  = remaining < 0;
      const undefBadge    = isUndef   ? ` <span style="font-size:10px;background:#fef9c3;color:#854d0e;padding:1px 5px;border-radius:3px;font-weight:600;vertical-align:middle">UNDEF</span>` : '';
      const phantomBadge  = isPhantom ? ` <span style="font-size:10px;background:#fef3c7;color:#d97706;padding:1px 5px;border-radius:3px;font-weight:600;vertical-align:middle">PHANTOM</span>` : '';
      const rowBg      = isUndef ? ' style="background:rgba(234,179,8,.06)"' : isPhantom ? ' style="background:rgba(234,88,12,.04)"' : '';

      return `<tr data-sku="${Utils.escapeHtml(item.sku || '')}"
                  data-upc="${Utils.escapeHtml(item.upc || '')}"
                  data-qty="${Utils.escapeHtml(String(qty))}"
                  data-part="${Utils.escapeHtml(item.part_number || '')}"
                  data-box="${Utils.escapeHtml(item.box_number || '')}"
                  data-notes="${Utils.escapeHtml(item.notes || '')}"
                  data-date="${Utils.escapeHtml(item.date_added || '')}"${rowBg}>
        <td style="width:36px;text-align:center;padding:0 4px">
          <input type="checkbox" class="inv-row-cb" data-sku="${Utils.escapeHtml(item.sku || '')}"${checked} style="cursor:pointer">
        </td>
        <td style="font-weight:600;color:var(--txt-1)">${Utils.escapeHtml(item.sku || '—')}${undefBadge}${phantomBadge}</td>
        <td>${Utils.escapeHtml(item.box_number || '—')}</td>
        <td>${Utils.escapeHtml(item.part_number || '—')}</td>
        <td>${Utils.escapeHtml(item.upc || '—')}</td>
        <td class="num">${Utils.stockBadge(qty)}</td>
        <td class="num" style="color:var(--txt-3)">${Utils.formatNumber(sold)}</td>
        <td class="num" style="${remColor}">${Utils.formatNumber(remaining)}</td>
        <td>${Utils.formatDate(item.date_added)}</td>
        <td style="font-size:12px;color:var(--txt-4)">${Utils.escapeHtml(item.notes || '—')}</td>
        <td style="width:36px;text-align:center;padding:0 4px">
          <button class="btn btn-ghost btn-icon btn-sm inv-edit-btn" data-sku="${Utils.escapeHtml(item.sku || '')}" title="Edit" style="opacity:.6">✏️</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.inv-row-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) _selectedSkus.add(cb.dataset.sku);
        else            _selectedSkus.delete(cb.dataset.sku);
        _syncSelectAll();
        _updateDeleteBar();
      });
    });

    tbody.querySelectorAll('.inv-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => _openEditModal(btn.closest('tr')));
    });

    _syncSelectAll();
    _updateDeleteBar();

    const ps = CONFIG.getPageSize();
    if (info) {
      const start = ((_page - 1) * ps) + 1;
      const end   = Math.min(_page * ps, _total);
      info.textContent = `Showing ${start}–${end} of ${Utils.formatNumber(_total)}`;
    }

    Pagination.render('inventory-pagination', _page, Math.ceil(_total / ps), p => { _page = p; load(); });
  }

  /* ── Selection helpers ───────────────────────────────────── */
  function _syncSelectAll() {
    const allCb = document.getElementById('inv-select-all');
    if (!allCb) return;
    const boxes  = Array.from(document.querySelectorAll('.inv-row-cb'));
    const allChk = boxes.length > 0 && boxes.every(b => b.checked);
    const anyChk = boxes.some(b => b.checked);
    allCb.checked       = allChk;
    allCb.indeterminate = !allChk && anyChk;
  }

  function _updateDeleteBar() {
    const bar = document.getElementById('inv-delete-bar');
    const cnt = document.getElementById('inv-selected-count');
    if (!bar) return;
    if (_selectedSkus.size > 0) {
      bar.style.display = 'flex';
      if (cnt) cnt.textContent = `${_selectedSkus.size} selected`;
    } else {
      bar.style.display = 'none';
    }
  }

  /* ── Inline edit modal ───────────────────────────────────── */
  function _openEditModal(tr) {
    const bodyHtml = `
      <div style="display:grid;gap:12px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label style="font-size:12px;color:var(--txt-3);font-weight:600;display:block;margin-bottom:4px">SKU</label>
            <input class="form-input" id="inv-edit-sku" value="${Utils.escapeHtml(tr.dataset.sku)}">
          </div>
          <div>
            <label style="font-size:12px;color:var(--txt-3);font-weight:600;display:block;margin-bottom:4px">UPC</label>
            <input class="form-input" id="inv-edit-upc" value="${Utils.escapeHtml(tr.dataset.upc)}">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label style="font-size:12px;color:var(--txt-3);font-weight:600;display:block;margin-bottom:4px">QUANTITY</label>
            <input class="form-input" id="inv-edit-qty" type="number" value="${Utils.escapeHtml(tr.dataset.qty)}">
          </div>
          <div>
            <label style="font-size:12px;color:var(--txt-3);font-weight:600;display:block;margin-bottom:4px">DATE ADDED</label>
            <input class="form-input" id="inv-edit-date" type="date" value="${Utils.toDateInputValue(tr.dataset.date)}">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label style="font-size:12px;color:var(--txt-3);font-weight:600;display:block;margin-bottom:4px">BOX #</label>
            <input class="form-input" id="inv-edit-box" value="${Utils.escapeHtml(tr.dataset.box)}">
          </div>
          <div>
            <label style="font-size:12px;color:var(--txt-3);font-weight:600;display:block;margin-bottom:4px">PART #</label>
            <input class="form-input" id="inv-edit-part" value="${Utils.escapeHtml(tr.dataset.part)}">
          </div>
        </div>
        <div>
          <label style="font-size:12px;color:var(--txt-3);font-weight:600;display:block;margin-bottom:4px">NOTES</label>
          <input class="form-input" id="inv-edit-notes" value="${Utils.escapeHtml(tr.dataset.notes)}" placeholder="Optional">
        </div>
      </div>`;

    const m = new Modal({
      title:    'Edit Inventory Row',
      body:     bodyHtml,
      footer:   `<button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
                 <button class="btn btn-primary btn-sm" data-action="save">Save Changes</button>`,
      maxWidth: '480px',
    });
    m.show();

    m.footerEl.addEventListener('click', async e => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'cancel') { m.hide(); m.destroy(); return; }
      if (action === 'save') {
        const saveBtn = m.footerEl.querySelector('[data-action="save"]');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
          const updates = {
            sku:         document.getElementById('inv-edit-sku').value.trim(),
            upc:         document.getElementById('inv-edit-upc').value.trim(),
            quantity:    parseInt(document.getElementById('inv-edit-qty').value, 10),
            box_number:  document.getElementById('inv-edit-box').value.trim(),
            part_number: document.getElementById('inv-edit-part').value.trim(),
            notes:       document.getElementById('inv-edit-notes').value.trim(),
            date_added:  document.getElementById('inv-edit-date').value,
          };
          if (!updates.sku || !updates.upc || isNaN(updates.quantity)) {
            Notify.warning('Validation', 'SKU, UPC, and quantity are required.');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Changes';
            return;
          }
          await API.updateInventory(tr.dataset.sku, updates);
          Notify.success('Saved', 'Inventory row updated');
          m.hide(); m.destroy();
          load();
        } catch (err) {
          Notify.apiError(err);
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Changes';
        }
      }
    });
  }

  /* ── Bulk delete ─────────────────────────────────────────── */
  async function _deleteSelected() {
    if (_selectedSkus.size === 0) return;
    const skus = Array.from(_selectedSkus);
    const confirmed = await Modal.confirm({
      title:       'Delete Inventory Rows',
      message:     `Delete ${skus.length} selected inventory ${skus.length === 1 ? 'row' : 'rows'}? This cannot be undone.`,
      confirmText: 'Delete',
      danger:      true,
    });
    if (!confirmed) return;
    try {
      const result = await API.deleteInventoryRows(skus);
      _selectedSkus.clear();
      Notify.success('Deleted', `Removed ${result.deleted} inventory ${result.deleted === 1 ? 'row' : 'rows'}`);
      _page = 1;
      load();
    } catch (err) {
      Notify.apiError(err);
    }
  }

  /* ── Set filter programmatically (from dashboard KPI clicks) */
  function setStatusFilter(status) {
    _statusFilter = status || 'all';
    _page = 1;
    _search = '';
    const searchEl = document.getElementById('inventory-search');
    if (searchEl) searchEl.value = '';
    const sel = document.getElementById('filter-inventory-status');
    if (sel) sel.value = _statusFilter;
    load();
  }

  /* ── Export ──────────────────────────────────────────────── */
  let _exporting = false;
  async function _doExportInventory() {
    if (_exporting) return;
    _exporting = true;
    const btn = document.getElementById('inventory-export-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Exporting…'; }
    const isFiltered = _search || _statusFilter !== 'all';
    try {
      const filters = {
        sort_by:  _sortBy  || undefined,
        sort_dir: _sortDir || undefined,
        status:   _statusFilter !== 'all' ? _statusFilter : undefined,
      };
      if (_search) filters.search = _search;
      const blob = await API.exportInventory(filters);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `inventory_${isFiltered ? 'filtered_' : ''}export_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      Notify.apiError(err);
    } finally {
      _exporting = false;
      if (btn) { btn.disabled = false; btn.textContent = '📥 Export'; }
    }
  }

  /* ── Load ────────────────────────────────────────────────── */
  async function load() {
    if (_loading) return;
    _loading = true;

    const tbody = document.getElementById('inventory-tbody');
    if (tbody) tbody.innerHTML = Loading.tableRows(COLS.length, 6);

    const ps = CONFIG.getPageSize();

    try {
      const options = { sort_by: _sortBy, sort_dir: _sortDir, status: _statusFilter || 'all' };
      const data = await API.getInventoryList(_page, ps, _search, options);
      _renderTable(data.items || data.rows || [], data.total || 0);
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="${COLS.length}">${Loading.error('Failed to load inventory')}</td></tr>`;
      Notify.apiError(err);
    } finally {
      _loading = false;
    }
  }

  function init() {
    const searchInput  = document.getElementById('inventory-search');
    const statusSel    = document.getElementById('filter-inventory-status');
    const selectAll    = document.getElementById('inv-select-all');
    const deleteSelBtn = document.getElementById('inv-delete-selected');
    const exportBtn    = document.getElementById('inventory-export-btn');

    if (searchInput) {
      let _debounce;
      searchInput.addEventListener('input', () => {
        clearTimeout(_debounce);
        _debounce = setTimeout(() => { _search = searchInput.value.trim(); _page = 1; load(); }, 300);
      });
      searchInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(_debounce); _search = searchInput.value.trim(); _page = 1; load(); }
      });
    }

    if (statusSel) {
      statusSel.addEventListener('change', () => { _statusFilter = statusSel.value; _page = 1; load(); });
    }

    if (selectAll) {
      selectAll.addEventListener('change', () => {
        document.querySelectorAll('.inv-row-cb').forEach(cb => {
          cb.checked = selectAll.checked;
          if (selectAll.checked) _selectedSkus.add(cb.dataset.sku);
          else                   _selectedSkus.delete(cb.dataset.sku);
        });
        _updateDeleteBar();
      });
    }

    if (deleteSelBtn) deleteSelBtn.addEventListener('click', _deleteSelected);
    if (exportBtn)    exportBtn.addEventListener('click', _doExportInventory);

    _initSortHeaders();
  }

  return { init, load, setUndefinedFilter: () => setStatusFilter('undefined'), setStatusFilter };
})();

/* ── Pagination helper ──────────────────────────────────────── */
const Pagination = {
  render(containerId, currentPage, totalPages, onPageChange) {
    const el = document.getElementById(containerId);
    if (!el || totalPages <= 1) { if (el) el.innerHTML = ''; return; }

    const MAX_VISIBLE = 5;
    const pages = [];

    if (totalPages <= MAX_VISIBLE + 2) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      const start = Math.max(2, currentPage - 1);
      const end   = Math.min(totalPages - 1, currentPage + 1);

      if (start > 2)           pages.push('...');
      for (let i = start; i <= end; i++) pages.push(i);
      if (end < totalPages - 1) pages.push('...');
      pages.push(totalPages);
    }

    el.innerHTML = `
      <div class="page-controls">
        <button class="page-btn" data-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''}>‹</button>
        ${pages.map(p =>
          p === '...'
            ? `<span class="page-sep">…</span>`
            : `<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`
        ).join('')}
        <button class="page-btn" data-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''}>›</button>
      </div>`;

    el.querySelectorAll('.page-btn:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.page);
        if (p >= 1 && p <= totalPages && p !== currentPage) onPageChange(p);
      });
    });
  },
};
