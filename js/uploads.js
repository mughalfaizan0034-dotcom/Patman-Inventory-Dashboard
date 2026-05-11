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

    let selectedFile = null;

    function setFile(file) {
      // Client-side validation: type and size
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

    function clearFile() {
      selectedFile = null;
      zone.classList.remove('has-file');
      if (icon)   icon.textContent = fileType === 'inventory' ? '📦' : '📋';
      if (text)   text.textContent = 'Drop file here or click to browse';
      if (sub)    sub.textContent  = 'UTF-8 tab-delimited TXT (.txt) · Max 10 MB';
      if (fileEl) fileEl.style.display = 'none';
      if (btn)    btn.disabled = true;
      input.value = '';
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
        clearFile();
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
          ${errors.length > 0 ? _renderErrors(errors, result.upload_id) : ''}`;
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

  function _renderErrors(errors, uploadId) {
    if (!errors.length) return '';
    const shown = errors.slice(0, 10);
    const downloadLink = uploadId
      ? `<a href="#" style="font-size:12px;color:var(--primary)" onclick="Uploads.downloadFailedRows(${JSON.stringify(errors)});return false">Download failed_rows.txt</a>`
      : '';
    return `
      <div style="margin-top:8px;background:var(--error-bg);border:1px solid var(--error-bd);border-radius:var(--r-sm);padding:10px;font-size:12px;color:var(--error)">
        <strong>Validation issues (${errors.length} rows rejected):</strong>
        <ul style="margin:4px 0 0 16px;padding:0">
          ${shown.map(e => `<li>Row ${e.row}: <strong>${Utils.escapeHtml(String(e.field))}</strong> = ${Utils.escapeHtml(String(e.value ?? ''))} — ${Utils.escapeHtml(e.reason)}</li>`).join('')}
          ${errors.length > 10 ? `<li>…and ${errors.length - 10} more</li>` : ''}
        </ul>
        <div style="margin-top:6px">${downloadLink}</div>
      </div>`;
  }

  function downloadFailedRows(errors) {
    const lines = ['row\tfield\tvalue\treason'];
    errors.forEach(e => {
      lines.push(`${e.row}\t${e.field}\t${String(e.value ?? '')}\t${e.reason}`);
    });
    const blob = new Blob([lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'failed_rows.txt';
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
  function _bindTemplateLinks() {
    document.querySelectorAll('[data-download-template]').forEach(link => {
      link.addEventListener('click', async e => {
        e.preventDefault();
        const type = link.dataset.downloadTemplate;
        try {
          const text = await API.downloadTemplate(type);
          // template is returned as plain text from server
          const content = typeof text === 'string' ? text : JSON.stringify(text);
          const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href     = url;
          a.download = `${type}_template.txt`;
          a.click();
          URL.revokeObjectURL(url);
        } catch {
          // Fallback: download from static assets
          const a    = document.createElement('a');
          a.href     = `assets/templates/${type}_template.csv`;
          a.download = `${type}_template.csv`;
          a.click();
        }
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

  return { init, loadHistory, downloadFailedRows };
})();
