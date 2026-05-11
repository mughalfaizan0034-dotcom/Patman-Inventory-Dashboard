/* ============================================================
   auth.js — Login flow, session management, role guards.
             All communication uses fetch() via API module.
             Tokens stored in sessionStorage (cleared on tab close).
   ============================================================ */

const Auth = (() => {

  /* ── Session helpers ──────────────────────────────────────── */
  const REFRESH_KEY = 'patman_refresh_token';

  function saveSession(token, user, refreshToken = null) {
    sessionStorage.setItem(CONFIG.SESSION_KEY, token);
    sessionStorage.setItem(CONFIG.USER_KEY, JSON.stringify(user));
    if (refreshToken) sessionStorage.setItem(REFRESH_KEY, refreshToken);
  }

  function clearSession() {
    sessionStorage.removeItem(CONFIG.SESSION_KEY);
    sessionStorage.removeItem(CONFIG.USER_KEY);
    sessionStorage.removeItem(REFRESH_KEY);
  }

  function getUser() {
    try {
      return JSON.parse(sessionStorage.getItem(CONFIG.USER_KEY)) || null;
    } catch { return null; }
  }

  function getToken() {
    return sessionStorage.getItem(CONFIG.SESSION_KEY) || null;
  }

  function isLoggedIn() {
    return !!getToken();
  }

  const ROLE_LEVEL = { admin: 3, manager: 2, viewer: 1 };

  function hasRole(required) {
    const user = getUser();
    if (!user) return false;
    return (ROLE_LEVEL[user.role] || 0) >= (ROLE_LEVEL[required] || 0);
  }

  /* ── Login UI ─────────────────────────────────────────────── */
  let _loginForm      = null;
  let _loginError     = null;
  let _loginBtn       = null;
  let _orgInput       = null;
  let _usernameInput  = null;
  let _passwordInput  = null;

  function _bindLoginUI() {
    _loginForm      = document.getElementById('login-form');
    _loginError     = document.getElementById('login-error');
    _loginBtn       = document.getElementById('login-btn');
    _orgInput       = document.getElementById('login-org');
    _usernameInput  = document.getElementById('login-username');
    _passwordInput  = document.getElementById('login-password');

    if (_loginForm) {
      _loginForm.addEventListener('submit', async e => {
        e.preventDefault();
        await _doLogin();
      });
    }
  }

  function _showError(msg) {
    if (_loginError) {
      _loginError.textContent = msg;
      _loginError.classList.add('visible');
    }
  }

  function _hideError() {
    if (_loginError) _loginError.classList.remove('visible');
  }

  async function _doLogin() {
    const organization = _orgInput?.value.trim();
    const username     = _usernameInput?.value.trim();
    const password     = _passwordInput?.value;

    _hideError();

    if (!organization || !username || !password) {
      _showError('Please enter your organization, username, and password.');
      return;
    }

    Loading.btn(_loginBtn, true);

    try {
      const result = await API.login(organization, username, password);
      saveSession(result.token, result.user, result.refresh_token || null);
      _passwordInput.value = '';
      App.showApp();
    } catch (err) {
      _showError(err.message || 'Login failed. Check your credentials.');
    } finally {
      Loading.btn(_loginBtn, false);
    }
  }

  /* ── Logout ───────────────────────────────────────────────── */
  async function logout() {
    await API.logout();
    clearSession();
    App.showLogin();
  }

  /* ── Session verification on page load ──────────────────── */
  async function checkSession() {
    if (!getToken()) return false;
    try {
      const result = await API.verifySession();
      if (result && result.user) {
        saveSession(getToken(), result.user);
        return true;
      }
    } catch { /* token invalid or expired */ }
    clearSession();
    return false;
  }

  /* ── Role-gate UI elements ──────────────────────────────── */
  function applyRoleVisibility() {
    const user = getUser();
    if (!user) return;

    const level = ROLE_LEVEL[user.role] || 0;

    document.querySelectorAll('[data-min-role]').forEach(el => {
      const required = ROLE_LEVEL[el.dataset.minRole] || 0;
      el.style.display = level >= required ? '' : 'none';
    });

    document.querySelectorAll('[data-role]').forEach(el => {
      el.style.display = el.dataset.role === user.role ? '' : 'none';
    });
  }

  /* ── Public ───────────────────────────────────────────────── */
  return {
    init:               _bindLoginUI,
    checkSession,
    logout,
    getUser,
    getToken,
    isLoggedIn,
    hasRole,
    saveSession,
    clearSession,
    applyRoleVisibility,
  };
})();
