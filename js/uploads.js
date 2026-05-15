/* ============================================================
   uploads.js — TSV file upload workflow, history, templates.

   Accepted upload format: UTF-8 Tab Separated Values (.tsv).
   Legacy .txt (correctly tab-delimited) is still accepted for
   backward compat. CSV is NOT accepted — Excel's CSV export
   uses commas, which the parser cannot interpret correctly.
   Max: 100,000 rows / 10 MB per file.

   To prepare a file:
     1. Download the CSV template
     2. Fill it in Excel or Google Sheets
     3. File → Save As → "Tab Separated Values (*.tsv)"
     4. Upload the .tsv file here
   ============================================================ */

const Uploads = (() => {

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
  const ACCEPTED_EXT  = /\.(tsv|txt)$/i;  // .tsv canonical; .txt legacy alias

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

    // Snapshot original placeholder so reset is always accurate
    // Use innerHTML to capture the SVG that Lucide renders into .drop-icon
    const _origIcon = icon?.innerHTML || '';
    const _origText = text?.textContent || '';
    const _origSub  = sub?.textContent  || '';
    const _lucideIconName = fileType === 'inventory' ? 'package' : 'clipboard-list';

    let selectedFile = null;

    function setFile(file) {
      if (!ACCEPTED_EXT.test(file.name)) {
        Notify.error(
          'Invalid file type',
          'Save your spreadsheet as Tab Separated Values (.tsv) and upload that. CSV and Excel files are not accepted.'
        );
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        Notify.error('File too large', `Maximum file size is 10 MB. Your file is ${Utils.formatFileSize(file.size)}.`);
        return;
      }

      selectedFile = file;
      zone.classList.add('has-file');
      if (icon)   icon.innerHTML = '<i data-lucide="check" class="icon" style="width:32px;height:32px;color:var(--success)" aria-hidden="true"></i>';
      if (text)   text.textContent = file.name;
      if (sub)    sub.textContent  = Utils.formatFileSize(file.size);
      if (fileEl) { fileEl.textContent = 'File ready'; fileEl.style.display = 'block'; }
      if (btn)    btn.disabled = false;
    }

    function clearFile({ keepStatus = false } = {}) {
      selectedFile = null;
      input.value  = '';
      zone.classList.remove('has-file');

      // Restore original drop-zone icon
      if (icon)   icon.innerHTML = _origIcon || `<i data-lucide="${_lucideIconName}" class="icon" style="width:32px;height:32px" aria-hidden="true"></i>`;
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
  const _UPLOAD_STEPS = [
    { label: 'Parsing',     pct: 18 },
    { label: 'Validating',  pct: 42 },
    { label: 'Calculating', pct: 68 },
    { label: 'Syncing',     pct: 85 },
  ];
  const _STEP_DELAYS = [0, 800, 1800, 3000]; // ms after upload starts

  function _stepsHtml(activeIdx) {
    return `<div class="upload-steps">${
      _UPLOAD_STEPS.map((s, i) => {
        const cls  = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
        const icon = i < activeIdx ? '✓' : i === activeIdx ? '●' : '';
        return `<div class="upload-step ${cls}"><span class="upload-step-dot">${icon}</span><span class="upload-step-label">${s.label}</span></div>`;
      }).join('')
    }</div>`;
  }

  async function _doUpload(file, fileType, btn, zoneId) {
    const progressWrap = document.getElementById(zoneId.replace('drop-zone-', 'progress-'));
    const progressBar  = progressWrap?.querySelector('.progress-bar');
    const statusEl     = document.getElementById(zoneId.replace('drop-zone-', 'upload-status-'));

    Loading.btn(btn, true);
    if (progressWrap) progressWrap.style.display = 'block';
    if (progressBar)  { progressBar.style.width = '0%'; progressBar.className = 'progress-bar'; }
    if (statusEl)     statusEl.innerHTML = '';

    const setProgress = pct => { if (progressBar) progressBar.style.width = pct + '%'; };

    // Animate step indicators while request is in-flight
    const _stepTimers = [];
    function _advanceStep(idx) {
      if (statusEl) statusEl.innerHTML = _stepsHtml(idx);
      setProgress(_UPLOAD_STEPS[idx].pct);
    }
    _STEP_DELAYS.forEach((delay, i) => {
      _stepTimers.push(setTimeout(() => _advanceStep(i), delay));
    });

    try {
      const apiMethod = fileType === 'inventory' ? API.uploadInventory : API.uploadOrders;
      const result    = await apiMethod(file);

      _stepTimers.forEach(clearTimeout);
      setProgress(100);
      if (progressBar) progressBar.classList.add('success');

      const added   = result.added   ?? 0;
      const updated = result.updated ?? 0;
      const removed = result.removed ?? 0;
      const failed  = result.failed  ?? 0;
      const errors  = result.errors  ?? [];
      const total   = added + updated + removed;

      if (statusEl) {
        const badges = [
          added   > 0 ? Utils.badgeHtml('success', `${added} added`)     : '',
          updated > 0 ? Utils.badgeHtml('info',    `${updated} updated`) : '',
          removed > 0 ? Utils.badgeHtml('gray',    `${removed} removed`) : '',
          failed  > 0 ? Utils.badgeHtml('warning', `${failed} failed`)   : '',
        ].filter(Boolean).join(' ');

        statusEl.innerHTML = `
          <div style="margin-top:10px;font-size:13px">${badges || Utils.badgeHtml('gray', 'No rows processed')}</div>
          ${errors.length > 0 ? _renderErrors(errors) : ''}`;
      }

      MetricsEngine.invalidate();
      Notify.success('Upload complete', `${total} row${total !== 1 ? 's' : ''} processed (${added} added, ${updated} updated, ${removed} removed).`);
      loadHistory();
    } catch (err) {
      _stepTimers.forEach(clearTimeout);
      if (progressBar) progressBar.classList.add('error');
      if (statusEl) statusEl.innerHTML = `<div class="form-error" style="margin-top:8px">${Utils.escapeHtml(err.message)}</div>`;
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
        tbody.innerHTML = `<tr><td colspan="6" style="padding:0">${Loading.empty('upload', 'No uploads yet')}</td></tr>`;
        return;
      }

      tbody.innerHTML = list.map(row => {
        const statusVariant = {
          success: 'success', completed: 'success',
          partial: 'warning',
          failed:  'error', error: 'error',
        }[row.status?.toLowerCase()] || 'gray';

        // Summary cell — links to the per-upload plain-text report.
        // Server returns has_report=true for uploads that stored a report;
        // legacy uploads from before the report column was added show "—".
        const summaryCell = row.has_report
          ? `<button class="btn btn-ghost btn-sm" data-report-id="${Utils.escapeHtml(row.upload_id || '')}" title="Download .txt summary report">
               <i data-lucide="download" class="icon" style="width:13px;height:13px"></i> Report
             </button>`
          : '<span style="color:var(--txt-4);font-size:12px">—</span>';

        return `<tr>
          <td>${Utils.formatDatetime(row.created_at)}</td>
          <td>${Utils.badgeHtml(row.type === 'inventory' ? 'info' : 'warning', row.type || '—')}</td>
          <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Utils.escapeHtml(row.filename || '—')}</td>
          <td class="num">${Utils.formatNumber(row.row_count)}</td>
          <td>${Utils.badgeHtml(statusVariant, row.status || '—')}</td>
          <td>${summaryCell}</td>
        </tr>`;
      }).join('');

      // Wire report download buttons. Each click hits the streaming
      // /uploads/report/:id endpoint which returns text/plain with
      // a Content-Disposition: attachment header — the browser saves
      // it directly without any client-side blob construction.
      tbody.querySelectorAll('[data-report-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id  = btn.dataset.reportId;
          const tok = sessionStorage.getItem(CONFIG.SESSION_KEY) || '';
          if (!id || !tok) return;
          // Use fetch + blob so we can attach the bearer token; a plain
          // <a href> would not include the Authorization header.
          fetch(`${CONFIG.CLOUD_RUN_URL}/uploads/report/${encodeURIComponent(id)}`, {
            headers: { Authorization: `Bearer ${tok}` },
          })
            .then(res => {
              if (!res.ok) throw new Error(`Report download failed: ${res.status}`);
              const disposition = res.headers.get('Content-Disposition') || '';
              const match = disposition.match(/filename="([^"]+)"/);
              return res.blob().then(blob => ({ blob, name: match?.[1] || `upload_${id}_report.txt` }));
            })
            .then(({ blob, name }) => {
              const url = URL.createObjectURL(blob);
              const a   = document.createElement('a');
              a.href     = url;
              a.download = name;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 0);
            })
            .catch(err => Notify.error('Report download failed', err.message));
        });
      });

      Icons?.refresh?.();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6">${Loading.error('Failed to load history')}</td></tr>`;
    }
  }

  /* ── Template downloads ─────────────────────────────────── */
  // Templates MUST match server/src/uploads/schemas/{inventory,orders}Schema.js.
  // Keep these field orders in sync with the backend parser.
  //
  // INVENTORY columns (9):
  //   action, uid, sku, upc, quantity, part_number, box_number, date_added, notes
  //   • uid: leave blank on Add (auto-assigned). Required on Update / Remove.
  //
  // ORDERS columns (8):
  //   action, uid, order_id, order_date, sku, quantity_sold, platform, shipped_sku
  //   • uid: INTERNAL row tracker. Blank on Add. Required on Update / Remove.
  //   • order_id: EXTERNAL marketplace order number. Required on Add.
  //   • shipped_sku: fulfillment override. Accepts a bare box number ("20"),
  //     an ARA-prefixed box ("ARA20"), or the full reassigned SKU
  //     ("ARA20-4060915-037256018282") — the server normalizes all three to
  //     a bare box. Header `shipped_from_box` is still accepted (alias).
  const _templates = {
    inventory: {
      filename: 'inventory_template.csv',
      content: [
        'action,uid,sku,upc,quantity,part_number,box_number,date_added,notes',
        'Add,,SKU-001,012345678901,25,PT-123,BX-001,2026-05-11,Sample item',
        'Add,,SKU-002,098765432109,10,,,2026-05-11,',
        'Update,UID-FROM-EXPORT,,,30,,,,',
        'Remove,UID-FROM-EXPORT,,,,,,,',
      ].join('\r\n'),
    },
    orders: {
      filename: 'orders_template.csv',
      content: [
        // 8 columns: action, uid, order_id, order_date, sku, quantity_sold, platform, shipped_sku
        'action,uid,order_id,order_date,sku,quantity_sold,platform,shipped_sku',
        'Add,,111-2222222-3333333,2026-05-11,SKU-001,2,Amazon,BX-001',
        'Add,,EBAY-9876543210,2026-05-11,SKU-002,1,eBay,',
        // Update qty_sold to 3, leave all other fields unchanged:
        'Update,UID-FROM-EXPORT,,,,3,,',
        // Remove only needs action + uid; remaining 6 fields blank:
        'Remove,UID-FROM-EXPORT,,,,,,',
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
        const blob = new Blob(['﻿' + tpl.content], { type: 'text/csv;charset=utf-8' });
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
      title:    `Upload ${label} Report`,
      maxWidth: '460px',
      body: `
        <div class="drop-zone" id="${zoneId}" style="margin-bottom:12px">
          <input type="file" id="${inputId}" accept=".tsv,.txt">
          <div class="drop-icon"><i data-lucide="${fileType === 'inventory' ? 'package' : 'clipboard-list'}" class="icon" style="width:32px;height:32px" aria-hidden="true"></i>
          </div>
          <div class="drop-text">Drop .tsv file here or click to browse</div>
          <div class="drop-sub">Tab Separated Values (.tsv) · Max 10 MB / 100,000 rows</div>
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

  // Clears in-memory state — called by App.resetAllState() on org switch.
  function reset() {
    const historyEl = document.getElementById('upload-history');
    if (historyEl) historyEl.innerHTML = '';
  }

  return { init, loadHistory, downloadFailedRows, openModal, reset };
})();
