/* ============================================================
   auth.js — Login flow, session management, role guards.
             All communication uses fetch() via API module.
             Tokens stored in sessionStorage (cleared on tab close).
   ============================================================ */

const Auth = (() => {

  /* ── Session helpers ──────────────────────────────────────── */
  const REFRESH_KEY      = 'patman_refresh_token';
  const IDLE_TIMEOUT_MS  = 30 * 60 * 1000; // 30 minutes
  const _channel         = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('patman_auth') : null;
  let _idleTimer = null;

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

  const ROLE_LEVEL = { admin: 3, manager: 2, viewer: 1 };

  function hasRole(required) {
    const user = getUser();
    if (!user) return false;
    return (ROLE_LEVEL[user.role] || 0) >= (ROLE_LEVEL[required] || 0);
  }

  /* ── Login UI ─────────────────────────────────────────────── */
  let _loginForm     = null;
  let _loginError    = null;
  let _loginBtn      = null;
  let _usernameInput = null;
  let _passwordInput = null;

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
    const username = _usernameInput?.value.trim();
    const password = _passwordInput?.value;

    _hideError();

    if (!username || !password) {
      _showError('Please enter your username and password.');
      return;
    }

    Loading.btn(_loginBtn, true);

    try {
      const result = await API.login(username, password);
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
    stopIdleWatch();
    _channel?.postMessage({ type: 'logout' });
    await API.logout();
    clearSession();
    App.showLogin();
  }

  /* ── JWT expiry helper ──────────────────────────────────── */
  function _tokenExpiresAt(token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.exp ? payload.exp * 1000 : null;
    } catch { return null; }
  }

  /* ── Session verification on page load ──────────────────── */
  async function checkSession() {
    const token = getToken();
    if (!token) return false;

    const expMs = _tokenExpiresAt(token);
    const now   = Date.now();

    if (expMs && now >= expMs) {
      // Token fully expired — must refresh or fail
      const storedRefresh = sessionStorage.getItem(REFRESH_KEY);
      if (!storedRefresh) { clearSession(); return false; }
      try {
        const data = await API.refreshToken(storedRefresh);
        saveSession(data.access_token, getUser());
      } catch { clearSession(); return false; }
    } else if (expMs && expMs - now < 2 * 60 * 1000) {
      // Proactively refresh within 2 min of expiry (best-effort)
      const storedRefresh = sessionStorage.getItem(REFRESH_KEY);
      if (storedRefresh) {
        try {
          const data = await API.refreshToken(storedRefresh);
          saveSession(data.access_token, getUser());
        } catch { /* keep current token; it's still valid */ }
      }
    }

    const user = getUser();
    if (user) return true;
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

  /* ── Cross-tab logout sync ────────────────────────────────── */
  if (_channel) {
    _channel.onmessage = (e) => {
      if (e.data?.type === 'logout' && isLoggedIn()) {
        stopIdleWatch();
        clearSession();
        App.showLogin();
      }
    };
  }

  // api.js fires this when a refresh attempt fails (token fully expired)
  window.addEventListener('auth:logout', () => {
    stopIdleWatch();
    _channel?.postMessage({ type: 'logout' });
    clearSession();
    App.showLogin();
  });

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
    startIdleWatch,
    stopIdleWatch,
    applyRoleVisibility,
  };
})();
