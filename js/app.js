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
    _editingUserId = user?.user_id || null;
    const isEdit   = !!user;
    const title    = isEdit ? 'Edit User' : 'Add User';

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
        <div class="form-group">
          <label class="form-label">Email <span class="req">*</span></label>
          <input class="form-input" id="u-email" type="email" placeholder="email@domain.com" value="${Utils.escapeHtml(user?.email || '')}" ${isEdit ? 'readonly' : ''}>
        </div>
        ${!isEdit ? `
        <div class="form-group">
          <label class="form-label">Password <span class="req">*</span></label>
          <input class="form-input" id="u-password" type="password" placeholder="Minimum 8 characters">
        </div>` : ''}
        <div class="form-group">
          <label class="form-label">Role</label>
          <select class="form-select" id="u-role">
            <option value="viewer"  ${user?.role === 'viewer'  ? 'selected' : ''}>Viewer</option>
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
    const email    = document.getElementById('u-email')?.value.trim();
    const password = document.getElementById('u-password')?.value;
    const role     = document.getElementById('u-role')?.value;
    const active   = document.getElementById('u-active')?.value;
    const errEl    = document.getElementById('user-form-error');
    const saveBtn  = document.getElementById('u-save');

    const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!name)  return showErr('Display name is required.');
    if (!email) return showErr('Email is required.');
    if (!isEdit && (!password || password.length < 8)) return showErr('Password must be at least 8 characters.');

    if (errEl) errEl.style.display = 'none';
    Loading.btn(saveBtn, true);

    try {
      if (isEdit) {
        const updates = { display_name: name, role, is_active: active === 'true' };
        await API.updateUser(_editingUserId, updates);
        Notify.success('User updated');
      } else {
        await API.createUser({ display_name: name, email, password, role });
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
        tbody.innerHTML = `<tr><td colspan="5">${Loading.empty('👤', 'No users found')}</td></tr>`;
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
          <td>${Utils.escapeHtml(u.email || u.username || '—')}</td>
          <td>${Utils.badgeHtml(u.role === 'admin' ? 'error' : u.role === 'manager' ? 'warning' : 'gray', Utils.capitalize(u.role))}</td>
          <td>${u.is_active !== false ? Utils.badgeHtml('success', 'Active') : Utils.badgeHtml('gray', 'Inactive')}</td>
          <td>
            <div style="display:flex;gap:4px">
              <button class="btn btn-secondary btn-sm" onclick="Settings._edit('${Utils.escapeHtml(u.user_id)}')">Edit</button>
              ${u.user_id !== currentUser?.user_id ? `<button class="btn btn-danger btn-sm" onclick="Settings._delete('${Utils.escapeHtml(u.user_id)}', '${Utils.escapeHtml(u.display_name || u.username || u.email)}')">Delete</button>` : ''}
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
          ${_statusRow('BigQuery', status.bqStatus, status.bqMessage)}
          ${_statusRow('CacheService', status.cacheStatus, status.cacheMessage)}
          ${_statusRow('Apps Script', status.appsScriptStatus || 'ok', 'Connected')}
          ${_statusRow('App Version', 'info', status.version || '—')}
          ${_statusRow('Last Check', 'info', Utils.formatDatetime(status.timestamp))}
        </div>`;
    } catch (err) {
      el.innerHTML = Loading.error('Failed to load system status');
    }
  }

  function _statusRow(label, status, message) {
    const variant = status === 'ok' ? 'success' : status === 'info' ? 'info' : 'error';
    const icon    = status === 'ok' ? '✓' : status === 'info' ? 'ℹ' : '✕';
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface-2);border-radius:var(--r-sm)">
        <span style="font-size:13px;font-weight:500;color:var(--txt-2)">${Utils.escapeHtml(label)}</span>
        <span style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--txt-3)">
          ${Utils.escapeHtml(message || '')}
          ${Utils.badgeHtml(variant, icon)}
        </span>
      </div>`;
  }

  async function loadLogs() {
    const el = document.getElementById('logs-content');
    if (!el) return;
    el.innerHTML = `<div style="display:flex;justify-content:center;padding:24px">${Loading.spinnerHtml()}</div>`;
    try {
      const logs = await API.getLogs();
      const entries = logs.entries || logs || [];
      if (!entries.length) { el.innerHTML = Loading.empty('📋', 'No logs'); return; }
      el.innerHTML = `<pre style="font-size:11.5px;color:var(--txt-2);overflow:auto;max-height:400px;line-height:1.6">${
        entries.slice(-100).map(l => Utils.escapeHtml(
          `[${l.timestamp || ''}] [${(l.level || 'INFO').toUpperCase()}] ${l.message || ''}`
        )).join('\n')
      }</pre>`;
    } catch (err) {
      el.innerHTML = Loading.error('Failed to load logs');
    }
  }

  /* ── Profile tab ─────────────────────────────────────────── */
  function _initProfileTab() {
    const user = Auth.getUser();
    if (!user) return;

    Utils.setText('#profile-name',  user.display_name || user.username);
    Utils.setText('#profile-email', user.email || user.username);
    Utils.setText('#profile-role',  Utils.capitalize(user.role));

    const avatarEl = document.getElementById('profile-avatar');
    if (avatarEl) avatarEl.textContent = (user.display_name || user.username || user.email || '?')[0].toUpperCase();
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
      document.querySelectorAll('#settings-page .tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(`tab-${tab}`)?.classList.add('active');

      if (tab === 'users')   loadUsers();
      if (tab === 'system')  loadSystemStatus();
      if (tab === 'logs')    loadLogs();
      if (tab === 'profile') _initProfileTab();
    });

    const addUserBtn = document.getElementById('add-user-btn');
    if (addUserBtn) addUserBtn.addEventListener('click', () => _openUserModal());
  }

  return {
    init:    initTabs,
    loadUsers,
    _edit:   (id) => { const u = Settings._usersCache?.find(x => x.user_id === id); _openUserModal(u); },
    _delete: _deleteUser,
    _usersCache: [],
  };
})();

/* ── App router ─────────────────────────────────────────────── */
const App = (() => {
  const PAGES = {
    dashboard:  { label: 'Dashboard',       init: () => Dashboard.load() },
    performance:{ label: 'Performance',     init: () => Perf.load() },
    lookup:     { label: 'Box Lookup',      init: () => {} },
    inventory:  { label: 'Inventory List',  init: () => InventoryList.load() },
    orders:     { label: 'Orders',          init: () => Orders.load() },
    uploads:    { label: 'Uploads',         init: () => Uploads.loadHistory() },
    settings:   { label: 'Settings',        init: () => Settings.loadUsers() },
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
    } else if (['dashboard', 'performance'].includes(pageId)) {
      PAGES[pageId].init?.();
    }

    window.location.hash = pageId;
  }

  function _bindNav() {
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
      item.addEventListener('click', () => navigate(item.dataset.page));
    });

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', () => Auth.logout());

    const refreshBtn = document.getElementById('topbar-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => { if (_currentPage) PAGES[_currentPage]?.init?.(); });
  }

  function _bindSidebarUser() {
    const user = Auth.getUser();
    if (!user) return;
    Utils.setText('.sidebar-user-name', user.display_name || user.username || user.email);
    Utils.setText('.sidebar-user-role', Utils.capitalize(user.role));
    const av = document.querySelector('.sidebar-avatar');
    if (av) av.textContent = (user.display_name || user.username || user.email || '?')[0].toUpperCase();
  }

  function showApp() {
    document.getElementById('loading-screen')?.style.setProperty('display', 'none');
    document.getElementById('login-screen')?.style.setProperty('display', 'none');
    const shell = document.getElementById('app-shell');
    if (shell) shell.style.display = 'flex';

    _bindSidebarUser();
    Auth.applyRoleVisibility();

    const hash = window.location.hash.replace('#', '');
    navigate(PAGES[hash] ? hash : 'dashboard');
  }

  function showLogin() {
    document.getElementById('loading-screen')?.style.setProperty('display', 'none');
    document.getElementById('app-shell')?.style.setProperty('display', 'none');
    const login = document.getElementById('login-screen');
    if (login) login.style.display = 'flex';
  }

  async function boot() {
    const loading = document.getElementById('loading-screen');
    if (loading) loading.style.display = 'flex';

    Auth.init();
    BoxLookup.init();
    InventoryList.init();
    Orders.init();
    Uploads.init();
    Settings.init();
    Perf.init();
    _bindNav();

    const ok = await Auth.checkSession();
    if (ok) {
      showApp();
    } else {
      showLogin();
    }
  }

  return { navigate, showApp, showLogin, boot };
})();

/* ── Entry point ────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => App.boot());
