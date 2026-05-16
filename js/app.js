/* ============================================================
   app.js — App router, page navigation, Settings page, Users
            management, System status. Main bootstrap entry point.
   ============================================================ */

/* ── Settings page ──────────────────────────────────────────── */
const Settings = (() => {

  let _usersCache = [];
  let _orgsCache  = [];

  // 3-tier role model: admin / manager / viewer.
  // Clean labels — no descriptive text. Display "View" instead of "Viewer".
  const ROLE_COLOR = { admin: 'error', manager: 'warning', viewer: 'gray' };
  const ROLE_LABEL = {
    admin:   'Admin',
    manager: 'Manager',
    viewer:  'View',
  };

  function _roleOptions(selected = 'viewer') {
    return Object.entries(ROLE_LABEL).map(([v, l]) =>
      `<option value="${v}"${v === selected ? ' selected' : ''}>${Utils.escapeHtml(l)}</option>`
    ).join('');
  }

  /* ── SKU Structure builder v2 (Organizations tab) ──────────
     Segment-aware editor used by both the New / Edit Organization modals.
     Public API:
       _renderSkuStructureSection(struct, { required })  → HTML
       _wireSkuStructureSection(rootEl)                  → attaches listeners
       _readSkuStructureSection(rootEl)                  → v2 structure or null
     The structure object follows the canonical shape documented in
     server/src/utils/skuEngine.js (v2: { version, enabled, separators[],
     segments[], ... }). Legacy v1 input from the server is auto-coerced. */

  const SEGMENT_LABEL = Object.freeze({
    identifier:  'Identifier',
    part_number: 'Part Number',
    upc:         'UPC',
    box:         'Box',
    free_text:   'Free Text',
    wildcard:    'Wildcard',
  });

  function _defaultSegmentForType(type) {
    const seg = { id: `seg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, type, required: true, values: null, pattern: null, allow_attached_box: false };
    if (type === 'identifier')  { seg.values = ['ARA']; seg.allow_attached_box = true; }
    if (type === 'part_number') { seg.pattern = '[A-Z0-9]+'; }
    if (type === 'upc')         { seg.pattern = '\\d+';     }
    if (type === 'box')         { seg.pattern = '\\d+';     }
    if (type === 'free_text')   { seg.pattern = '[^\\s\\-_]+'; }
    if (type === 'wildcard')    { seg.required = false; }
    return seg;
  }

  function _defaultStructure() {
    return {
      version:          2,
      enabled:          true,
      case_insensitive: true,
      separators:       ['-'],
      segments: [
        _defaultSegmentForType('identifier'),
        _defaultSegmentForType('part_number'),
        _defaultSegmentForType('upc'),
      ],
    };
  }

  function _renderSegmentRow(seg, idx) {
    const typeOpts = SkuEngine.SEGMENT_TYPES.map(t =>
      `<option value="${t}"${t === seg.type ? ' selected' : ''}>${Utils.escapeHtml(SEGMENT_LABEL[t] || t)}</option>`
    ).join('');

    // Per-type detail input (values for identifier, pattern for everything else)
    let detail = '';
    if (seg.type === 'identifier') {
      detail = `
        <input class="form-input" data-seg-values
          value="${Utils.escapeHtml((seg.values || []).join(', '))}"
          placeholder="ARA, BX"
          title="Allowed identifier values (comma-separated)"
          style="font-family:monospace">
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--txt-3);margin-top:4px;cursor:pointer;white-space:nowrap">
          <input type="checkbox" data-seg-attach${seg.allow_attached_box ? ' checked' : ''} style="accent-color:var(--primary)">
          <span>Allow attached box (ARA1 ≡ ARA-1)</span>
        </label>`;
    } else if (seg.type === 'wildcard') {
      detail = `<div class="form-hint" style="font-size:11px">Matches anything.</div>`;
    } else {
      detail = `<input class="form-input" data-seg-pattern
        value="${Utils.escapeHtml(seg.pattern || '')}"
        placeholder="\\d+ / [A-Z0-9]+ / …"
        title="Regex fragment for this segment"
        style="font-family:monospace">`;
    }

    return `
      <div class="sku-seg-row" data-seg-id="${Utils.escapeHtml(seg.id)}"
           style="display:grid;grid-template-columns:24px 130px 1fr auto;gap:8px;align-items:start;padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm)">
        <div data-seg-index style="font-size:11px;font-weight:700;color:var(--txt-4);padding-top:8px;text-align:center">${idx + 1}</div>
        <div>
          <select class="form-select" data-seg-type style="font-size:12px;padding:6px 8px">${typeOpts}</select>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--txt-3);margin-top:4px;cursor:pointer">
            <input type="checkbox" data-seg-required${seg.required ? ' checked' : ''} style="accent-color:var(--primary)">
            <span>Required</span>
          </label>
        </div>
        <div data-seg-detail>${detail}</div>
        <div style="display:flex;flex-direction:column;gap:3px">
          <button type="button" class="btn btn-ghost btn-sm" data-seg-up    title="Move up"     style="padding:2px 6px">↑</button>
          <button type="button" class="btn btn-ghost btn-sm" data-seg-down  title="Move down"   style="padding:2px 6px">↓</button>
          <button type="button" class="btn btn-ghost btn-sm" data-seg-del   title="Remove"      style="padding:2px 6px;color:var(--error)">×</button>
        </div>
      </div>`;
  }

  function _renderSkuStructureSection(struct, { required = false } = {}) {
    const v2 = SkuEngine.coerceToV2(struct);
    // If the incoming structure was empty but the section is mandatory,
    // start with a sensible template so the admin sees concrete segments.
    const useStruct = (v2.segments?.length || !required) ? v2 : _defaultStructure();
    const segments  = useStruct.segments?.length ? useStruct.segments : _defaultStructure().segments;
    const separators = (useStruct.separators || ['-']).map(s => s === '' ? '(none)' : s).join(', ');

    return `
      <div class="form-group" data-sku-structure
           data-required="${required ? '1' : '0'}"
           data-segments='${Utils.escapeHtml(JSON.stringify(segments))}'>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <label class="form-label" style="margin:0">
            SKU Structure ${required ? '<span class="req">*</span>' : ''}
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--txt-3);cursor:pointer">
            <input type="checkbox" data-sku-enabled${useStruct.enabled !== false ? ' checked' : ''} style="accent-color:var(--primary)">
            <span>Enable validation</span>
          </label>
        </div>
        <div class="form-hint" style="margin-bottom:8px">
          Add segments in order. Any inventory row whose SKU does not match counts as <strong>Undefined</strong> across the whole app.
        </div>

        <div style="display:grid;grid-template-columns:1fr 160px;gap:8px;margin-bottom:8px">
          <div>
            <label class="form-label" style="font-size:11px;font-weight:600">Allowed separators</label>
            <input class="form-input" data-sku-separators value="${Utils.escapeHtml(separators)}"
                   placeholder="-, _, (none)" style="font-family:monospace">
            <div class="form-hint" style="font-size:10.5px">Comma-separated. <code>(none)</code> makes separators optional between segments.</div>
          </div>
          <div>
            <label class="form-label" style="font-size:11px;font-weight:600">Case</label>
            <select class="form-select" data-sku-case style="font-size:12px;padding:6px 8px">
              <option value="ci"${useStruct.case_insensitive !== false ? ' selected' : ''}>Case-insensitive</option>
              <option value="cs"${useStruct.case_insensitive === false ? ' selected' : ''}>Case-sensitive</option>
            </select>
          </div>
        </div>

        <div data-sku-segments style="display:flex;flex-direction:column;gap:6px;margin-bottom:6px"></div>
        <button type="button" class="btn btn-secondary btn-sm" data-sku-add-seg style="font-size:11.5px">+ Add segment</button>

        <div style="margin-top:12px;padding:10px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm)">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--txt-4);margin-bottom:6px">Compiled pattern</div>
          <div data-sku-preview style="font-family:monospace;font-size:12px;color:var(--txt-2);word-break:break-all;min-height:18px">—</div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
            <input class="form-input" data-sku-test placeholder="Paste a SKU to test, e.g. ARA1-12345-998877" style="flex:1">
            <span data-sku-test-result style="font-size:12px;font-weight:600;white-space:nowrap;min-width:96px;text-align:right">—</span>
          </div>
          <div data-sku-breakdown style="margin-top:8px;font-size:11.5px;color:var(--txt-3);min-height:14px"></div>
        </div>
      </div>`;
  }

  // Parse the separator-input string into the structure separators array.
  // "(none)" / "none" / "" → '' (separator optional).
  function _parseSeparatorsInput(raw) {
    return String(raw || '')
      .split(',')
      .map(s => s.trim())
      .map(s => (s.toLowerCase() === '(none)' || s.toLowerCase() === 'none') ? '' : s)
      .filter((s, i, arr) => s !== undefined && arr.indexOf(s) === i);
  }

  // Read just the raw shape — used for the live preview while editing.
  function _readSkuStructureFromInputs(rootEl) {
    if (!rootEl) return null;
    const get = sel => rootEl.querySelector(sel);
    const separators = _parseSeparatorsInput(get('[data-sku-separators]')?.value);
    const enabled    = Boolean(get('[data-sku-enabled]')?.checked);
    const caseMode   = get('[data-sku-case]')?.value || 'ci';
    const segments = Array.from(rootEl.querySelectorAll('.sku-seg-row')).map(row => {
      const id   = row.dataset.segId;
      const type = row.querySelector('[data-seg-type]').value;
      const required = Boolean(row.querySelector('[data-seg-required]')?.checked);
      const seg = { id, type, required, values: null, pattern: null, allow_attached_box: false };
      if (type === 'identifier') {
        const valStr = row.querySelector('[data-seg-values]')?.value || '';
        seg.values = valStr.split(',').map(v => v.trim()).filter(Boolean);
        seg.allow_attached_box = Boolean(row.querySelector('[data-seg-attach]')?.checked);
      } else if (type !== 'wildcard') {
        seg.pattern = row.querySelector('[data-seg-pattern]')?.value || '';
      }
      return seg;
    });
    return { version: 2, enabled, case_insensitive: caseMode === 'ci', separators: separators.length ? separators : ['-'], segments };
  }

  // Read + normalize for sending to the API. Returns null when the section
  // is disabled or has no valid segments — server treats null as cleared.
  function _readSkuStructureSection(rootEl) {
    const raw = _readSkuStructureFromInputs(rootEl);
    if (!raw) return null;
    const v2 = SkuEngine.coerceToV2(raw);
    if (!v2.enabled || !v2.segments?.length) return null;
    return v2;
  }

  function _renderSegmentList(rootEl) {
    const segs = JSON.parse(rootEl.dataset.segments || '[]');
    const listEl = rootEl.querySelector('[data-sku-segments]');
    listEl.innerHTML = segs.map((s, i) => _renderSegmentRow(s, i)).join('');
  }

  // Re-snapshot the current input values back into rootEl.dataset.segments so
  // re-render keeps the user's edits.
  function _snapshotSegments(rootEl) {
    const segs = _readSkuStructureFromInputs(rootEl)?.segments || [];
    rootEl.dataset.segments = JSON.stringify(segs);
  }

  function _wireSkuStructureSection(rootEl) {
    if (!rootEl) return;
    const previewEl   = rootEl.querySelector('[data-sku-preview]');
    const testEl      = rootEl.querySelector('[data-sku-test]');
    const resultEl    = rootEl.querySelector('[data-sku-test-result]');
    const breakdown   = rootEl.querySelector('[data-sku-breakdown]');

    const refresh = () => {
      const struct = SkuEngine.coerceToV2(_readSkuStructureFromInputs(rootEl));
      const compiled = SkuEngine.compileSegmentsRegex(struct);
      if (!struct.enabled) {
        previewEl.textContent = 'Validation disabled — only empty / NA placeholders count as undefined.';
        previewEl.style.color = 'var(--txt-4)';
      } else if (!compiled) {
        previewEl.textContent = 'Add at least one segment to compile the pattern.';
        previewEl.style.color = 'var(--warning)';
      } else {
        previewEl.textContent = compiled;
        previewEl.style.color = 'var(--txt-2)';
      }

      const sku = testEl?.value || '';
      if (!sku.trim()) {
        resultEl.textContent = '—';
        resultEl.style.color = 'var(--txt-4)';
        breakdown.textContent = '';
      } else {
        const res = SkuEngine.parseSku(sku, struct);
        if (res.valid) {
          resultEl.textContent = '✓ Valid';
          resultEl.style.color = 'var(--success)';
          breakdown.innerHTML = res.segments.length
            ? `Parsed: ${res.segments.map(s => `<strong>${Utils.escapeHtml(s.value)}</strong> <span style="color:var(--txt-4)">(${s.type})</span>`).join(' &middot; ')}`
            : `Normalized: <code>${Utils.escapeHtml(res.normalized)}</code>`;
        } else {
          resultEl.textContent = res.reason === 'empty_or_placeholder' ? '✗ Placeholder' : '✗ Mismatch';
          resultEl.style.color = 'var(--error)';
          breakdown.textContent = res.reason === 'empty_or_placeholder'
            ? 'Empty / NA / #N/A placeholder.'
            : 'Does not match the configured segment structure.';
        }
      }
    };

    // Attach listeners on the section's inputs/buttons. Delegated so newly
    // added segment rows pick them up automatically.
    rootEl.addEventListener('input',   refresh);
    rootEl.addEventListener('change',  refresh);

    rootEl.addEventListener('click', (e) => {
      const row = e.target.closest('.sku-seg-row');
      if (e.target.matches('[data-sku-add-seg]')) {
        _snapshotSegments(rootEl);
        const segs = JSON.parse(rootEl.dataset.segments);
        segs.push(_defaultSegmentForType('free_text'));
        rootEl.dataset.segments = JSON.stringify(segs);
        _renderSegmentList(rootEl);
        refresh();
        return;
      }
      if (!row) return;
      if (e.target.matches('[data-seg-del]')) {
        _snapshotSegments(rootEl);
        const segs = JSON.parse(rootEl.dataset.segments).filter(s => s.id !== row.dataset.segId);
        rootEl.dataset.segments = JSON.stringify(segs);
        _renderSegmentList(rootEl); refresh();
        return;
      }
      if (e.target.matches('[data-seg-up]') || e.target.matches('[data-seg-down]')) {
        _snapshotSegments(rootEl);
        const segs = JSON.parse(rootEl.dataset.segments);
        const idx  = segs.findIndex(s => s.id === row.dataset.segId);
        const delta = e.target.matches('[data-seg-up]') ? -1 : 1;
        const tgt = idx + delta;
        if (tgt < 0 || tgt >= segs.length) return;
        [segs[idx], segs[tgt]] = [segs[tgt], segs[idx]];
        rootEl.dataset.segments = JSON.stringify(segs);
        _renderSegmentList(rootEl); refresh();
      }
    });

    // Re-render segment row when its type changes (different detail control).
    rootEl.addEventListener('change', (e) => {
      if (!e.target.matches('[data-seg-type]')) return;
      _snapshotSegments(rootEl);
      _renderSegmentList(rootEl);
      refresh();
    });

    _renderSegmentList(rootEl);
    refresh();
  }

  /* ── Users: load ────────────────────────────────────────── */
  // Global list (Settings is org-neutral). Columns:
  //   Name | Username | Role (global) | Organizations (dropdown) | Actions (Edit)
  async function loadUsers() {
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;
    tbody.innerHTML = Loading.tableRows(5, 5);
    try {
      const users  = await API.getUsers();
      _usersCache  = users;
      if (!users.length) {
        tbody.innerHTML = `<tr><td colspan="5">${Loading.empty('users', 'No users yet', 'Add a new user to get started')}</td></tr>`;
        return;
      }
      const myUserId = Auth.getUser()?.user_id;
      tbody.innerHTML = users.map(u => {
        const uid       = Utils.escapeHtml(u.user_id || '');
        const dname     = Utils.escapeHtml(u.display_name || u.username || '?');
        const initial   = (u.display_name || u.username || '?')[0].toUpperCase();
        const isSelf    = u.user_id === myUserId;
        const isActive  = u.is_active !== false;
        const role      = u.role || 'viewer';
        const roleLabel = ROLE_LABEL[role] || Utils.capitalize(role);

        const memberships = Array.isArray(u.memberships) ? u.memberships : [];
        // Button + JS-positioned popover. The popover uses position:fixed so
        // it escapes the .table-wrap overflow:auto that would otherwise clip
        // a position:absolute dropdown. Click anywhere outside to close.
        const orgNamesAttr = Utils.escapeHtml(JSON.stringify(memberships.map(m => m.org_name || m.organization_id)));
        const orgsHtml = memberships.length === 0
          ? `<span style="font-size:12px;color:var(--txt-4);font-style:italic">No memberships</span>`
          : `<button type="button" class="user-orgs-trigger" data-orgs-popover='${orgNamesAttr}'>
               <span>${memberships.length} ${memberships.length === 1 ? 'organization' : 'organizations'}</span>
               <i data-lucide="chevron-down" class="icon user-orgs-chevron" aria-hidden="true"></i>
             </button>`;

        const inactiveTag = isActive ? '' : '<span class="user-inactive-tag" title="Account is deactivated">DEACTIVATED</span>';

        return `<tr data-user-id="${uid}"${!isActive ? ' class="user-row-inactive"' : ''}>
          <td>
            <div style="display:flex;align-items:center;gap:8px">
              <div class="user-avatar-sm">${initial}</div>
              <span style="font-weight:500">${dname}</span>
              ${isSelf ? '<span class="user-self-tag">You</span>' : ''}
              ${inactiveTag}
            </div>
          </td>
          <td><span style="font-size:12px;color:var(--txt-3);font-family:monospace">@${Utils.escapeHtml(u.username || '—')}</span></td>
          <td><span class="user-role-text">${Utils.escapeHtml(roleLabel)}</span></td>
          <td>${orgsHtml}</td>
          <td>
            <button class="btn btn-secondary btn-sm" data-action="edit-user" data-id="${uid}" title="Edit user">
              <i data-lucide="pencil" class="icon" style="width:13px;height:13px"></i> Edit
            </button>
          </td>
        </tr>`;
      }).join('');
      _wireOrgsPopover();
      Icons?.refresh?.();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5">${Loading.error('Failed to load users')}</td></tr>`;
      Notify.apiError(err);
    }
  }

  /* ── Users: add new ─────────────────────────────────────── */
  async function _openAddNewUserModal() {
    // Fetch the full org list up-front. Settings is org-neutral — we do NOT
    // pre-select the admin's current workspace. The admin chooses explicitly.
    let allOrgs = [];
    try {
      allOrgs = await API.getOrganizations();
    } catch (err) {
      Notify.apiError(err);
      return;
    }
    const assignableOrgs = (allOrgs || []).filter(o => o.is_active);

    const m = new Modal({ title: 'Add New User', maxWidth: '480px' });
    m.setBody(`
      <form data-form="user" autocomplete="off">
        <div class="form-group">
          <label class="form-label">Display Name <span class="req">*</span></label>
          <input class="form-input" data-field="display" placeholder="Full name" autocomplete="off">
        </div>

        <div class="form-group">
          <label class="form-label">Username <span class="req">*</span></label>
          <input class="form-input" data-field="username" placeholder="login handle (e.g. john_doe)" autocomplete="off">
          <div class="form-hint">Unique across the platform. 2–32 chars: lowercase letters, numbers, underscores.</div>
          <div data-field="username-status" style="margin-top:6px;font-size:12px;display:none"></div>
        </div>

        <div class="form-group">
          <label class="form-label">Password <span class="req">*</span></label>
          <input class="form-input" data-field="password" type="password" placeholder="Minimum 8 characters" autocomplete="new-password">
        </div>

        <div class="form-group">
          <label class="form-label">Role <span class="req">*</span></label>
          <select class="form-select" data-field="role">${_roleOptions('viewer')}</select>
          <div class="form-hint">Applied to every assigned organization.</div>
        </div>

        <div class="form-group">
          <label class="form-label">Organizations <span class="req">*</span></label>
          <div class="multiselect" data-field="orgs" data-ms-noun="organizations" data-ms-placeholder="Select organizations…">
            <button type="button" class="multiselect-trigger" data-ms-trigger>
              <span class="multiselect-label" data-ms-label>Select organizations…</span>
              <i data-lucide="chevron-down" class="multiselect-chevron" aria-hidden="true"></i>
            </button>
            <div class="multiselect-panel" data-ms-panel>
              ${assignableOrgs.length === 0
                ? '<div class="multiselect-empty">No active organizations available.</div>'
                : assignableOrgs.map(o => `
                  <label class="multiselect-option">
                    <input type="checkbox" value="${Utils.escapeHtml(o.organization_id)}">
                    <span class="multiselect-option-name">${Utils.escapeHtml(o.display_name)}</span>
                  </label>`).join('')}
            </div>
          </div>
          <div class="form-hint">Assign the user to at least one organization. Roles apply across all selected orgs.</div>
        </div>

        <div data-field="error" class="form-error" style="display:none"></div>
      </form>`);
    m.setFooter(`
      <button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" data-action="save">Create User</button>`);
    m.show();

    // CRITICAL: scope all lookups to the modal's body/footer. Multiple modals
    // can coexist in the DOM (Modal.hide() doesn't remove them), so global
    // document.getElementById would return the FIRST match — usually a stale
    // ghost from a previous modal. Querying inside the live modal's own
    // elements avoids that entirely.
    const q  = sel => m.bodyEl.querySelector(sel);
    const qf = sel => m.footerEl.querySelector(sel);

    // Destroy on hide so we don't accumulate duplicate-ID nodes.
    const _hideAndDestroy = () => { m.hide(); m.destroy(); };

    qf('[data-action="cancel"]')?.addEventListener('click', _hideAndDestroy);
    qf('[data-action="save"]')?.addEventListener('click', () => _doCreateUser(m, q, qf));
    q('[data-form="user"]')?.addEventListener('submit', e => { e.preventDefault(); _doCreateUser(m, q, qf); });

    _wireUsernameCheck(q);
    _wireMultiselect(q('[data-field="orgs"]'));
  }

  // Multi-select dropdown: click-to-open, position:fixed panel with checkboxes.
  // The panel overlays surrounding content (does NOT grow the form), so opening
  // it never reflows the modal layout. JS computes the trigger's viewport
  // coordinates and anchors the panel below it (or flipped above if it'd run
  // off the viewport).
  //
  // Noun for the label is taken from `data-ms-noun` on the root.
  function _wireMultiselect(root) {
    if (!root) return;
    const trigger = root.querySelector('[data-ms-trigger]');
    const panel   = root.querySelector('[data-ms-panel]');
    const label   = root.querySelector('[data-ms-label]');
    if (!trigger || !panel || !label) return;

    const noun = root.dataset.msNoun || 'items';
    const placeholder = root.dataset.msPlaceholder || `Select ${noun}…`;

    const updateLabel = () => {
      const checked = Array.from(panel.querySelectorAll('input[type=checkbox]:checked'));
      if (!checked.length) {
        label.textContent = placeholder;
        label.classList.remove('multiselect-label-active');
        return;
      }
      label.classList.add('multiselect-label-active');
      const names = checked.map(cb => cb.closest('.multiselect-option')?.querySelector('.multiselect-option-name')?.textContent || '');
      label.textContent = checked.length === 1
        ? names[0]
        : `${checked.length} ${noun} selected`;
    };

    // Position the panel using fixed coordinates derived from the trigger's
    // viewport rect. Re-run on every open + on scroll/resize while open.
    const positionPanel = () => {
      const rect = trigger.getBoundingClientRect();
      const panelWidth = rect.width;             // match trigger width
      panel.style.width = `${panelWidth}px`;
      const panelHeight = Math.min(260, panel.scrollHeight || 260);
      let top = rect.bottom + 6;
      // Flip above if it would clip the viewport bottom.
      if (top + panelHeight > window.innerHeight - 8) {
        top = Math.max(8, rect.top - panelHeight - 6);
      }
      panel.style.top  = `${top}px`;
      panel.style.left = `${rect.left}px`;
    };

    const open  = () => {
      positionPanel();
      root.classList.add('is-open');
    };
    const close = () => root.classList.remove('is-open');
    const toggle = () => (root.classList.contains('is-open') ? close() : open());

    trigger.addEventListener('click', e => { e.stopPropagation(); toggle(); });
    panel.addEventListener('click', e => e.stopPropagation());
    panel.addEventListener('change', e => {
      if (e.target?.matches('input[type=checkbox]')) updateLabel();
    });

    // Close on outside click or Esc.
    document.addEventListener('click', e => {
      if (!root.contains(e.target) && !panel.contains(e.target)) close();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
    });

    // Reposition (or close) on viewport changes while open so the panel
    // stays anchored to its trigger.
    window.addEventListener('scroll',  () => { if (root.classList.contains('is-open')) positionPanel(); }, true);
    window.addEventListener('resize',  () => { if (root.classList.contains('is-open')) positionPanel(); });

    updateLabel();
  }

  // Tracks the last username verified as available. Submit is blocked unless
  // the typed value matches this exactly.
  let _validatedUsername = null;

  function _wireUsernameCheck(q) {
    const input    = q('[data-field="username"]');
    const statusEl = q('[data-field="username-status"]');
    if (!input || !statusEl) {
      console.warn('[username-check] could not find input/status inside modal');
      return;
    }

    let timer = null;
    let seq   = 0;

    const setStatus = (html, color) => {
      statusEl.innerHTML     = html;
      statusEl.style.color   = color || 'var(--txt-3)';
      statusEl.style.display = html ? 'block' : 'none';
    };

    const onChange = () => {
      clearTimeout(timer);
      const raw = input.value.trim().toLowerCase();
      _validatedUsername = null;

      if (!raw) { setStatus('', ''); return; }
      if (raw.length < 2) {
        setStatus('Username must be at least 2 characters.', 'var(--warning)');
        return;
      }
      setStatus(`<span style="opacity:.7">Checking availability…</span>`, 'var(--txt-3)');

      const mySeq = ++seq;
      timer = setTimeout(async () => {
        try {
          const res = await API.checkUsername(raw);
          if (mySeq !== seq) return;
          if (!res.valid) {
            setStatus(`✗ Invalid: must be 2–32 chars, lowercase letters/numbers/underscores only.`, 'var(--error)');
          } else if (res.available) {
            _validatedUsername = res.username;
            setStatus(`✓ <strong>${Utils.escapeHtml(res.username)}</strong> is available.`, 'var(--success)');
          } else {
            const sugs = (res.suggestions || []).slice(0, 5);
            const sugHtml = sugs.length
              ? ` Try: ${sugs.map(s => `<a href="#" data-suggest="${Utils.escapeHtml(s)}" style="color:var(--primary);font-weight:600;text-decoration:underline;margin-right:8px">${Utils.escapeHtml(s)}</a>`).join('')}`
              : '';
            setStatus(`✗ <strong>${Utils.escapeHtml(res.username)}</strong> is taken.${sugHtml}`, 'var(--error)');
            statusEl.querySelectorAll('[data-suggest]').forEach(a => {
              a.addEventListener('click', e => {
                e.preventDefault();
                input.value = a.dataset.suggest;
                onChange();
              });
            });
          }
        } catch (err) {
          if (mySeq !== seq) return;
          const msg = err.status === 404
            ? 'Username check endpoint not available — backend needs redeploy.'
            : (err.message || 'try again');
          setStatus(`<span style="color:var(--txt-4)">Could not verify — ${Utils.escapeHtml(msg)}</span>`, '');
        }
      }, 350);
    };

    input.addEventListener('input', onChange);
  }

  async function _doCreateUser(m, q, qf) {
    const display  = q('[data-field="display"]')?.value.trim();
    const username = q('[data-field="username"]')?.value.trim().toLowerCase();
    const password = q('[data-field="password"]')?.value;
    const role     = q('[data-field="role"]')?.value;
    const orgIds   = Array.from(q('[data-field="orgs"]')?.querySelectorAll('input[type=checkbox]:checked') || []).map(cb => cb.value);
    const errEl    = q('[data-field="error"]');
    const saveBtn  = qf('[data-action="save"]');
    const showErr  = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!display)                          return showErr('Display name is required.');
    if (!username)                         return showErr('Username is required.');
    if (_validatedUsername !== username)   return showErr('Please wait for the username availability check to finish, or pick a different username.');
    if (!password || password.length < 8)  return showErr('Password must be at least 8 characters.');
    if (!role)                             return showErr('Please select a role.');
    if (!orgIds.length)                    return showErr('Assign the user to at least one organization.');

    if (errEl) errEl.style.display = 'none';
    Loading.btn(saveBtn, true);
    try {
      await API.createUser({
        display_name:      display,
        username,
        password,
        role,
        organization_ids:  orgIds,
      });
      Notify.success('User created', `${display} has been added to ${orgIds.length} organization${orgIds.length > 1 ? 's' : ''}.`);
      m.hide();
      m.destroy();
      loadUsers();
    } catch (err) {
      const msg = err.status === 404
        ? 'Server endpoint not found — backend needs to be redeployed.'
        : (err.message || 'Failed to create user.');
      showErr(msg);
    } finally {
      Loading.btn(saveBtn, false);
    }
  }

  /* ── Users: add existing ────────────────────────────────── */
  function _openAddExistingModal() {
    const m = new Modal({ title: 'Assign Existing User to Org', maxWidth: '440px' });
    m.setBody(`
      <p style="font-size:13px;color:var(--txt-3);margin-bottom:14px">
        Search for a user already in the system and assign them to this organization.
      </p>
      <div class="form-group">
        <label class="form-label">Username <span class="req">*</span></label>
        <div style="display:flex;gap:8px">
          <input class="form-input" id="ae-username" placeholder="Exact username" style="flex:1" autocomplete="off">
          <button class="btn btn-secondary btn-sm" id="ae-search-btn">Find</button>
        </div>
      </div>
      <div id="ae-found" style="display:none;padding:10px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);margin-bottom:10px">
        <div style="font-weight:600;font-size:13px;color:var(--txt-1)" id="ae-found-name"></div>
        <div style="font-size:12px;color:var(--txt-3)" id="ae-found-username"></div>
      </div>
      <div id="ae-role-wrap" class="form-group" style="display:none">
        <label class="form-label">Role in this organization</label>
        <select class="form-select" id="ae-role">${_roleOptions('viewer')}</select>
      </div>
      <div id="ae-error" class="form-error" style="display:none"></div>`);
    m.setFooter(`
      <button class="btn btn-secondary btn-sm" id="ae-cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="ae-add-btn" disabled>Assign to Org</button>`);
    m.show();

    let _foundUserId = null;
    const errEl  = () => document.getElementById('ae-error');
    const showErr = msg => { const e = errEl(); if (e) { e.textContent = msg; e.style.display = 'block'; } };
    const hideErr = ()  => { const e = errEl(); if (e) e.style.display = 'none'; };

    document.getElementById('ae-cancel')?.addEventListener('click', () => m.hide());

    const addBtn = document.getElementById('ae-add-btn');

    async function _doSearch() {
      const username = document.getElementById('ae-username')?.value.trim().toLowerCase().replace(/^@/, '');
      if (!username) return showErr('Enter a username to search.');
      hideErr();
      const searchBtn = document.getElementById('ae-search-btn');
      Loading.btn(searchBtn, true);
      _foundUserId = null;
      if (addBtn) addBtn.disabled = true;
      document.getElementById('ae-found').style.display     = 'none';
      document.getElementById('ae-role-wrap').style.display = 'none';
      try {
        const user = await API.searchUser(username);
        _foundUserId = user.user_id;
        document.getElementById('ae-found-name').textContent     = user.display_name || user.username;
        document.getElementById('ae-found-username').textContent = '@' + user.username;
        document.getElementById('ae-found').style.display        = 'block';
        document.getElementById('ae-role-wrap').style.display    = 'block';
        if (addBtn) addBtn.disabled = false;
      } catch (err) {
        showErr(err.status === 404 ? `No user found with username "${username}".` : (err.message || 'Search failed.'));
      } finally {
        Loading.btn(searchBtn, false);
      }
    }

    document.getElementById('ae-search-btn')?.addEventListener('click', _doSearch);
    document.getElementById('ae-username')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); _doSearch(); }
    });

    addBtn?.addEventListener('click', async () => {
      if (!_foundUserId) return;
      const role = document.getElementById('ae-role')?.value;
      hideErr();
      Loading.btn(addBtn, true);
      try {
        await API.addMembership(_foundUserId, role);
        Notify.success('User assigned', 'User has been added to this organization.');
        m.hide();
        loadUsers();
      } catch (err) {
        showErr(err.message || 'Failed to assign user.');
        Loading.btn(addBtn, false);
      }
    });
  }

  // Singleton popover element for the Users table's "N organizations"
  // dropdown. Uses position:fixed so it isn't clipped by the .table-wrap
  // overflow that the row sits inside.
  let _orgsPopoverEl = null;

  function _closeOrgsPopover() {
    if (_orgsPopoverEl) { _orgsPopoverEl.remove(); _orgsPopoverEl = null; }
  }

  function _wireOrgsPopover() {
    document.querySelectorAll('[data-orgs-popover]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const wasOpen = btn.classList.contains('is-open');
        document.querySelectorAll('.user-orgs-trigger.is-open').forEach(b => b.classList.remove('is-open'));
        _closeOrgsPopover();
        if (wasOpen) return;

        let names = [];
        try { names = JSON.parse(btn.dataset.orgsPopover) || []; } catch {}
        if (!names.length) return;

        const pop = document.createElement('div');
        pop.className = 'user-orgs-popover';
        pop.innerHTML = `<ul>${names.map(n => `<li>${Utils.escapeHtml(n)}</li>`).join('')}</ul>`;
        document.body.appendChild(pop);

        // Position relative to the button using viewport coords (fixed).
        const rect = btn.getBoundingClientRect();
        const popRect = pop.getBoundingClientRect();
        let top  = rect.bottom + 4;
        let left = rect.left;
        // If it would clip the bottom of the viewport, flip above the button.
        if (top + popRect.height > window.innerHeight - 8) {
          top = Math.max(8, rect.top - popRect.height - 4);
        }
        // Keep within the right edge.
        if (left + popRect.width > window.innerWidth - 8) {
          left = Math.max(8, window.innerWidth - popRect.width - 8);
        }
        pop.style.top  = `${top}px`;
        pop.style.left = `${left}px`;

        btn.classList.add('is-open');
        _orgsPopoverEl = pop;
      });
    });

    // One outside-click handler is enough — re-bind on every render is fine
    // because we replace the listener target each time.
    document.addEventListener('click', _onDocClickForOrgs, { once: true, capture: false });
  }

  function _onDocClickForOrgs(e) {
    if (_orgsPopoverEl && !_orgsPopoverEl.contains(e.target) && !e.target.closest('[data-orgs-popover]')) {
      document.querySelectorAll('.user-orgs-trigger.is-open').forEach(b => b.classList.remove('is-open'));
      _closeOrgsPopover();
    }
    document.addEventListener('click', _onDocClickForOrgs, { once: true });
  }

  // Close popover on scroll (otherwise it floats over content as the table scrolls).
  document.addEventListener('scroll', () => {
    if (_orgsPopoverEl) {
      document.querySelectorAll('.user-orgs-trigger.is-open').forEach(b => b.classList.remove('is-open'));
      _closeOrgsPopover();
    }
  }, true);

  /* ── Users: edit (consolidated) ─────────────────────────── */
  // Single modal that handles every per-user mutation:
  //   - display_name
  //   - role (admin / manager / viewer)
  //   - organization memberships (multi-select, must have ≥1)
  //   - password (optional — leave blank to keep current)
  //   - active status (Active / Inactive)
  //
  // The admin cannot demote themselves out of admin or deactivate themselves.
  async function _openEditUserModal(userId) {
    const user = _usersCache.find(u => u.user_id === userId);
    if (!user) return;
    const myUserId = Auth.getUser()?.user_id;
    const isSelf   = user.user_id === myUserId;

    // Fetch full org list for the multi-select.
    let allOrgs = [];
    try {
      allOrgs = (await API.getOrganizations() || []).filter(o => o.is_active);
    } catch (err) {
      Notify.apiError(err);
      return;
    }

    const memberOrgIds = new Set((user.memberships || []).map(m => m.organization_id));
    const currentRole  = user.role || 'viewer';
    const isActive     = user.is_active !== false;

    const m = new Modal({ title: `Edit User: ${user.display_name || user.username}`, maxWidth: '500px' });
    m.setBody(`
      <form data-form="edit-user" autocomplete="off">

        <div class="form-group">
          <label class="form-label">Display Name <span class="req">*</span></label>
          <input class="form-input" data-field="display" value="${Utils.escapeHtml(user.display_name || '')}" autocomplete="off">
        </div>

        <div class="form-group">
          <label class="form-label">Username</label>
          <div style="padding:8px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);font-size:13px;color:var(--txt-3);font-family:monospace">
            @${Utils.escapeHtml(user.username || '')}
          </div>
          <div class="form-hint">Username cannot be changed.</div>
        </div>

        <div class="form-group">
          <label class="form-label">Role <span class="req">*</span></label>
          <select class="form-select" data-field="role"${isSelf ? ' disabled' : ''}>
            ${_roleOptions(currentRole)}
          </select>
          ${isSelf ? '<div class="form-hint">You cannot change your own role.</div>' : '<div class="form-hint">Applies platform-wide across every assigned organization.</div>'}
        </div>

        <div class="form-group">
          <label class="form-label">Organizations <span class="req">*</span></label>
          <div class="multiselect" data-field="orgs" data-ms-noun="organizations" data-ms-placeholder="Select organizations…">
            <button type="button" class="multiselect-trigger" data-ms-trigger>
              <span class="multiselect-label" data-ms-label>Select organizations…</span>
              <i data-lucide="chevron-down" class="multiselect-chevron" aria-hidden="true"></i>
            </button>
            <div class="multiselect-panel" data-ms-panel>
              ${allOrgs.length === 0
                ? '<div class="multiselect-empty">No active organizations available.</div>'
                : allOrgs.map(o => `
                  <label class="multiselect-option">
                    <input type="checkbox" value="${Utils.escapeHtml(o.organization_id)}"${memberOrgIds.has(o.organization_id) ? ' checked' : ''}>
                    <span class="multiselect-option-name">${Utils.escapeHtml(o.display_name)}</span>
                  </label>`).join('')}
            </div>
          </div>
          <div class="form-hint">Must belong to at least one organization. Removing an org deactivates the membership (data is preserved).</div>
        </div>

        <div class="form-group">
          <label class="form-label">Change Password (optional)</label>
          <input class="form-input" data-field="new-password" type="password" placeholder="Leave blank to keep current password" autocomplete="new-password">
          <input class="form-input" data-field="confirm-password" type="password" placeholder="Confirm new password" autocomplete="new-password" style="margin-top:6px">
          <div class="form-hint">Minimum 8 characters. Only fills if both fields match.</div>
        </div>

        <div class="form-group">
          <label class="form-label">Account Status</label>
          <select class="form-select" data-field="status"${isSelf ? ' disabled' : ''}>
            <option value="true"  ${isActive  ? 'selected' : ''}>Active</option>
            <option value="false" ${!isActive ? 'selected' : ''}>Inactive (cannot log in)</option>
          </select>
          ${isSelf ? '<div class="form-hint">You cannot deactivate your own account.</div>' : '<div class="form-hint">Inactive users cannot log in. All memberships are preserved.</div>'}
        </div>

        <div data-field="error" class="form-error" style="display:none"></div>
      </form>`);

    m.setFooter(`
      <button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" data-action="save">Save Changes</button>`);
    m.show();

    const q  = sel => m.bodyEl.querySelector(sel);
    const qf = sel => m.footerEl.querySelector(sel);
    const _hideAndDestroy = () => { m.hide(); m.destroy(); };

    qf('[data-action="cancel"]')?.addEventListener('click', _hideAndDestroy);
    qf('[data-action="save"]')?.addEventListener('click', () => _doEditUser(m, q, qf, userId, isSelf));
    q('[data-form="edit-user"]')?.addEventListener('submit', e => { e.preventDefault(); _doEditUser(m, q, qf, userId, isSelf); });

    _wireMultiselect(q('[data-field="orgs"]'));
    Icons?.refresh?.();
  }

  async function _doEditUser(m, q, qf, userId, isSelf) {
    const display     = q('[data-field="display"]')?.value.trim();
    const roleSel     = q('[data-field="role"]');
    const role        = roleSel?.disabled ? undefined : roleSel?.value;
    const statusSel   = q('[data-field="status"]');
    const isActiveStr = statusSel?.disabled ? undefined : statusSel?.value;
    const isActive    = isActiveStr === undefined ? undefined : isActiveStr === 'true';
    const newPwd      = q('[data-field="new-password"]')?.value;
    const confirmPwd  = q('[data-field="confirm-password"]')?.value;
    const orgIds      = Array.from(q('[data-field="orgs"]')?.querySelectorAll('input[type=checkbox]:checked') || []).map(cb => cb.value);

    const errEl   = q('[data-field="error"]');
    const saveBtn = qf('[data-action="save"]');
    const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!display)         return showErr('Display name is required.');
    if (!orgIds.length)   return showErr('User must belong to at least one organization.');

    const payload = { display_name: display, organization_ids: orgIds };
    if (role        !== undefined) payload.role      = role;
    if (isActive    !== undefined) payload.is_active = isActive;

    if (newPwd || confirmPwd) {
      if (!newPwd || newPwd.length < 8) return showErr('New password must be at least 8 characters.');
      if (newPwd !== confirmPwd)        return showErr('New password and confirmation do not match.');
      payload.password = newPwd;
    }

    if (errEl) errEl.style.display = 'none';
    Loading.btn(saveBtn, true);
    try {
      await API.updateUser(userId, payload);
      Notify.success('User updated', isSelf ? 'Your profile has been saved.' : 'Changes saved.');
      m.hide();
      m.destroy();
      loadUsers();
    } catch (err) {
      showErr(err.message || 'Failed to save.');
    } finally {
      Loading.btn(saveBtn, false);
    }
  }

  /* ── Organizations: load ────────────────────────────────── */
  async function loadOrganizations() {
    const tbody = document.getElementById('orgs-tbody');
    if (!tbody) return;
    tbody.innerHTML = Loading.tableRows(5, 5);
    try {
      const orgs = await API.getOrganizations();
      _orgsCache  = orgs;
      if (!orgs.length) {
        tbody.innerHTML = `<tr><td colspan="5">${Loading.empty('building-2', 'No organizations', 'Create the first organization to get started')}</td></tr>`;
        return;
      }
      const currentOrgId = Auth.getOrganization()?.organization_id;
      tbody.innerHTML = orgs.map(o => {
        const oid      = Utils.escapeHtml(o.organization_id);
        const oname    = Utils.escapeHtml(o.display_name);
        const isHere   = o.organization_id === currentOrgId;
        const isActive = o.is_active !== false;
        const struct   = SkuEngine?.coerceToV2(o.sku_structure);
        const skuCell  = struct?.enabled && struct.segments?.length
          ? `<span style="font-family:monospace;font-size:11.5px;color:var(--txt-2)" title="${Utils.escapeHtml(struct.compiled || '')}">${Utils.escapeHtml(SkuEngine.summarizeStructure(struct))}</span>`
          : `<span style="font-size:11px;color:var(--error);font-weight:600">Not configured</span>`;
        return `<tr data-org-id="${oid}"${!isActive ? ' class="user-row-inactive"' : ''}>
          <td>
            <span style="font-weight:600">${oname}</span>
            ${isHere ? '<span style="font-size:11px;color:var(--primary);margin-left:6px;font-weight:600">● current</span>' : ''}
          </td>
          <td style="font-size:12px;color:var(--txt-4);font-family:monospace">${Utils.escapeHtml(o.slug)}</td>
          <td>${skuCell}</td>
          <td>${isActive ? Utils.badgeHtml('success', 'Active') : Utils.badgeHtml('gray', 'Deactivated')}</td>
          <td>
            <button class="btn btn-secondary btn-sm" data-action="edit-org" data-id="${oid}" title="Edit organization">
              <i data-lucide="pencil" class="icon" style="width:13px;height:13px"></i> Edit
            </button>
          </td>
        </tr>`;
      }).join('');
      Icons?.refresh?.();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5">${Loading.error('Failed to load organizations')}</td></tr>`;
      Notify.apiError(err);
    }
  }

  /* ── Organizations: New (create) ────────────────────────── */
  async function _openNewOrgModal() {
    // Load active users for the member picker.
    let allUsers = [];
    try {
      allUsers = (await API.getUsers() || []).filter(u => u.is_active !== false);
    } catch (err) {
      Notify.apiError(err);
      return;
    }
    const myUserId = Auth.getUser()?.user_id;

    const m = new Modal({ title: 'New Organization', maxWidth: '480px' });
    m.setBody(`
      <form data-form="new-org" autocomplete="off">
        <div class="form-group">
          <label class="form-label">Display Name <span class="req">*</span></label>
          <input class="form-input" data-field="name" placeholder="e.g. Patman Warehouse">
        </div>
        <div class="form-group">
          <label class="form-label">Slug <span class="req">*</span></label>
          <input class="form-input" data-field="slug" placeholder="e.g. patman-warehouse" pattern="[-a-z0-9]+">
          <div class="form-hint">Lowercase letters, numbers, hyphens only. Cannot be changed after creation.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Assign Members <span class="req">*</span></label>
          <div class="multiselect" data-field="members" data-ms-noun="members" data-ms-placeholder="Select members…">
            <button type="button" class="multiselect-trigger" data-ms-trigger>
              <span class="multiselect-label" data-ms-label>Select members…</span>
              <i data-lucide="chevron-down" class="multiselect-chevron" aria-hidden="true"></i>
            </button>
            <div class="multiselect-panel" data-ms-panel>
              ${allUsers.length === 0
                ? '<div class="multiselect-empty">No active users available.</div>'
                : allUsers.map(u => {
                    const isMe = u.user_id === myUserId;
                    return `
                      <label class="multiselect-option">
                        <input type="checkbox" value="${Utils.escapeHtml(u.user_id)}"${isMe ? ' checked' : ''}>
                        <span class="multiselect-option-name">${Utils.escapeHtml(u.display_name || u.username)}${isMe ? ' (you)' : ''}</span>
                      </label>`;
                  }).join('')}
            </div>
          </div>
          <div class="form-hint">At least one member is required. You're pre-selected so you keep access to manage the new org.</div>
        </div>
        ${_renderSkuStructureSection(null)}
        <div data-field="error" class="form-error" style="display:none"></div>
      </form>`);
    m.setFooter(`
      <button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" data-action="save">Create Organization</button>`);
    m.show();

    const q  = sel => m.bodyEl.querySelector(sel);
    const qf = sel => m.footerEl.querySelector(sel);
    const _hideAndDestroy = () => { m.hide(); m.destroy(); };

    // Auto-derive slug from name as user types (until they manually edit slug).
    const nameEl = q('[data-field="name"]');
    const slugEl = q('[data-field="slug"]');
    nameEl?.addEventListener('input', e => {
      const auto = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (slugEl && !slugEl.dataset.edited) slugEl.value = auto;
    });
    slugEl?.addEventListener('input', e => { e.target.dataset.edited = '1'; });

    qf('[data-action="cancel"]')?.addEventListener('click', _hideAndDestroy);
    qf('[data-action="save"]')?.addEventListener('click', () => _doCreateOrg(m, q, qf));
    q('[data-form="new-org"]')?.addEventListener('submit', e => { e.preventDefault(); _doCreateOrg(m, q, qf); });
    _wireMultiselect(q('[data-field="members"]'));
    _wireSkuStructureSection(q('[data-sku-structure]'));
    Icons?.refresh?.();
  }

  async function _doCreateOrg(m, q, qf) {
    const name    = q('[data-field="name"]')?.value.trim();
    const slug    = q('[data-field="slug"]')?.value.trim();
    const userIds = Array.from(q('[data-field="members"]')?.querySelectorAll('input[type=checkbox]:checked') || []).map(cb => cb.value);
    const sku_structure = _readSkuStructureSection(q('[data-sku-structure]'));
    const errEl   = q('[data-field="error"]');
    const saveBtn = qf('[data-action="save"]');
    const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!name)                          return showErr('Display name is required.');
    if (!slug)                          return showErr('Slug is required.');
    if (!/^[-a-z0-9]+$/.test(slug))     return showErr('Slug must be lowercase letters, numbers, hyphens only.');
    if (!userIds.length)                return showErr('Assign at least one member.');

    if (errEl) errEl.style.display = 'none';
    Loading.btn(saveBtn, true);
    try {
      await API.createOrganization({ display_name: name, slug, member_user_ids: userIds, sku_structure });
      Notify.success('Organization created', `${name} is ready.`);
      m.hide();
      m.destroy();
      loadOrganizations();
    } catch (err) {
      showErr(err.message || 'Save failed.');
    } finally {
      Loading.btn(saveBtn, false);
    }
  }

  /* ── Organizations: Edit (consolidated) ─────────────────── */
  async function _openEditOrgModal(orgId) {
    const org = _orgsCache.find(o => o.organization_id === orgId);
    if (!org) return;
    const isActive = org.is_active !== false;
    const isHere   = orgId === Auth.getOrganization()?.organization_id;

    // Build the member roster: every active user, with their current
    // membership status in this org pre-checked. We use the global user
    // list (org-neutral Settings) — every user is a potential member.
    let allUsers = [];
    try {
      allUsers = await API.getUsers() || [];
    } catch (err) {
      Notify.apiError(err);
      return;
    }
    const currentMemberIds = new Set(
      allUsers
        .filter(u => Array.isArray(u.memberships) && u.memberships.some(m => m.organization_id === orgId))
        .map(u => u.user_id)
    );

    const m = new Modal({ title: `Edit Organization: ${org.display_name}`, maxWidth: '500px' });

    // Deactivated orgs render in read-only mode with a single Activate
    // action. Active orgs render the full editor with Save + Deactivate.
    if (!isActive) {
      m.setBody(`
        <div class="org-edit-deactivated-banner">
          <i data-lucide="alert-octagon" class="icon" style="width:18px;height:18px"></i>
          <div>
            <strong>This organization is deactivated.</strong>
            <div style="font-size:12.5px;color:var(--txt-3);margin-top:2px">
              Members cannot access it. Reactivate to resume editing details and roster.
            </div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Display Name</label>
          <div class="form-readonly">${Utils.escapeHtml(org.display_name)}</div>
        </div>
        <div class="form-group">
          <label class="form-label">Slug</label>
          <div class="form-readonly" style="font-family:monospace">${Utils.escapeHtml(org.slug)}</div>
        </div>
        <div data-field="error" class="form-error" style="display:none"></div>`);
      m.setFooter(`
        <button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
        <button class="btn btn-primary btn-sm" data-action="activate">Activate Organization</button>`);
    } else {
      m.setBody(`
        <form data-form="edit-org" autocomplete="off">
          <div class="form-group">
            <label class="form-label">Display Name <span class="req">*</span></label>
            <input class="form-input" data-field="name" value="${Utils.escapeHtml(org.display_name)}">
          </div>
          <div class="form-group">
            <label class="form-label">Slug</label>
            <div class="form-readonly" style="font-family:monospace">${Utils.escapeHtml(org.slug)}</div>
            <div class="form-hint">Slug is locked after creation.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Members <span class="req">*</span></label>
            <div class="multiselect" data-field="members" data-ms-noun="members" data-ms-placeholder="Select members…">
              <button type="button" class="multiselect-trigger" data-ms-trigger>
                <span class="multiselect-label" data-ms-label>Select members…</span>
                <i data-lucide="chevron-down" class="multiselect-chevron" aria-hidden="true"></i>
              </button>
              <div class="multiselect-panel" data-ms-panel>
                ${allUsers.length === 0
                  ? '<div class="multiselect-empty">No users available.</div>'
                  : allUsers.map(u => {
                      const checked = currentMemberIds.has(u.user_id);
                      const inactive = u.is_active === false;
                      return `
                        <label class="multiselect-option"${inactive ? ' style="opacity:.55"' : ''}>
                          <input type="checkbox" value="${Utils.escapeHtml(u.user_id)}"${checked ? ' checked' : ''}${inactive ? ' disabled' : ''}>
                          <span class="multiselect-option-name">${Utils.escapeHtml(u.display_name || u.username)}${inactive ? ' (deactivated)' : ''}</span>
                        </label>`;
                    }).join('')}
              </div>
            </div>
            <div class="form-hint">At least one active member is required. Removing a user deactivates their membership in this org only.</div>
          </div>
          ${_renderSkuStructureSection(SkuValidator.parseStructure(org.sku_structure))}
          <div data-field="error" class="form-error" style="display:none"></div>
        </form>`);
      m.setFooter(`
        <button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
        <button class="btn btn-danger    btn-sm" data-action="deactivate"${isHere ? ' disabled title="Switch to another workspace before deactivating this one"' : ''}>Deactivate</button>
        <button class="btn btn-primary   btn-sm" data-action="save">Save Changes</button>`);
    }
    m.show();

    const q  = sel => m.bodyEl.querySelector(sel);
    const qf = sel => m.footerEl.querySelector(sel);
    const _hideAndDestroy = () => { m.hide(); m.destroy(); };

    qf('[data-action="cancel"]')?.addEventListener('click', _hideAndDestroy);
    qf('[data-action="activate"]')?.addEventListener('click', () => _doToggleOrg(m, orgId, true));
    qf('[data-action="deactivate"]')?.addEventListener('click', () => _doDeactivateOrg(m, orgId, org.display_name));
    qf('[data-action="save"]')?.addEventListener('click', () => _doSaveOrg(m, q, qf, orgId));
    q('[data-form="edit-org"]')?.addEventListener('submit', e => { e.preventDefault(); _doSaveOrg(m, q, qf, orgId); });

    if (isActive) {
      _wireMultiselect(q('[data-field="members"]'));
      _wireSkuStructureSection(q('[data-sku-structure]'));
    }
    Icons?.refresh?.();
  }

  async function _doSaveOrg(m, q, qf, orgId) {
    const name    = q('[data-field="name"]')?.value.trim();
    const userIds = Array.from(q('[data-field="members"]')?.querySelectorAll('input[type=checkbox]:checked') || []).map(cb => cb.value);
    const sku_structure = _readSkuStructureSection(q('[data-sku-structure]'));
    const errEl   = q('[data-field="error"]');
    const saveBtn = qf('[data-action="save"]');
    const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!name)            return showErr('Display name is required.');
    if (!userIds.length)  return showErr('At least one member is required.');

    if (errEl) errEl.style.display = 'none';
    Loading.btn(saveBtn, true);
    try {
      await API.updateOrganization(orgId, { display_name: name, member_user_ids: userIds, sku_structure });
      Notify.success('Organization updated');
      m.hide();
      m.destroy();
      loadOrganizations();
    } catch (err) {
      showErr(err.message || 'Save failed.');
    } finally {
      Loading.btn(saveBtn, false);
    }
  }

  async function _doDeactivateOrg(m, orgId, orgName) {
    const confirmed = await Modal.confirm({
      title:       'Deactivate Organization',
      message:     `Deactivate "${orgName}"? All members will lose access. You can reactivate it later from this Edit dialog.`,
      confirmText: 'Deactivate',
      danger:      true,
    });
    if (!confirmed) return;
    try {
      await API.updateOrganization(orgId, { is_active: false });
      Notify.success('Organization deactivated');
      m.hide();
      m.destroy();
      loadOrganizations();
    } catch (err) {
      Notify.apiError(err);
    }
  }

  async function _doToggleOrg(m, orgId, activate) {
    try {
      await API.updateOrganization(orgId, { is_active: activate });
      Notify.success(`Organization ${activate ? 'activated' : 'deactivated'}`);
      m.hide();
      m.destroy();
      loadOrganizations();
    } catch (err) {
      Notify.apiError(err);
    }
  }

  /* ── Profile tab ─────────────────────────────────────────── */
  function _initProfileTab() {
    const user = Auth.getUser();
    const org  = Auth.getOrganization();
    if (!user) return;
    Utils.setText('#profile-name',     user.display_name || user.username);
    Utils.setText('#profile-username', user.username ? `@${user.username}` : '—');
    Utils.setText('#profile-org',      org?.display_name || '—');
    Utils.setText('#profile-role',     Utils.capitalize(org?.role || '—'));
    const avatarEl = document.getElementById('profile-avatar');
    if (avatarEl) avatarEl.textContent = (user.display_name || user.username || '?')[0].toUpperCase();
  }

  /* ── System tab ─────────────────────────────────────────── */
  async function loadSystemStatus() {
    const el = document.getElementById('system-status-content');
    if (!el) return;
    el.innerHTML = `<div style="display:flex;justify-content:center;padding:24px">${Loading.spinnerHtml()}</div>`;
    try {
      const status = await API.getSystemStatus();
      el.innerHTML = `
        <div style="display:grid;gap:10px">
          ${_statusRow('Cloud Run API', 'ok', 'Connected')}
          ${_statusRow('BigQuery', status.bqStatus || 'ok', status.bqMessage || 'Connected')}
          ${_statusRow('App Version', 'info', status.version || '—')}
          ${_statusRow('Last Check', 'info', Utils.formatDatetime(status.timestamp))}
        </div>`;
    } catch (err) {
      el.innerHTML = Loading.error('Failed to load system status');
    }
  }

  function _statusRow(label, status, message) {
    const iconName  = status === 'ok' ? 'check-circle' : status === 'info' ? 'info' : 'x-circle';
    const iconColor = status === 'ok' ? 'var(--success)' : status === 'info' ? 'var(--primary)' : 'var(--error)';
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface-2);border-radius:var(--r-sm)">
        <span style="font-size:13px;font-weight:500;color:var(--txt-2)">${Utils.escapeHtml(label)}</span>
        <span style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--txt-3)">
          ${Utils.escapeHtml(message || '')}
          <i data-lucide="${iconName}" class="icon" style="width:14px;height:14px;color:${iconColor}" aria-hidden="true"></i>
        </span>
      </div>`;
  }

  /* ── Logs tab ─────────────────────────────────────────────── */
  let _logsItems   = [];
  let _logsPage    = 1;
  const _LOGS_PER  = 20;

  function _renderLogsPage() {
    const el    = document.getElementById('logs-content');
    const pagEl = document.getElementById('logs-pagination');
    if (!el) return;

    if (!_logsItems.length) {
      el.innerHTML = Loading.empty('clipboard-list', 'No activity found');
      if (pagEl) pagEl.innerHTML = '';
      return;
    }

    const total      = _logsItems.length;
    const totalPages = Math.ceil(total / _LOGS_PER);
    const start      = (_logsPage - 1) * _LOGS_PER;
    const slice      = _logsItems.slice(start, start + _LOGS_PER);

    el.innerHTML = slice.map(item => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
        <span style="color:var(--txt-4);display:flex;align-items:center">
          <i data-lucide="clock" class="icon" style="width:16px;height:16px" aria-hidden="true"></i>
        </span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;color:var(--txt-1)">${Utils.escapeHtml(item.title || item.description || '')}</div>
          <div style="font-size:11.5px;color:var(--txt-4)">${Utils.timeAgo(item.date || item.created_at || item.timestamp)}</div>
        </div>
      </div>`).join('');
    Icons.refresh();

    if (pagEl) {
      const showing = `<span class="pagination-info">Showing ${start + 1}–${Math.min(start + _LOGS_PER, total)} of ${total}</span>`;
      const prev    = `<button class="btn btn-ghost btn-sm" onclick="Settings._goLogsPage(${_logsPage - 1})"${_logsPage === 1 ? ' disabled' : ''}>&#8592; Prev</button>`;
      const next    = `<button class="btn btn-ghost btn-sm" onclick="Settings._goLogsPage(${_logsPage + 1})"${_logsPage >= totalPages ? ' disabled' : ''}>Next &#8594;</button>`;
      pagEl.innerHTML = `${showing}<div style="display:flex;gap:6px">${prev}${next}</div>`;
    }
  }

  async function loadLogs() {
    const el = document.getElementById('logs-content');
    if (!el) return;
    el.innerHTML = `<div style="display:flex;justify-content:center;padding:24px">${Loading.spinnerHtml()}</div>`;
    try {
      _logsItems = await API.getActivity(200);
      _logsPage  = 1;
      _renderLogsPage();
    } catch (err) {
      el.innerHTML = Loading.error('Failed to load activity logs');
    }
  }

  /* ── Tab init + event delegation ────────────────────────── */
  function initTabs() {
    const tabList = document.getElementById('settings-tab-list');
    if (tabList) {
      tabList.addEventListener('click', e => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;
        const tab = btn.dataset.tab;
        tabList.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('#page-settings .tab-panel').forEach(p => p.classList.remove('active'));
        document.getElementById(`tab-${tab}`)?.classList.add('active');
        if (tab === 'users')              loadUsers();
        else if (tab === 'organizations') loadOrganizations();
        else if (tab === 'system')        loadSystemStatus();
        else if (tab === 'logs')          loadLogs();
        else if (tab === 'profile')       _initProfileTab();
      });
    }

    document.getElementById('add-user-btn')?.addEventListener('click', _openAddNewUserModal);
    document.getElementById('add-existing-user-btn')?.addEventListener('click', _openAddExistingModal);
    document.getElementById('add-org-btn')?.addEventListener('click', _openNewOrgModal);

    // Users table — event delegation
    document.getElementById('users-tbody')?.addEventListener('click', e => {
      const btn    = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id     = btn.dataset.id;
      if (action === 'edit-user') _openEditUserModal(id);
      // Note: change-pwd and remove-user actions were consolidated into
      // the Edit modal. The buttons no longer exist in the rendered row.
    });

    // Orgs table — event delegation. All actions (edit / deactivate / activate)
    // live inside the Edit modal now, so this only needs the edit-org handler.
    document.getElementById('orgs-tbody')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'edit-org') _openEditOrgModal(btn.dataset.id);
    });
  }

  // Clears in-memory state — called by App.resetAllState() on org switch.
  function reset() {
    const usersTbody = document.getElementById('users-tbody');
    const orgsTbody  = document.getElementById('orgs-tbody');
    const logsList   = document.getElementById('logs-list');
    if (usersTbody) usersTbody.innerHTML = '';
    if (orgsTbody)  orgsTbody.innerHTML  = '';
    if (logsList)   logsList.innerHTML   = '';
  }

  return {
    init:         initTabs,
    loadUsers,
    loadOrganizations,
    reset,
    _goLogsPage:  p => { _logsPage = p; _renderLogsPage(); },
  };
})();

/* ── App router ─────────────────────────────────────────────── */
const App = (() => {
  const PAGES = {
    dashboard:   { label: 'Dashboard',      init: () => Dashboard.load() },
    inventory:   { label: 'Inventory List', init: () => InventoryList.load() },
    orders:      { label: 'Orders',         init: () => Orders.load() },
    uploads:     { label: 'Uploads',        init: () => Uploads.loadHistory() },
    settings:    { label: 'Settings',       init: () => Settings.loadUsers() },
    'box-lookup':{ label: 'Box Lookup',     init: () => {} },
  };

  let _currentPage  = null;
  let _initialized  = {};

  function navigate(pageId) {
    if (!PAGES[pageId]) return;

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const pageEl = document.getElementById(`page-${pageId}`);
    const navEl  = document.querySelector(`.nav-item[data-page="${pageId}"]`);

    if (pageEl) pageEl.classList.add('active');
    if (navEl)  navEl.classList.add('active');

    const topbarTitle = document.getElementById('topbar-title');
    if (topbarTitle) topbarTitle.textContent = PAGES[pageId].label;

    _currentPage = pageId;

    if (!_initialized[pageId]) {
      _initialized[pageId] = true;
      PAGES[pageId].init?.();
    } else if (pageId === 'dashboard') {
      PAGES[pageId].init?.();
    }

    window.location.hash = pageId;
  }

  function _initSidebarToggle() {
    const STORAGE_KEY = 'patman_sidebar_collapsed';
    const toggleBtn   = document.getElementById('sidebar-toggle');
    const expandBtn   = document.getElementById('sidebar-expand-btn');
    const mobileBtn   = document.getElementById('topbar-menu-btn');
    const backdrop    = document.getElementById('sidebar-backdrop');
    const MOBILE_BREAKPOINT = 768;

    const isMobile = () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;

    if (localStorage.getItem(STORAGE_KEY) === '1') {
      document.body.classList.add('sidebar-collapsed');
    }

    // Desktop/tablet collapse toggle — collapses to icon-only rail.
    const toggleDesktopCollapse = () => {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    };

    // Mobile off-canvas open/close — slides the sidebar in over the page.
    const openMobile  = () => document.body.classList.add('sidebar-mobile-open');
    const closeMobile = () => document.body.classList.remove('sidebar-mobile-open');

    toggleBtn?.addEventListener('click', () => {
      if (isMobile()) closeMobile();
      else            toggleDesktopCollapse();
    });

    expandBtn?.addEventListener('click', () => {
      if (isMobile()) closeMobile();
      else            toggleDesktopCollapse();
    });

    mobileBtn?.addEventListener('click', openMobile);
    backdrop?.addEventListener('click', closeMobile);

    // Close offcanvas after navigating on mobile so the page is visible.
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
      item.addEventListener('click', () => { if (isMobile()) closeMobile(); });
    });

    // Escape closes the mobile offcanvas.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('sidebar-mobile-open')) {
        closeMobile();
      }
    });

    // If the viewport crosses the breakpoint, drop the mobile-open state so the
    // sidebar doesn't get stuck in an inappropriate visibility on resize.
    window.addEventListener('resize', () => {
      if (!isMobile()) closeMobile();
    });
  }

  function _bindNav() {
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
      item.addEventListener('click', () => navigate(item.dataset.page));
    });

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', async () => {
      const confirmed = await Modal.confirm({
        title:       'Sign out',
        message:     'Are you sure you want to sign out?',
        confirmText: 'Sign out',
        danger:      false,
      });
      if (confirmed) Auth.logout();
    });

    const refreshBtn = document.getElementById('topbar-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', async () => {
      // Blow away the canonical metrics cache so every page (dashboard,
      // inventory, orders, box lookup) re-fetches fresh from the backend.
      // Without this the topbar refresh only re-ran page init handlers
      // while still serving the stale MetricsEngine snapshot.
      if (refreshBtn.classList.contains('is-spinning')) return; // ignore re-entrancy
      refreshBtn.classList.add('is-spinning');
      refreshBtn.disabled = true;

      // Min-duration so very fast loads still show the spin (visual feedback).
      const minDuration = new Promise(resolve => setTimeout(resolve, 600));

      try { MetricsEngine?.invalidate?.(); } catch {}
      const refresh = _currentPage ? Promise.resolve(PAGES[_currentPage]?.load?.()) : Promise.resolve();

      try { await Promise.all([refresh, minDuration]); }
      finally {
        refreshBtn.classList.remove('is-spinning');
        refreshBtn.disabled = false;
      }
    });

    _initSidebarToggle();
  }

  function _bindSidebarUser() {
    const user = Auth.getUser();
    const org  = Auth.getOrganization();
    if (!user) return;
    Utils.setText('.sidebar-user-name', user.display_name || user.username || '?');
    Utils.setText('.sidebar-user-role', org ? Utils.capitalize(org.role) : '—');
    const av = document.querySelector('.sidebar-avatar');
    if (av) av.textContent = (user.display_name || user.username || '?')[0].toUpperCase();

    // Org switcher
    const memberships = Auth.getMemberships();
    const switcherEl  = document.getElementById('org-switcher');
    const orgNameEl   = document.getElementById('current-org-name');
    if (orgNameEl) orgNameEl.textContent = org?.display_name || '—';
    if (switcherEl) switcherEl.style.display = memberships.length > 1 ? '' : 'none';
  }

  // Idempotent — binds the org switcher once per session, even if showApp()
  // is called multiple times (e.g., after switching orgs).
  let _orgSwitcherBound = false;
  function _bindOrgSwitcher() {
    if (_orgSwitcherBound) return;
    const switcher = document.getElementById('org-switcher');
    const dropdown = document.getElementById('org-switcher-dropdown');
    const trigger  = document.getElementById('org-switcher-trigger');
    if (!switcher || !dropdown || !trigger) return;
    _orgSwitcherBound = true;

    function _renderDropdown() {
      const memberships = Auth.getMemberships();
      const currentOrg  = Auth.getOrganization();
      dropdown.innerHTML = memberships.map(m => {
        const active = m.membership_id === currentOrg?.membership_id;
        return `
          <div class="org-switch-item${active ? ' active' : ''}"
               data-membership-id="${Utils.escapeHtml(m.membership_id)}">
            <div class="org-switch-item-text">
              <div class="org-switch-item-name">${Utils.escapeHtml(m.display_name)}</div>
              <div class="org-switch-item-role">${Utils.escapeHtml(Utils.capitalize(m.role || ''))}</div>
            </div>
            ${active ? '<i data-lucide="check" class="icon org-switch-item-check" aria-hidden="true"></i>' : ''}
          </div>`;
      }).join('');
      // The icons MutationObserver picks up the new <i data-lucide> nodes,
      // but call refresh() anyway to render them on the same tick.
      Icons?.refresh?.();
    }

    function _open() {
      _renderDropdown();
      switcher.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
    }
    function _close() {
      switcher.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
    }
    function _toggle() {
      if (switcher.classList.contains('is-open')) _close(); else _open();
    }

    // Trigger button toggles the dropdown
    trigger.addEventListener('click', e => {
      e.stopPropagation();
      _toggle();
    });

    // Dropdown item click → switch org
    dropdown.addEventListener('click', async e => {
      const item = e.target.closest('[data-membership-id]');
      if (!item) return;
      e.stopPropagation();
      _close();
      const mid = item.dataset.membershipId;
      if (mid && mid !== Auth.getOrganization()?.membership_id) {
        await Auth.switchOrg(mid);
        _bindSidebarUser();
      }
    });

    // Click anywhere outside → close
    document.addEventListener('click', e => {
      if (!switcher.contains(e.target)) _close();
    });

    // Esc to close
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') _close();
    });
  }

  function showApp() {
    document.getElementById('loading-screen')?.style.setProperty('display', 'none');
    document.getElementById('login-screen')?.style.setProperty('display', 'none');
    document.getElementById('org-selector-screen')?.style.setProperty('display', 'none');
    const shell = document.getElementById('app-shell');
    if (shell) shell.style.display = 'flex';

    _bindSidebarUser();
    _bindOrgSwitcher();
    Auth.applyRoleVisibility();
    Auth.startIdleWatch();

    const hash = window.location.hash.replace('#', '');
    navigate(PAGES[hash] ? hash : 'dashboard');
  }

  // Full frontend state reset. Called on org switch BEFORE rendering the new org.
  // Clears: KPI cache, page init memory, current-page pointer, and each module's
  // in-memory state. After this call, the next navigate() will fetch fresh data.
  function resetAllState() {
    try { MetricsEngine.invalidate(); } catch {}
    _initialized = {};
    _currentPage = null;
    [Dashboard, InventoryList, BoxLookup, Orders, Uploads, Settings].forEach(mod => {
      try { mod?.reset?.(); } catch (err) { console.warn('module reset failed', err); }
    });
  }

  function showLogin() {
    document.getElementById('loading-screen')?.style.setProperty('display', 'none');
    document.getElementById('app-shell')?.style.setProperty('display', 'none');
    document.getElementById('org-selector-screen')?.style.setProperty('display', 'none');
    const login = document.getElementById('login-screen');
    if (login) login.style.display = 'flex';
  }

  function _bindFilterHighlights() {
    // Event delegation: highlight any filter-bar select/date-input when non-default
    document.addEventListener('change', e => {
      const el = e.target;
      if (!el.closest('.filter-bar')) return;
      if (el.tagName === 'SELECT') {
        const def = el.options[0]?.value ?? '';
        el.classList.toggle('filter-active', el.value !== def);
      } else if (el.type === 'date') {
        el.classList.toggle('filter-active', el.value !== '');
      }
    });
  }

  // Clears filter-active state on all filter-bar elements (call after programmatic resets)
  function syncFilterHighlights() {
    document.querySelectorAll('.filter-bar .form-select').forEach(sel => {
      const def = sel.options[0]?.value ?? '';
      sel.classList.toggle('filter-active', sel.value !== def);
    });
    document.querySelectorAll('.filter-bar input[type="date"]').forEach(inp => {
      inp.classList.toggle('filter-active', inp.value !== '');
    });
  }

  async function boot() {
    const loading = document.getElementById('loading-screen');
    if (loading) loading.style.display = 'flex';

    Icons.init(); // process static <i data-lucide> tags + start MutationObserver

    Auth.init();
    Dashboard.init();
    BoxLookup.init();
    InventoryList.init();
    Orders.init();
    Uploads.init();
    Settings.init();
    _bindNav();
    _bindFilterHighlights();

    const ok = await Auth.checkSession();
    if (ok) {
      console.log('[AUTH] app initialized');
      showApp();
    } else {
      console.log('[AUTH] redirecting to login');
      showLogin();
    }
  }

  return { navigate, showApp, showLogin, boot, syncFilterHighlights, resetAllState };
})();

/* ── Entry point ────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => App.boot());
