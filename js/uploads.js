/* ============================================================
   uploads.js — TXT file upload workflow, history, templates.

   Accepted upload format: UTF-8 tab-delimited .txt ONLY.
   Max: 100,000 rows / 10 MB per file.

   To prepare a file:
     1. Download the template
     2. Fill it in Excel or Google Sheets
     3. File → Save As → "Text (Tab delimited) (*.txt)"
        or export as UTF-8 tab-separated values
     4. Upload the .txt file here
   ============================================================ */

const Uploads = (() => {

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

  // Stores error arrays keyed by a temporary ID so onclick handlers
  // don't need to inline potentially huge JSON blobs in HTML attributes.
  const _errorCache = {};

  /* ── Drop zone setup ────────────────────────────────────── */
  function _initDropZone(zoneId, inputId, fileType) {
    const zone  = document.getElementById(zoneId);
    const input = document.getElementById(inputId);
    if (!zone || !input) return;

    const icon   = zone.querySelector('.drop-icon');
    const text   = zone.querySelector('.drop-text');
    const sub    = zone.querySelector('.drop-sub');
    const fileEl = zone.querySelector('.drop-file');
    const btnId  = zoneId.replace('drop-zone-', 'upload-btn-');
    const btn    = document.getElementById(btnId);
    const statusEl = document.getElementById(zoneId.replace('drop-zone-', 'upload-status-'));
    const progressWrap = document.getElementById(zoneId.replace('drop-zone-', 'progress-'));
    const progressBar  = progressWrap?.querySelector('.progress-bar');

    // Capture original placeholder text from DOM so reset is always accurate
    const _origIcon = icon?.textContent || '';
    const _origText = text?.textContent || '';
    const _origSub  = sub?.textContent  || '';

    let selectedFile = null;

    function setFile(file) {
      if (!file.name.toLowerCase().endsWith('.txt')) {
        Notify.error(
          'Invalid file type',
          'Only UTF-8 tab-delimited .txt files are accepted. Excel/XLSX uploads are not supported.'
        );
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        Notify.error('File too large', `Maximum file size is 10 MB. Your file is ${Utils.formatFileSize(file.size)}.`);
        return;
      }

      selectedFile = file;
      zone.classList.add('has-file');
      if (icon)   icon.textContent = '✓';
      if (text)   text.textContent = file.name;
      if (sub)    sub.textContent  = Utils.formatFileSize(file.size);
      if (fileEl) { fileEl.textContent = 'File ready'; fileEl.style.display = 'block'; }
      if (btn)    btn.disabled = false;
    }

    function clearFile({ keepStatus = false } = {}) {
      selectedFile = null;
      input.value  = '';
      zone.classList.remove('has-file');

      // Restore exact original placeholder content from DOM snapshot
      if (icon)   icon.textContent = _origIcon;
      if (text)   text.textContent = _origText;
      if (sub)    sub.textContent  = _origSub;
      if (fileEl) { fileEl.textContent = ''; fileEl.style.display = 'none'; }
      if (btn)    btn.disabled = true;

      // Clear button clears everything; post-upload reset keeps result visible
      if (!keepStatus) {
        if (statusEl)    statusEl.innerHTML = '';
        if (progressBar) { progressBar.style.width = '0%'; progressBar.className = 'progress-bar'; }
        if (progressWrap) progressWrap.style.display = 'none';
      }
    }

    zone.addEventListener('click', e => { if (!e.target.closest('button')) input.click(); });
    input.addEventListener('change', e => { if (e.target.files[0]) setFile(e.target.files[0]); });

    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) setFile(file);
    });

    if (btn) {
      btn.disabled = true;
      btn.addEventListener('click', async () => {
        if (!selectedFile) return;
        await _doUpload(selectedFile, fileType, btn, zoneId);
        clearFile({ keepStatus: true });
      });
    }

    const clearBtn = document.getElementById(zoneId.replace('drop-zone-', 'clear-btn-'));
    if (clearBtn) clearBtn.addEventListener('click', clearFile);

    return { setFile, clearFile, getFile: () => selectedFile };
  }

  /* ── Upload logic ───────────────────────────────────────── */
  async function _doUpload(file, fileType, btn, zoneId) {
    const progressWrap = document.getElementById(zoneId.replace('drop-zone-', 'progress-'));
    const progressBar  = progressWrap?.querySelector('.progress-bar');
    const statusEl     = document.getElementById(zoneId.replace('drop-zone-', 'upload-status-'));

    Loading.btn(btn, true);
    if (progressWrap) progressWrap.style.display = 'block';
    if (progressBar)  { progressBar.style.width = '0%'; progressBar.className = 'progress-bar'; }
    if (statusEl)     statusEl.innerHTML = '';

    const setProgress = pct => { if (progressBar) progressBar.style.width = pct + '%'; };

    try {
      setProgress(20);

      const apiMethod = fileType === 'inventory' ? API.uploadInventory : API.uploadOrders;
      const result    = await apiMethod(file);

      setProgress(100);
      if (progressBar) progressBar.classList.add('success');

      const inserted = result.inserted ?? 0;
      const skipped  = result.skipped  ?? 0;
      const errors   = result.errors   ?? [];

      if (statusEl) {
        statusEl.innerHTML = `
          <div style="margin-top:10px;font-size:13px">
            ${Utils.badgeHtml('success', `✓ ${inserted} rows imported`)}
            ${skipped > 0 ? Utils.badgeHtml('warning', `${skipped} skipped`) : ''}
          </div>
          ${errors.length > 0 ? _renderErrors(errors) : ''}`;
      }

      Notify.success('Upload complete', `${inserted} rows imported successfully.`);
      loadHistory();
    } catch (err) {
      if (progressBar) progressBar.classList.add('error');
      if (statusEl) statusEl.innerHTML = `<div class="form-error" style="margin-top:8px">✕ ${Utils.escapeHtml(err.message)}</div>`;
      Notify.apiError(err);
    } finally {
      Loading.btn(btn, false);
      setTimeout(() => { if (progressWrap) progressWrap.style.display = 'none'; }, 4000);
    }
  }

  function _formatErrorReason(e) {
    const field  = String(e.field  || '');
    const reason = String(e.reason || '');
    // If reason starts with the field name, replace it with uppercase version
    if (field && reason.toLowerCase().startsWith(field.toLowerCase())) {
      return field.toUpperCase() + reason.slice(field.length);
    }
    return reason.charAt(0).toUpperCase() + reason.slice(1);
  }

  function _renderErrors(errors) {
    if (!errors.length) return '';
    const cacheKey = 'e' + Date.now();
    _errorCache[cacheKey] = errors;
    const shown = errors.slice(0, 10);
    return `
      <div style="margin-top:8px;background:var(--error-bg);border:1px solid var(--error-bd);border-radius:var(--r-sm);padding:10px;font-size:12px;color:var(--error)">
        <strong>Validation issues (${errors.length} rows rejected):</strong>
        <ul style="margin:4px 0 0 16px;padding:0">
          ${shown.map(e => `<li>Row ${e.row} → ${Utils.escapeHtml(_formatErrorReason(e))}</li>`).join('')}
          ${errors.length > 10 ? `<li>…and ${errors.length - 10} more</li>` : ''}
        </ul>
        <div style="margin-top:6px">
          <a href="#" style="font-size:12px;color:var(--primary)"
             onclick="Uploads.downloadFailedRows('${cacheKey}');return false">
            Download failed_rows.txt
          </a>
        </div>
      </div>`;
  }

  function downloadFailedRows(cacheKey) {
    const errors = _errorCache[cacheKey] || [];
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const lines = ['row\tfield\treason'];
    errors.forEach(e => lines.push(`${e.row}\t${String(e.field ?? '')}\t${String(e.reason ?? '')}`));
    const blob = new Blob([lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `failed_rows_${ts}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ── Upload history ─────────────────────────────────────── */
  async function loadHistory(type = '') {
    const tbody  = document.getElementById('upload-history-tbody');
    const filter = document.getElementById('history-type-filter')?.value || type;
    if (!tbody) return;

    tbody.innerHTML = Loading.tableRows(6, 5);

    try {
      const rows = await API.getUploadHistory(filter);
      const list = Array.isArray(rows) ? rows : (rows.rows || []);

      if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="5" style="padding:0">${Loading.empty('📤', 'No uploads yet')}</td></tr>`;
        return;
      }

      tbody.innerHTML = list.map(row => {
        const statusVariant = {
          success: 'success', completed: 'success',
          partial: 'warning',
          failed:  'error', error: 'error',
        }[row.status?.toLowerCase()] || 'gray';

        return `<tr>
          <td>${Utils.formatDatetime(row.created_at)}</td>
          <td>${Utils.badgeHtml(row.type === 'inventory' ? 'info' : 'warning', row.type || '—')}</td>
          <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(row.filename || '—')}</td>
          <td class="num">${Utils.formatNumber(row.row_count)}</td>
          <td>${Utils.badgeHtml(statusVariant, row.status || '—')}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5">${Loading.error('Failed to load history')}</td></tr>`;
    }
  }

  /* ── Template downloads ─────────────────────────────────── */
  const _templates = {
    inventory: {
      filename: 'inventory_template.csv',
      // Headers + one example row. UPC/SKU are TEXT — format those columns as
      // Text in Excel BEFORE entering values to prevent leading-zero loss.
      content: [
        'sku,upc,quantity,part_number,box_number,date_added,notes',
        'SKU-001,012345678901,25,PT-123,BX-001,2026-05-11,Sample item',
        'SKU-002,098765432109,10,,,2026-05-11,',
      ].join('\r\n'),
    },
    orders: {
      filename: 'orders_template.csv',
      content: [
        'order_date,sku,quantity_sold,platform,shipped_from_box',
        '2026-05-11,SKU-001,2,Amazon,BX-001',
        '2026-05-11,SKU-002,1,eBay,',
      ].join('\r\n'),
    },
  };

  function _bindTemplateLinks() {
    document.querySelectorAll('[data-download-template]').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        const type = link.dataset.downloadTemplate;
        const tpl  = _templates[type];
        if (!tpl) return;
        const blob = new Blob([tpl.content], { type: 'text/csv;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = tpl.filename;
        a.click();
        URL.revokeObjectURL(url);
      });
    });
  }

  /* ── Init ────────────────────────────────────────────────── */
  function init() {
    _initDropZone('drop-zone-inventory', 'file-input-inventory', 'inventory');
    _initDropZone('drop-zone-orders',    'file-input-orders',    'orders');
    _bindTemplateLinks();

    const historyFilter = document.getElementById('history-type-filter');
    if (historyFilter) historyFilter.addEventListener('change', () => loadHistory(historyFilter.value));

    const refreshBtn = document.getElementById('history-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => loadHistory());
  }

  /* ── Upload modal (called from other pages) ─────────────── */
  function openModal(fileType) {
    const label = fileType === 'inventory' ? 'Inventory' : 'Orders';
    const zoneId  = `drop-zone-modal-${fileType}`;
    const inputId = `file-input-modal-${fileType}`;
    const btnId   = `upload-modal-btn-${fileType}`;

    const m = new Modal({
      title:    `📤 Upload ${label} Report`,
      maxWidth: '460px',
      body: `
        <div class="drop-zone" id="${zoneId}" style="margin-bottom:12px">
          <input type="file" id="${inputId}" accept=".txt">
          <div class="drop-icon">${fileType === 'inventory' ? '📦' : '📋'}</div>
          <div class="drop-text">Drop .txt file here or click to browse</div>
          <div class="drop-sub">UTF-8 tab-delimited TXT (.txt) · Max 10 MB / 100,000 rows</div>
          <div class="drop-file" style="display:none"></div>
        </div>
        <div class="progress-wrap" id="progress-modal-${fileType}" style="display:none"><div class="progress-bar"></div></div>
        <div id="upload-status-modal-${fileType}"></div>`,
      footer: `
        <button class="btn btn-secondary btn-sm" data-action="clear">Clear</button>
        <button class="btn btn-primary btn-sm" id="${btnId}" disabled>Upload</button>`,
    });
    m.show();

    const zone = _initDropZone(zoneId, inputId, fileType);

    m.footerEl.addEventListener('click', async e => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'clear') { zone?.clearFile(); return; }
    });

    const btn = document.getElementById(btnId);
    if (btn) {
      btn.disabled = true;
      btn.addEventListener('click', async () => {
        const file = zone?.getFile();
        if (!file) return;
        await _doUpload(file, fileType, btn, zoneId);
        zone?.clearFile({ keepStatus: true });
      });
    }
  }

  return { init, loadHistory, downloadFailedRows, openModal };
})();
