/* ============================================================
   app.js — App router, page navigation, Settings page, Users
            management, System status. Main bootstrap entry point.
   ============================================================ */

/* ── Settings page ──────────────────────────────────────────── */
const Settings = (() => {

  let _usersCache = [];
  let _orgsCache  = [];

  const ROLE_COLOR = { admin: 'error', manager: 'warning', staff: 'info', viewer: 'gray' };
  const ROLE_LABEL = { admin: 'Admin — full access', manager: 'Manager — uploads & reports', staff: 'User — full operations', viewer: 'Viewer — view & download only' };

  function _roleOptions(selected = 'viewer') {
    return Object.entries(ROLE_LABEL).map(([v, l]) =>
      `<option value="${v}"${v === selected ? ' selected' : ''}>${Utils.escapeHtml(l)}</option>`
    ).join('');
  }

  /* ── Users: load ────────────────────────────────────────── */
  async function loadUsers() {
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;
    tbody.innerHTML = Loading.tableRows(5, 5);
    try {
      const users  = await API.getUsers();
      _usersCache  = users;
      if (!users.length) {
        tbody.innerHTML = `<tr><td colspan="5">${Loading.empty('users', 'No users in this organization', 'Add a new user or assign an existing one')}</td></tr>`;
        return;
      }
      const myMembershipId = Auth.getOrganization()?.membership_id;
      tbody.innerHTML = users.map(u => {
        const mid   = Utils.escapeHtml(u.membership_id || '');
        const dname = Utils.escapeHtml(u.display_name || u.username || '?');
        const isSelf = u.membership_id === myMembershipId;
        return `<tr>
          <td>
            <div style="display:flex;align-items:center;gap:8px">
              <div class="user-avatar-sm">${(u.display_name || u.username || '?')[0].toUpperCase()}</div>
              <span style="font-weight:500">${dname}</span>
            </div>
          </td>
          <td><span style="font-size:12px;color:var(--txt-3);font-family:monospace">@${Utils.escapeHtml(u.username || '—')}</span></td>
          <td>${Utils.badgeHtml(ROLE_COLOR[u.role] || 'gray', Utils.capitalize(u.role || ''))}</td>
          <td>${u.is_active !== false ? Utils.badgeHtml('success', 'Active') : Utils.badgeHtml('gray', 'Inactive')}</td>
          <td>
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              <button class="btn btn-secondary btn-sm" data-action="edit-user" data-id="${mid}">Edit</button>
              <button class="btn btn-ghost btn-sm" data-action="change-pwd" data-id="${mid}" title="Change password">Pwd</button>
              ${!isSelf ? `<button class="btn btn-danger btn-sm" data-action="remove-user" data-id="${mid}" data-name="${dname}">Remove</button>` : ''}
            </div>
          </td>
        </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5">${Loading.error('Failed to load users')}</td></tr>`;
      Notify.apiError(err);
    }
  }

  /* ── Users: add new ─────────────────────────────────────── */
  function _openAddNewUserModal() {
    const m = new Modal({ title: 'Add New User', maxWidth: '440px' });
    m.setBody(`
      <form id="user-form" autocomplete="off">
        <div class="form-group">
          <label class="form-label">Display Name <span class="req">*</span></label>
          <input class="form-input" id="u-display" placeholder="Full name" autocomplete="off">
        </div>
        <div class="form-group">
          <label class="form-label">Username <span class="req">*</span></label>
          <input class="form-input" id="u-username" placeholder="login handle (e.g. john_doe)" autocomplete="off">
          <div class="form-hint">Unique across the platform. Used for login and tracking.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Password <span class="req">*</span></label>
          <input class="form-input" id="u-password" type="password" placeholder="Minimum 8 characters" autocomplete="new-password">
        </div>
        <div class="form-group">
          <label class="form-label">Role</label>
          <select class="form-select" id="u-role">${_roleOptions('viewer')}</select>
        </div>
        <div id="user-form-error" class="form-error" style="display:none"></div>
      </form>`);
    m.setFooter(`
      <button class="btn btn-secondary btn-sm" id="u-cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="u-save">Create User</button>`);
    m.show();

    const _save = () => _doCreateUser(m);
    document.getElementById('u-cancel')?.addEventListener('click', () => m.hide());
    document.getElementById('u-save')?.addEventListener('click', _save);
    document.getElementById('user-form')?.addEventListener('submit', e => { e.preventDefault(); _save(); });
  }

  async function _doCreateUser(m) {
    const display  = document.getElementById('u-display')?.value.trim();
    const username = document.getElementById('u-username')?.value.trim();
    const password = document.getElementById('u-password')?.value;
    const role     = document.getElementById('u-role')?.value;
    const errEl    = document.getElementById('user-form-error');
    const saveBtn  = document.getElementById('u-save');
    const showErr  = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!display)  return showErr('Display name is required.');
    if (!username) return showErr('Username is required.');
    if (!password || password.length < 8) return showErr('Password must be at least 8 characters.');
    errEl.style.display = 'none';
    Loading.btn(saveBtn, true);
    try {
      await API.createUser({ display_name: display, username, password, role });
      Notify.success('User created', `${display} has been added to this organization.`);
      m.hide();
      loadUsers();
    } catch (err) {
      showErr(err.message || 'Failed to create user.');
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
      const username = document.getElementById('ae-username')?.value.trim().toLowerCase();
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

  /* ── Users: edit ────────────────────────────────────────── */
  function _openEditUserModal(membershipId) {
    const user = _usersCache.find(u => u.membership_id === membershipId);
    if (!user) return;
    const m = new Modal({ title: 'Edit User', maxWidth: '440px' });
    m.setBody(`
      <form id="edit-user-form" autocomplete="off">
        <div class="form-group">
          <label class="form-label">Display Name <span class="req">*</span></label>
          <input class="form-input" id="eu-display" value="${Utils.escapeHtml(user.display_name || '')}" autocomplete="off">
        </div>
        <div class="form-group">
          <label class="form-label">Username</label>
          <div style="padding:8px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);font-size:13px;color:var(--txt-3);font-family:monospace">
            @${Utils.escapeHtml(user.username || '')}
          </div>
          <div class="form-hint">Username is fixed and used for login tracking.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Role</label>
          <select class="form-select" id="eu-role">${_roleOptions(user.role)}</select>
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="eu-status">
            <option value="true"  ${user.is_active !== false ? 'selected' : ''}>Active</option>
            <option value="false" ${user.is_active === false  ? 'selected' : ''}>Inactive</option>
          </select>
        </div>
        <div id="edit-user-error" class="form-error" style="display:none"></div>
      </form>`);
    m.setFooter(`
      <button class="btn btn-secondary btn-sm" id="eu-cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="eu-save">Save Changes</button>`);
    m.show();

    const _save = () => _doEditUser(m, membershipId);
    document.getElementById('eu-cancel')?.addEventListener('click', () => m.hide());
    document.getElementById('eu-save')?.addEventListener('click', _save);
    document.getElementById('edit-user-form')?.addEventListener('submit', e => { e.preventDefault(); _save(); });
  }

  async function _doEditUser(m, membershipId) {
    const display  = document.getElementById('eu-display')?.value.trim();
    const role     = document.getElementById('eu-role')?.value;
    const isActive = document.getElementById('eu-status')?.value === 'true';
    const errEl    = document.getElementById('edit-user-error');
    const saveBtn  = document.getElementById('eu-save');
    const showErr  = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!display) return showErr('Display name is required.');
    errEl.style.display = 'none';
    Loading.btn(saveBtn, true);
    try {
      await API.updateUser(membershipId, { display_name: display, role, is_active: isActive });
      Notify.success('User updated');
      m.hide();
      loadUsers();
    } catch (err) {
      showErr(err.message || 'Failed to save.');
    } finally {
      Loading.btn(saveBtn, false);
    }
  }

  /* ── Users: change password ─────────────────────────────── */
  function _openChangePwdModal(membershipId) {
    const user = _usersCache.find(u => u.membership_id === membershipId);
    const name = Utils.escapeHtml(user?.display_name || user?.username || 'this user');
    const m    = new Modal({ title: 'Change Password', maxWidth: '400px' });
    m.setBody(`
      <p style="font-size:13px;color:var(--txt-3);margin-bottom:16px">
        Set a new password for <strong>${name}</strong>.
      </p>
      <form id="pwd-form" autocomplete="off">
        <div class="form-group">
          <label class="form-label">New Password <span class="req">*</span></label>
          <input class="form-input" id="pwd-new" type="password" placeholder="Minimum 8 characters" autocomplete="new-password">
        </div>
        <div class="form-group">
          <label class="form-label">Confirm Password <span class="req">*</span></label>
          <input class="form-input" id="pwd-confirm" type="password" placeholder="Re-enter password" autocomplete="new-password">
        </div>
        <div id="pwd-error" class="form-error" style="display:none"></div>
      </form>`);
    m.setFooter(`
      <button class="btn btn-secondary btn-sm" id="pwd-cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="pwd-save">Set Password</button>`);
    m.show();

    const _save = () => _doChangePwd(m, membershipId);
    document.getElementById('pwd-cancel')?.addEventListener('click', () => m.hide());
    document.getElementById('pwd-save')?.addEventListener('click', _save);
    document.getElementById('pwd-form')?.addEventListener('submit', e => { e.preventDefault(); _save(); });
  }

  async function _doChangePwd(m, membershipId) {
    const newPwd  = document.getElementById('pwd-new')?.value;
    const confirm = document.getElementById('pwd-confirm')?.value;
    const errEl   = document.getElementById('pwd-error');
    const saveBtn = document.getElementById('pwd-save');
    const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!newPwd || newPwd.length < 8) return showErr('Password must be at least 8 characters.');
    if (newPwd !== confirm) return showErr('Passwords do not match.');
    errEl.style.display = 'none';
    Loading.btn(saveBtn, true);
    try {
      await API.updateUser(membershipId, { password: newPwd });
      Notify.success('Password changed', "The user's password has been updated.");
      m.hide();
    } catch (err) {
      showErr(err.message || 'Failed to change password.');
    } finally {
      Loading.btn(saveBtn, false);
    }
  }

  /* ── Users: remove ──────────────────────────────────────── */
  async function _removeUser(membershipId, name) {
    const confirmed = await Modal.confirm({
      title:       'Remove User',
      message:     `Remove "${name}" from this organization? They will lose access. You can restore access by editing their status.`,
      confirmText: 'Remove',
      danger:      true,
    });
    if (!confirmed) return;
    try {
      await API.deleteUser(membershipId);
      Notify.success('User removed');
      loadUsers();
    } catch (err) {
      Notify.apiError(err);
    }
  }

  /* ── Organizations: load ────────────────────────────────── */
  async function loadOrganizations() {
    const tbody = document.getElementById('orgs-tbody');
    if (!tbody) return;
    tbody.innerHTML = Loading.tableRows(4, 4);
    try {
      const orgs = await API.getOrganizations();
      _orgsCache  = orgs;
      if (!orgs.length) {
        tbody.innerHTML = `<tr><td colspan="4">${Loading.empty('building-2', 'No organizations', 'Create the first organization to get started')}</td></tr>`;
        return;
      }
      const currentOrgId = Auth.getOrganization()?.organization_id;
      tbody.innerHTML = orgs.map(o => {
        const oid    = Utils.escapeHtml(o.organization_id);
        const oname  = Utils.escapeHtml(o.display_name);
        const isHere = o.organization_id === currentOrgId;
        return `<tr ${isHere ? 'style="background:var(--surface-2)"' : ''}>
          <td>
            <span style="font-weight:600">${oname}</span>
            ${isHere ? '<span style="font-size:11px;color:var(--primary);margin-left:6px;font-weight:600">● current</span>' : ''}
          </td>
          <td style="font-size:12px;color:var(--txt-4);font-family:monospace">${Utils.escapeHtml(o.slug)}</td>
          <td>${o.is_active !== false ? Utils.badgeHtml('success', 'Active') : Utils.badgeHtml('gray', 'Inactive')}</td>
          <td>
            <div style="display:flex;gap:4px">
              <button class="btn btn-secondary btn-sm" data-action="edit-org" data-id="${oid}">Edit</button>
              ${o.is_active !== false
                ? `<button class="btn btn-danger btn-sm" data-action="toggle-org" data-id="${oid}" data-name="${oname}" data-activate="false">Deactivate</button>`
                : `<button class="btn btn-secondary btn-sm" data-action="toggle-org" data-id="${oid}" data-name="${oname}" data-activate="true">Activate</button>`}
            </div>
          </td>
        </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4">${Loading.error('Failed to load organizations')}</td></tr>`;
      Notify.apiError(err);
    }
  }

  /* ── Organizations: modal ───────────────────────────────── */
  function _openOrgModal(orgId = null) {
    const org    = orgId ? _orgsCache.find(o => o.organization_id === orgId) : null;
    const isEdit = !!org;
    const m      = new Modal({ title: isEdit ? 'Edit Organization' : 'New Organization', maxWidth: '440px' });
    m.setBody(`
      <form id="org-form" autocomplete="off">
        <div class="form-group">
          <label class="form-label">Display Name <span class="req">*</span></label>
          <input class="form-input" id="o-name" placeholder="e.g. Patman Warehouse" value="${Utils.escapeHtml(org?.display_name || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">Slug <span class="req">*</span></label>
          <input class="form-input" id="o-slug" placeholder="e.g. patman-warehouse"
            value="${Utils.escapeHtml(org?.slug || '')}"
            ${isEdit ? 'readonly style="background:var(--surface-2);color:var(--txt-3);cursor:default"' : 'pattern="[a-z0-9-]+"'}>
          <div class="form-hint">${isEdit ? 'Slug is fixed after creation.' : 'Lowercase letters, numbers, hyphens only.'}</div>
        </div>
        ${isEdit ? `
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="o-active">
            <option value="true"  ${org?.is_active !== false ? 'selected' : ''}>Active</option>
            <option value="false" ${org?.is_active === false  ? 'selected' : ''}>Inactive</option>
          </select>
        </div>` : ''}
        <div id="org-form-error" class="form-error" style="display:none"></div>
      </form>`);
    m.setFooter(`
      <button class="btn btn-secondary btn-sm" id="o-cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="o-save">${isEdit ? 'Save Changes' : 'Create Organization'}</button>`);
    m.show();

    const _save = () => _doSaveOrg(m, isEdit, orgId);
    document.getElementById('o-cancel')?.addEventListener('click', () => m.hide());
    document.getElementById('o-save')?.addEventListener('click', _save);
    document.getElementById('org-form')?.addEventListener('submit', e => { e.preventDefault(); _save(); });

    if (!isEdit) {
      document.getElementById('o-name')?.addEventListener('input', e => {
        const slug  = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const slugEl = document.getElementById('o-slug');
        if (slugEl && !slugEl.dataset.edited) slugEl.value = slug;
      });
      document.getElementById('o-slug')?.addEventListener('input', e => { e.target.dataset.edited = '1'; });
    }
  }

  async function _doSaveOrg(m, isEdit, orgId) {
    const name    = document.getElementById('o-name')?.value.trim();
    const slug    = document.getElementById('o-slug')?.value.trim();
    const active  = document.getElementById('o-active')?.value;
    const errEl   = document.getElementById('org-form-error');
    const saveBtn = document.getElementById('o-save');
    const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!name) return showErr('Display name is required.');
    if (!isEdit && !slug) return showErr('Slug is required.');
    if (!isEdit && !/^[a-z0-9-]+$/.test(slug)) return showErr('Slug must be lowercase letters, numbers, hyphens only.');
    errEl.style.display = 'none';
    Loading.btn(saveBtn, true);
    try {
      if (isEdit) {
        const updates = { display_name: name };
        if (active !== undefined) updates.is_active = active === 'true';
        await API.updateOrganization(orgId, updates);
        Notify.success('Organization updated');
      } else {
        await API.createOrganization({ display_name: name, slug });
        Notify.success('Organization created', 'Switch to it via the org switcher to manage its members.');
      }
      m.hide();
      loadOrganizations();
    } catch (err) {
      showErr(err.message || 'Save failed.');
    } finally {
      Loading.btn(saveBtn, false);
    }
  }

  async function _toggleOrg(orgId, name, activate) {
    const label = activate ? 'Activate' : 'Deactivate';
    const confirmed = await Modal.confirm({
      title:       `${label} Organization`,
      message:     activate
        ? `Activate "${name}"? Members will regain access.`
        : `Deactivate "${name}"? All members will lose access. This can be reversed.`,
      confirmText: label,
      danger:      !activate,
    });
    if (!confirmed) return;
    try {
      await API.updateOrganization(orgId, { is_active: activate });
      Notify.success(`Organization ${activate ? 'activated' : 'deactivated'}`);
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
    document.getElementById('add-org-btn')?.addEventListener('click', () => _openOrgModal());

    // Users table — event delegation
    document.getElementById('users-tbody')?.addEventListener('click', e => {
      const btn    = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id     = btn.dataset.id;
      if (action === 'edit-user')    _openEditUserModal(id);
      else if (action === 'change-pwd')   _openChangePwdModal(id);
      else if (action === 'remove-user')  _removeUser(id, btn.dataset.name || id);
    });

    // Orgs table — event delegation
    document.getElementById('orgs-tbody')?.addEventListener('click', e => {
      const btn    = e.target.closest('[data-action]');
      if (!btn) return;
      const action   = btn.dataset.action;
      const id       = btn.dataset.id;
      const name     = btn.dataset.name || id;
      const activate = btn.dataset.activate === 'true';
      if (action === 'edit-org')    _openOrgModal(id);
      else if (action === 'toggle-org') _toggleOrg(id, name, activate);
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
    const btn = document.getElementById('sidebar-toggle');
    if (!btn) return;

    if (localStorage.getItem(STORAGE_KEY) === '1') {
      document.body.classList.add('sidebar-collapsed');
    }

    btn.addEventListener('click', () => {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
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
    if (refreshBtn) refreshBtn.addEventListener('click', () => { if (_currentPage) PAGES[_currentPage]?.init?.(); });

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
