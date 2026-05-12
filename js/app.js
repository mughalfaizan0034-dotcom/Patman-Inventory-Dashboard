/* ============================================================
   app.js — App router, page navigation, Settings page, Users
            management, System status. Main bootstrap entry point.
   ============================================================ */

/* ── Settings page ──────────────────────────────────────────── */
const Settings = (() => {

  /* ── Users tab ──────────────────────────────────────────── */
  let _userModal = null;
  let _editingUserId = null;

  function _openUserModal(user = null) {
    _editingUserId = user?.membership_id || user?.user_id || null;
    const isEdit   = !!user;
    const title    = isEdit ? 'Edit Member' : 'Add User';

    if (!_userModal) {
      _userModal = new Modal({ title, maxWidth: '440px' });
    }
    _userModal.setTitle(title);
    _userModal.setBody(`
      <form id="user-form" autocomplete="off">
        <div class="form-group">
          <label class="form-label">Display Name <span class="req">*</span></label>
          <input class="form-input" id="u-name" placeholder="Full name" value="${Utils.escapeHtml(user?.display_name || '')}">
        </div>
        ${!isEdit ? `
        <div class="form-group">
          <label class="form-label">Username</label>
          <input class="form-input" id="u-username" placeholder="auto-generated if blank" autocomplete="off">
        </div>
        <div class="form-group">
          <label class="form-label">Password <span class="req">*</span></label>
          <input class="form-input" id="u-password" type="password" placeholder="Minimum 8 characters">
        </div>` : ''}
        <div class="form-group">
          <label class="form-label">Role</label>
          <select class="form-select" id="u-role">
            <option value="viewer"  ${user?.role === 'viewer'  ? 'selected' : ''}>Viewer</option>
            <option value="staff"   ${user?.role === 'staff'   ? 'selected' : ''}>Staff</option>
            <option value="manager" ${user?.role === 'manager' ? 'selected' : ''}>Manager</option>
            <option value="admin"   ${user?.role === 'admin'   ? 'selected' : ''}>Admin</option>
          </select>
        </div>
        ${isEdit ? `
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="u-active">
            <option value="true"  ${user?.is_active !== false ? 'selected' : ''}>Active</option>
            <option value="false" ${user?.is_active === false  ? 'selected' : ''}>Inactive</option>
          </select>
        </div>` : ''}
        <div id="user-form-error" class="form-error" style="display:none"></div>
      </form>`);
    _userModal.setFooter(`
      <button class="btn btn-secondary btn-sm" id="u-cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="u-save">${isEdit ? 'Save Changes' : 'Create User'}</button>`);
    _userModal.show();

    document.getElementById('u-cancel')?.addEventListener('click', () => _userModal.hide());
    document.getElementById('u-save')?.addEventListener('click', () => _saveUser(isEdit));
    document.getElementById('user-form')?.addEventListener('submit', e => { e.preventDefault(); _saveUser(isEdit); });
  }

  async function _saveUser(isEdit) {
    const name     = document.getElementById('u-name')?.value.trim();
    const username = document.getElementById('u-username')?.value.trim();
    const password = document.getElementById('u-password')?.value;
    const role     = document.getElementById('u-role')?.value;
    const active   = document.getElementById('u-active')?.value;
    const errEl    = document.getElementById('user-form-error');
    const saveBtn  = document.getElementById('u-save');

    const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!name) return showErr('Display name is required.');
    if (!isEdit && (!password || password.length < 8)) return showErr('Password must be at least 8 characters.');

    if (errEl) errEl.style.display = 'none';
    Loading.btn(saveBtn, true);

    try {
      if (isEdit) {
        const updates = { role, is_active: active === 'true' };
        await API.updateUser(_editingUserId, updates);
        Notify.success('Member updated');
      } else {
        await API.createUser({ display_name: name, username: username || undefined, password, role });
        Notify.success('User created');
      }
      _userModal.hide();
      loadUsers();
    } catch (err) {
      showErr(err.message || 'Save failed.');
    } finally {
      Loading.btn(saveBtn, false);
    }
  }

  async function loadUsers() {
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;

    tbody.innerHTML = Loading.tableRows(5, 4);

    try {
      const users = await API.getUsers();
      if (!users.length) {
        tbody.innerHTML = `<tr><td colspan="5">${Loading.empty('user', 'No users found')}</td></tr>`;
        return;
      }

      const currentUser = Auth.getUser();
      tbody.innerHTML = users.map(u => `
        <tr>
          <td>
            <div style="display:flex;align-items:center;gap:8px">
              <div style="width:28px;height:28px;border-radius:50%;background:var(--primary-100);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--primary-text);flex-shrink:0">
                ${Utils.escapeHtml((u.display_name || u.username || u.email || '?')[0].toUpperCase())}
              </div>
              <span style="font-weight:500">${Utils.escapeHtml(u.display_name || '—')}</span>
            </div>
          </td>
          <td>${Utils.escapeHtml(u.username || '—')}</td>
          <td>${Utils.badgeHtml(u.role === 'admin' ? 'error' : u.role === 'manager' ? 'warning' : 'gray', Utils.capitalize(u.role))}</td>
          <td>${u.is_active !== false ? Utils.badgeHtml('success', 'Active') : Utils.badgeHtml('gray', 'Inactive')}</td>
          <td>
            <div style="display:flex;gap:4px">
              <button class="btn btn-secondary btn-sm" onclick="Settings._edit('${Utils.escapeHtml(u.membership_id || u.user_id)}')">Edit</button>
              ${u.membership_id !== Auth.getOrganization()?.membership_id ? `<button class="btn btn-danger btn-sm" onclick="Settings._delete('${Utils.escapeHtml(u.membership_id || u.user_id)}', '${Utils.escapeHtml(u.display_name || u.username)}')">Remove</button>` : ''}
            </div>
          </td>
        </tr>`).join('');

      Settings._usersCache = users;
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5">${Loading.error('Failed to load users')}</td></tr>`;
      Notify.apiError(err);
    }
  }

  async function _deleteUser(userId, name) {
    const confirmed = await Modal.confirm({
      title:       'Delete User',
      message:     `Delete "${name}"? This cannot be undone.`,
      confirmText: 'Delete',
      danger:      true,
    });
    if (!confirmed) return;
    try {
      await API.deleteUser(userId);
      Notify.success('User deleted');
      loadUsers();
    } catch (err) {
      Notify.apiError(err);
    }
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
    const variant = status === 'ok' ? 'success' : status === 'info' ? 'info' : 'error';
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

  async function loadLogs() {
    const el = document.getElementById('logs-content');
    if (!el) return;
    el.innerHTML = `<div style="display:flex;justify-content:center;padding:24px">${Loading.spinnerHtml()}</div>`;
    try {
      const items = await API.getActivity(20);
      if (!items.length) { el.innerHTML = Loading.empty('clipboard-list', 'No activity found'); return; }
      el.innerHTML = items.map(item => `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
          <span style="color:var(--txt-4);display:flex;align-items:center"><i data-lucide="clock" class="icon" style="width:16px;height:16px" aria-hidden="true"></i></span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:500;color:var(--txt-1)">${Utils.escapeHtml(item.title)}</div>
            <div style="font-size:11.5px;color:var(--txt-4)">${Utils.timeAgo(item.date)}</div>
          </div>
        </div>`).join('');
    } catch (err) {
      el.innerHTML = Loading.error('Failed to load activity logs');
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

  /* ── Organizations tab ──────────────────────────────────── */
  let _orgModal = null;
  let _editingOrgId = null;

  async function loadOrganizations() {
    const tbody = document.getElementById('orgs-tbody');
    if (!tbody) return;

    tbody.innerHTML = Loading.tableRows(4, 4);

    try {
      const orgs = await API.getOrganizations();
      if (!orgs.length) {
        tbody.innerHTML = `<tr><td colspan="4">${Loading.empty('building-2', 'No organizations', 'Create the first organization to get started')}</td></tr>`;
        return;
      }
      tbody.innerHTML = orgs.map(o => `
        <tr>
          <td style="font-weight:600;color:var(--txt-1)">${Utils.escapeHtml(o.display_name)}</td>
          <td style="font-size:12px;color:var(--txt-4);font-family:monospace">${Utils.escapeHtml(o.slug)}</td>
          <td>${o.is_active !== false ? Utils.badgeHtml('success', 'Active') : Utils.badgeHtml('gray', 'Inactive')}</td>
          <td>
            <div style="display:flex;gap:4px">
              <button class="btn btn-secondary btn-sm" onclick="Settings._editOrg('${Utils.escapeHtml(o.organization_id)}')">Edit</button>
              ${o.is_active !== false
                ? `<button class="btn btn-danger btn-sm" onclick="Settings._deactivateOrg('${Utils.escapeHtml(o.organization_id)}','${Utils.escapeHtml(o.display_name)}')">Deactivate</button>`
                : ''}
            </div>
          </td>
        </tr>`).join('');

      Settings._orgsCache = orgs;
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="4">${Loading.error('Failed to load organizations')}</td></tr>`;
      Notify.apiError(err);
    }
  }

  function _openOrgModal(org = null) {
    _editingOrgId = org?.organization_id || null;
    const isEdit  = !!org;
    const title   = isEdit ? 'Edit Organization' : 'New Organization';

    if (!_orgModal) _orgModal = new Modal({ title, maxWidth: '440px' });
    _orgModal.setTitle(title);
    _orgModal.setBody(`
      <form id="org-form" autocomplete="off">
        <div class="form-group">
          <label class="form-label">Display Name <span class="req">*</span></label>
          <input class="form-input" id="o-name" placeholder="e.g. Patman Warehouse" value="${Utils.escapeHtml(org?.display_name || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">Slug <span class="req">*</span></label>
          <input class="form-input" id="o-slug" placeholder="e.g. patman-warehouse" value="${Utils.escapeHtml(org?.slug || '')}"
            pattern="[a-z0-9-]+" title="Lowercase letters, numbers, hyphens only">
          <div class="form-hint">Lowercase letters, numbers, hyphens only. Used in URLs and identifiers.</div>
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
    _orgModal.setFooter(`
      <button class="btn btn-secondary btn-sm" id="o-cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="o-save">${isEdit ? 'Save Changes' : 'Create Organization'}</button>`);
    _orgModal.show();

    document.getElementById('o-cancel')?.addEventListener('click', () => _orgModal.hide());
    document.getElementById('o-save')?.addEventListener('click', () => _saveOrg(isEdit));
    document.getElementById('org-form')?.addEventListener('submit', e => { e.preventDefault(); _saveOrg(isEdit); });

    if (!isEdit) {
      document.getElementById('o-name')?.addEventListener('input', e => {
        const slug = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const slugEl = document.getElementById('o-slug');
        if (slugEl && !slugEl.dataset.edited) slugEl.value = slug;
      });
      document.getElementById('o-slug')?.addEventListener('input', e => {
        e.target.dataset.edited = '1';
      });
    }
  }

  async function _saveOrg(isEdit) {
    const name   = document.getElementById('o-name')?.value.trim();
    const slug   = document.getElementById('o-slug')?.value.trim();
    const active = document.getElementById('o-active')?.value;
    const errEl  = document.getElementById('org-form-error');
    const saveBtn = document.getElementById('o-save');

    const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };
    if (!name) return showErr('Display name is required.');
    if (!slug)  return showErr('Slug is required.');
    if (!/^[a-z0-9-]+$/.test(slug)) return showErr('Slug must be lowercase letters, numbers, hyphens only.');

    if (errEl) errEl.style.display = 'none';
    Loading.btn(saveBtn, true);

    try {
      if (isEdit) {
        const updates = { display_name: name, slug };
        if (active !== undefined) updates.is_active = active === 'true';
        await API.updateOrganization(_editingOrgId, updates);
        Notify.success('Organization updated');
      } else {
        await API.createOrganization({ display_name: name, slug });
        Notify.success('Organization created');
      }
      _orgModal.hide();
      loadOrganizations();
    } catch (err) {
      showErr(err.message || 'Save failed.');
    } finally {
      Loading.btn(saveBtn, false);
    }
  }

  async function _deactivateOrg(orgId, name) {
    const confirmed = await Modal.confirm({
      title:       'Deactivate Organization',
      message:     `Deactivate "${name}"? Members will lose access. This can be reversed.`,
      confirmText: 'Deactivate',
      danger:      true,
    });
    if (!confirmed) return;
    try {
      await API.updateOrganization(orgId, { is_active: false });
      Notify.success('Organization deactivated');
      loadOrganizations();
    } catch (err) {
      Notify.apiError(err);
    }
  }

  /* ── Tab switching ──────────────────────────────────────── */
  function initTabs() {
    const tabList = document.getElementById('settings-tab-list');
    if (!tabList) return;

    tabList.addEventListener('click', e => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      const tab = btn.dataset.tab;

      tabList.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('#page-settings .tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(`tab-${tab}`)?.classList.add('active');

      if (tab === 'users')         loadUsers();
      if (tab === 'system')        loadSystemStatus();
      if (tab === 'logs')          loadLogs();
      if (tab === 'profile')       _initProfileTab();
      if (tab === 'organizations') loadOrganizations();
    });

    const addUserBtn = document.getElementById('add-user-btn');
    if (addUserBtn) addUserBtn.addEventListener('click', () => _openUserModal());

    const addOrgBtn = document.getElementById('add-org-btn');
    if (addOrgBtn) addOrgBtn.addEventListener('click', () => _openOrgModal());
  }

  return {
    init:    initTabs,
    loadUsers,
    loadOrganizations,
    _edit:        (id)       => { const u = Settings._usersCache?.find(x => (x.membership_id || x.user_id) === id); _openUserModal(u); },
    _delete:      _deleteUser,
    _editOrg:     (id)       => { const o = Settings._orgsCache?.find(x => x.organization_id === id); _openOrgModal(o); },
    _deactivateOrg,
    _usersCache: [],
    _orgsCache:  [],
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

  function _bindOrgSwitcher() {
    const switcher = document.getElementById('org-switcher');
    const dropdown = document.getElementById('org-switcher-dropdown');
    if (!switcher || !dropdown) return;

    switcher.addEventListener('click', () => {
      const memberships = Auth.getMemberships();
      const currentOrg  = Auth.getOrganization();
      dropdown.innerHTML = memberships.map(m => `
        <div class="org-switch-item ${m.membership_id === currentOrg?.membership_id ? 'active' : ''}"
             data-membership-id="${Utils.escapeHtml(m.membership_id)}"
             style="padding:10px 14px;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:space-between;${m.membership_id === currentOrg?.membership_id ? 'background:var(--surface-2);font-weight:600' : ''}">
          <span>${Utils.escapeHtml(m.display_name)}</span>
          ${m.membership_id === currentOrg?.membership_id ? '<i data-lucide="check" class="icon" style="width:14px;height:14px;color:var(--success)" aria-hidden="true"></i>' : ''}
        </div>`
      ).join('');
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    });

    dropdown.addEventListener('click', async e => {
      const item = e.target.closest('[data-membership-id]');
      if (!item) return;
      dropdown.style.display = 'none';
      const mid = item.dataset.membershipId;
      if (mid !== Auth.getOrganization()?.membership_id) {
        await Auth.switchOrg(mid);
        _bindSidebarUser();
      }
    });

    document.addEventListener('click', e => {
      if (!switcher.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
      }
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

  function showLogin() {
    document.getElementById('loading-screen')?.style.setProperty('display', 'none');
    document.getElementById('app-shell')?.style.setProperty('display', 'none');
    document.getElementById('org-selector-screen')?.style.setProperty('display', 'none');
    const login = document.getElementById('login-screen');
    if (login) login.style.display = 'flex';
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

    const ok = await Auth.checkSession();
    if (ok) {
      console.log('[AUTH] app initialized');
      showApp();
    } else {
      console.log('[AUTH] redirecting to login');
      showLogin();
    }
  }

  return { navigate, showApp, showLogin, boot };
})();

/* ── Entry point ────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => App.boot());
