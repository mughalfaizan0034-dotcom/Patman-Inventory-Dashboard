/* ============================================================
   auth.js — Login flow, org selection, session management,
             idle timeout, cross-tab logout sync.
   ============================================================ */

const Auth = (() => {

  const REFRESH_KEY     = 'patman_refresh_token';
  const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  const _channel        = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('patman_auth') : null;

  let _idleTimer = null;

  /* ── Session storage ──────────────────────────────────────── */
  function saveSession(token, user, organization, refreshToken, memberships) {
    sessionStorage.setItem(CONFIG.SESSION_KEY,     token);
    sessionStorage.setItem(CONFIG.USER_KEY,        JSON.stringify(user));
    sessionStorage.setItem(CONFIG.ORG_KEY,         JSON.stringify(organization));
    if (refreshToken) sessionStorage.setItem(REFRESH_KEY, refreshToken);
    if (memberships)  sessionStorage.setItem(CONFIG.MEMBERSHIPS_KEY, JSON.stringify(memberships));
  }

  function clearSession() {
    sessionStorage.removeItem(CONFIG.SESSION_KEY);
    sessionStorage.removeItem(CONFIG.USER_KEY);
    sessionStorage.removeItem(CONFIG.ORG_KEY);
    sessionStorage.removeItem(CONFIG.MEMBERSHIPS_KEY);
    sessionStorage.removeItem(REFRESH_KEY);
  }

  function _decodeJwt(token) {
    try { return JSON.parse(atob(token.split('.')[1])); } catch { return null; }
  }

  function getToken()   { return sessionStorage.getItem(CONFIG.SESSION_KEY) || null; }
  function isLoggedIn() { return !!getToken(); }

  function getUser() {
    const stored = sessionStorage.getItem(CONFIG.USER_KEY);
    if (stored) { try { const u = JSON.parse(stored); if (u) return u; } catch {} }
    // Fallback: reconstruct from JWT payload so a partial session still works.
    const token = getToken();
    if (token) {
      const p = _decodeJwt(token);
      if (p?.user_id) {
        const u = { user_id: p.user_id, username: p.username, display_name: p.display_name };
        sessionStorage.setItem(CONFIG.USER_KEY, JSON.stringify(u));
        return u;
      }
    }
    return null;
  }

  function getOrganization() {
    const stored = sessionStorage.getItem(CONFIG.ORG_KEY);
    if (stored) { try { const o = JSON.parse(stored); if (o) return o; } catch {} }
    // Fallback: reconstruct from JWT payload — handles old sessions missing org data.
    const token = getToken();
    if (token) {
      const p = _decodeJwt(token);
      if (p?.organization_id && p?.membership_id) {
        const o = {
          organization_id: p.organization_id,
          membership_id:   p.membership_id,
          role:            p.role,
          display_name:    p.org_display_name || '—',
          slug:            p.org_slug || '',
        };
        sessionStorage.setItem(CONFIG.ORG_KEY, JSON.stringify(o));
        return o;
      }
    }
    return null;
  }

  function getMemberships() {
    try { return JSON.parse(sessionStorage.getItem(CONFIG.MEMBERSHIPS_KEY)) || []; } catch { return []; }
  }

  function _getMembershipId() {
    const token = getToken();
    if (!token) return null;
    try { return JSON.parse(atob(token.split('.')[1])).membership_id || null; }
    catch { return null; }
  }

  /* ── Idle timeout ─────────────────────────────────────────── */
  function _resetIdleTimer() {
    clearTimeout(_idleTimer);
    _idleTimer = setTimeout(() => {
      logout();
      if (typeof Notify !== 'undefined') Notify.warning?.('Signed out due to inactivity.');
    }, IDLE_TIMEOUT_MS);
  }

  function startIdleWatch() {
    ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(
      e => document.addEventListener(e, _resetIdleTimer, { passive: true })
    );
    _resetIdleTimer();
  }

  function stopIdleWatch() {
    clearTimeout(_idleTimer);
    _idleTimer = null;
    ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(
      e => document.removeEventListener(e, _resetIdleTimer)
    );
  }

  const ROLE_LEVEL = { admin: 3, manager: 2, viewer: 1, staff: 1, operator: 1 };

  function hasRole(required) {
    const org = getOrganization();
    if (!org) return false;
    return (ROLE_LEVEL[org.role] || 0) >= (ROLE_LEVEL[required] || 0);
  }

  /* ── Login UI ─────────────────────────────────────────────── */
  let _loginForm     = null;
  let _loginError    = null;
  let _loginBtn      = null;
  let _usernameInput = null;
  let _passwordInput = null;

  // Org selector state
  let _pendingToken    = null;
  let _pendingUser     = null;
  let _pendingMemberships = [];

  function _bindLoginUI() {
    _loginForm     = document.getElementById('login-form');
    _loginError    = document.getElementById('login-error');
    _loginBtn      = document.getElementById('login-btn');
    _usernameInput = document.getElementById('login-username');
    _passwordInput = document.getElementById('login-password');

    if (_loginForm) {
      _loginForm.addEventListener('submit', async e => {
        e.preventDefault();
        await _doLogin();
      });
    }

    // Org selector: clicking a workspace card
    const orgList = document.getElementById('org-list');
    if (orgList) {
      orgList.addEventListener('click', async e => {
        const card = e.target.closest('[data-membership-id]');
        if (!card) return;
        await _selectOrg(card.dataset.membershipId);
      });
    }

    // Back button from org selector
    const backBtn = document.getElementById('org-selector-back');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        _pendingToken = null;
        _pendingUser  = null;
        _pendingMemberships = [];
        _showScreen('login');
      });
    }
  }

  function _showError(msg) {
    if (_loginError) { _loginError.textContent = msg; _loginError.classList.add('visible'); }
  }
  function _hideError() {
    if (_loginError) _loginError.classList.remove('visible');
  }

  function _showScreen(screen) {
    document.getElementById('login-screen')?.style.setProperty('display', screen === 'login' ? 'flex' : 'none');
    document.getElementById('org-selector-screen')?.style.setProperty('display', screen === 'org' ? 'flex' : 'none');
    document.getElementById('app-shell')?.style.setProperty('display', screen === 'app' ? 'flex' : 'none');
    document.getElementById('loading-screen')?.style.setProperty('display', 'none');
  }

  async function _doLogin() {
    const username = _usernameInput?.value.trim();
    const password = _passwordInput?.value;

    _hideError();
    if (!username || !password) { _showError('Please enter your username and password.'); return; }

    Loading.btn(_loginBtn, true);

    try {
      const result = await API.login(username, password);

      if (result.requires_org_selection) {
        // Multi-org: show workspace selector
        _pendingToken       = result.pending_token;
        _pendingUser        = result.user;
        _pendingMemberships = result.memberships;
        _passwordInput.value = '';
        _showOrgSelector(result.user, result.memberships);
      } else {
        // Single-org: auto-entered
        _passwordInput.value = '';
        saveSession(result.access_token, result.user, result.organization, result.refresh_token, [result.organization]);
        App.showApp();
      }
    } catch (err) {
      _showError(err.message || 'Login failed. Check your credentials.');
    } finally {
      Loading.btn(_loginBtn, false);
    }
  }

  function _showOrgSelector(user, memberships) {
    const nameEl = document.getElementById('org-selector-user-name');
    if (nameEl) nameEl.textContent = user.display_name || user.username;

    const orgList = document.getElementById('org-list');
    if (orgList) {
      orgList.innerHTML = memberships.map(m => `
        <div class="org-card" data-membership-id="${Utils.escapeHtml(m.membership_id)}" style="cursor:pointer;padding:14px 16px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;transition:background .15s">
          <div>
            <div style="font-weight:600;font-size:14px;color:var(--txt-1)">${Utils.escapeHtml(m.display_name)}</div>
            <div style="font-size:12px;color:var(--txt-3);margin-top:2px">${Utils.badgeHtml(m.role === 'admin' ? 'error' : m.role === 'manager' ? 'warning' : 'gray', Utils.capitalize(m.role))}</div>
          </div>
          <span style="color:var(--txt-4);font-size:18px">→</span>
        </div>`
      ).join('');

      // Hover effect
      orgList.querySelectorAll('.org-card').forEach(card => {
        card.addEventListener('mouseenter', () => { card.style.background = 'var(--surface-3)'; });
        card.addEventListener('mouseleave', () => { card.style.background = 'var(--surface-2)'; });
      });
    }

    const errEl = document.getElementById('org-selector-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.remove('visible'); }

    _showScreen('org');
  }

  async function _selectOrg(membershipId) {
    if (!_pendingToken) { _showScreen('login'); return; }

    const cards = document.querySelectorAll('#org-list [data-membership-id]');
    cards.forEach(c => c.style.opacity = '0.5');

    try {
      const result = await API.selectOrg(_pendingToken, membershipId);
      _pendingToken = null;
      _pendingUser  = null;

      saveSession(result.access_token, result.user, result.organization, result.refresh_token, _pendingMemberships);
      _pendingMemberships = [];
      App.showApp();
    } catch (err) {
      cards.forEach(c => c.style.opacity = '');
      const errEl = document.getElementById('org-selector-error');
      if (errEl) { errEl.textContent = err.message || 'Failed to enter workspace.'; errEl.classList.add('visible'); }
    }
  }

  /* ── Org switching (in-app) ──────────────────────────────── */
  async function switchOrg(membershipId) {
    try {
      const result = await API.switchOrg(membershipId);
      const currentUser = getUser();
      // Update stored org; keep same user object
      saveSession(result.access_token, currentUser, result.organization,
        sessionStorage.getItem(REFRESH_KEY), getMemberships());
      // Reload page data by navigating to dashboard
      App.showApp();
    } catch (err) {
      if (typeof Notify !== 'undefined') Notify.error('Switch failed', err.message);
    }
  }

  /* ── Logout ───────────────────────────────────────────────── */
  async function logout() {
    stopIdleWatch();
    _channel?.postMessage({ type: 'logout' });
    await API.logout();
    clearSession();
    App.showLogin();
  }

  /* ── JWT expiry helper ─────────────────────────────────────── */
  function _tokenExpiresAt(token) {
    try { const p = JSON.parse(atob(token.split('.')[1])); return p.exp ? p.exp * 1000 : null; }
    catch { return null; }
  }

  /* ── Session verification on page load ──────────────────── */
  async function checkSession() {
    console.log('[AUTH] restore started');
    const token = getToken();
    if (!token) { console.log('[AUTH] no token — showing login'); return false; }
    console.log('[AUTH] token restored');

    const expMs = _tokenExpiresAt(token);
    const now   = Date.now();

    if (expMs && now >= expMs) {
      // Token is expired. Attempt refresh.
      console.log('[AUTH] token expired — attempting refresh');
      const storedRefresh = sessionStorage.getItem(REFRESH_KEY);
      if (!storedRefresh) { console.log('[AUTH] no refresh token — clearing session'); clearSession(); return false; }
      try {
        const data = await API.refreshToken(storedRefresh, _getMembershipId());
        saveSession(data.access_token, getUser(), getOrganization(), data.refresh_token, getMemberships());
        console.log('[AUTH] token refreshed');
      } catch (err) {
        // 401 = actual auth failure (bad token, inactive user) → must logout.
        // 500/503/network = server issue → keep session; API calls will retry refresh.
        console.warn('[AUTH] refresh failed', err.status, err.message);
        if (err.status === 401 || !err.status) { clearSession(); return false; }
        // On 503/500: keep existing token and continue — app will show errors on API calls
      }
    } else if (expMs && expMs - now < 2 * 60 * 1000) {
      // Token expiring soon — proactive refresh, non-critical.
      const storedRefresh = sessionStorage.getItem(REFRESH_KEY);
      if (storedRefresh) {
        API.refreshToken(storedRefresh, _getMembershipId())
          .then(data => saveSession(data.access_token, getUser(), getOrganization(), data.refresh_token, getMemberships()))
          .catch(() => { /* non-critical: keep current token */ });
      }
    }

    const user = getUser();
    const org  = getOrganization();
    console.log('[AUTH] memberships restored:', getMemberships().length, 'entries');
    console.log('[AUTH] active org restored:', org?.organization_id, org?.role);
    console.log('[AUTH] user restored:', user?.user_id, user?.username);

    const ok = !!(user && org);
    console.log('[AUTH] validation', ok ? 'success' : 'FAILED — missing user or org');
    return ok;
  }

  /* ── Role-gate UI elements ─────────────────────────────────── */
  function applyRoleVisibility() {
    const org = getOrganization();
    if (!org) return;

    const LEVEL = { admin: 3, manager: 2, staff: 1, viewer: 1, operator: 1 };
    const level = LEVEL[org.role] || 0;

    document.querySelectorAll('[data-min-role]').forEach(el => {
      const required = LEVEL[el.dataset.minRole] || 0;
      el.style.display = level >= required ? '' : 'none';
    });

    document.querySelectorAll('[data-role]').forEach(el => {
      el.style.display = el.dataset.role === org.role ? '' : 'none';
    });
  }

  /* ── Cross-tab logout sync ─────────────────────────────────── */
  if (_channel) {
    _channel.onmessage = (e) => {
      if (e.data?.type === 'logout' && isLoggedIn()) {
        stopIdleWatch();
        clearSession();
        App.showLogin();
      }
    };
  }

  window.addEventListener('auth:logout', () => {
    stopIdleWatch();
    _channel?.postMessage({ type: 'logout' });
    clearSession();
    App.showLogin();
  });

  /* ── Public ───────────────────────────────────────────────── */
  return {
    init: _bindLoginUI,
    checkSession,
    logout,
    switchOrg,
    getUser,
    getOrganization,
    getMemberships,
    getToken,
    isLoggedIn,
    hasRole,
    saveSession,
    clearSession,
    startIdleWatch,
    stopIdleWatch,
    applyRoleVisibility,
  };
})();
