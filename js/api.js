/* ============================================================
   api.js — Centralized fetch layer.

   When CLOUD_RUN_URL is set in CONFIG:
     Auth (login/refresh)         → _crPostRaw  Cloud Run  (no 401 interception)
     Protected data endpoints     → _crGet       Cloud Run  (Bearer + 401 auto-refresh)
     All other actions            → _get         Apps Script (query params)

   When CLOUD_RUN_URL is empty:
     Everything falls through to Apps Script GET transport.

   All fetch goes through this module.  No other file may call
   fetch() directly.
   ============================================================ */

const API = (() => {

  function getToken() {
    return sessionStorage.getItem(CONFIG.SESSION_KEY) || null;
  }

  /* ── 401 interceptor — auto-refresh + forced logout ──────── */
  let _refreshPromise = null;

  function _forceLogout() {
    sessionStorage.removeItem(CONFIG.SESSION_KEY);
    sessionStorage.removeItem(CONFIG.USER_KEY);
    sessionStorage.removeItem('patman_refresh_token');
    window.dispatchEvent(new CustomEvent('auth:logout'));
  }

  function _attemptRefresh() {
    if (_refreshPromise) return _refreshPromise;
    const storedRefresh = sessionStorage.getItem('patman_refresh_token');
    if (!storedRefresh) {
      _forceLogout();
      return Promise.reject(new Error('Session expired'));
    }
    _refreshPromise = _crPostRaw('/auth/refresh', { refresh_token: storedRefresh }, 0)
      .then(data => {
        sessionStorage.setItem(CONFIG.SESSION_KEY, data.access_token);
        if (data.refresh_token) sessionStorage.setItem('patman_refresh_token', data.refresh_token);
      })
      .catch(err => { _forceLogout(); throw err; })
      .finally(() => { _refreshPromise = null; });
    return _refreshPromise;
  }

  /* ── Cloud Run GET — raw, no 401 interception ───────────── */
  async function _crGetRaw(path, params = {}, retries = 0) {
    const tok = getToken();
    const url = new URL(CONFIG.CLOUD_RUN_URL + path);
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === '') continue;
      url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    const options = {
      method:  'GET',
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    };

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await _fetchWithTimeout(url.toString(), options, CONFIG.TIMEOUT_MS);
        return await _parseResponse(res);
      } catch (err) {
        lastErr = err;
        if (err.serverError || err.status === 401) throw err;
        if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  /* ── Cloud Run GET — with 401 auto-refresh ──────────────── */
  async function _crGet(path, params = {}, retries = 0) {
    try {
      return await _crGetRaw(path, params, retries);
    } catch (err) {
      if (err.status !== 401) throw err;
      await _attemptRefresh();
      return _crGetRaw(path, params, retries);
    }
  }

  /* ── Cloud Run POST — raw, no 401 interception ──────────── */
  async function _crPostRaw(path, body, retries = 0) {
    const tok = getToken();
    const options = {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      },
      body: JSON.stringify(body),
    };

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await _fetchWithTimeout(CONFIG.CLOUD_RUN_URL + path, options, CONFIG.TIMEOUT_MS);
        return await _parseResponse(res);
      } catch (err) {
        lastErr = err;
        if (err.serverError || err.status === 401) throw err;
        if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  /* ── Cloud Run POST — with 401 auto-refresh ─────────────── */
  async function _crPost(path, body, retries = 0) {
    try {
      return await _crPostRaw(path, body, retries);
    } catch (err) {
      if (err.status !== 401) throw err;
      await _attemptRefresh();
      return _crPostRaw(path, body, retries);
    }
  }

  /* ── Abort-controller timeout wrapper ────────────────────── */
  async function _fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);
      return res;
    } catch (err) {
      clearTimeout(id);
      if (err.name === 'AbortError') throw new Error('Request timed out. Please try again.');
      throw err;
    }
  }

  /* ── Shared response parser ──────────────────────────────── */
  async function _parseResponse(res) {
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* non-JSON — fall through to status check */ }

    if (!res.ok) {
      const message = parsed?.error || `HTTP ${res.status}: ${res.statusText}`;
      const err = new Error(message);
      err.status = res.status;
      if (parsed?.success === false) err.serverError = true;
      throw err;
    }

    if (parsed?.success === false) {
      const err = new Error(parsed.error || 'Server returned an error.');
      err.serverError = true;
      throw err;
    }
    return parsed?.data !== undefined ? parsed.data : parsed;
  }

  /* ── GET request — Apps Script primary transport ─────────── */
  async function _get(action, params = {}, retries = CONFIG.MAX_RETRIES) {
    const url = new URL(CONFIG.API_URL);
    url.searchParams.set('action', action);
    const tok = getToken();
    if (tok) url.searchParams.set('token', tok);

    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === '') continue;
      url.searchParams.set(
        key,
        typeof value === 'object' ? JSON.stringify(value) : String(value)
      );
    }

    const options = { method: 'GET', redirect: 'follow' };

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await _fetchWithTimeout(url.toString(), options, CONFIG.TIMEOUT_MS);
        return await _parseResponse(res);
      } catch (err) {
        lastErr = err;
        if (err.serverError) throw err;
        if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  /* ── POST request — uploads only (large CSV bodies) ─────── */
  async function _post(action, data = {}, retries = 0) {
    const body = JSON.stringify({ action, data, token: getToken() });
    const options = {
      method:   'POST',
      redirect: 'follow',
      headers:  { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
    };

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await _fetchWithTimeout(CONFIG.API_URL, options, CONFIG.TIMEOUT_MS);
        return await _parseResponse(res);
      } catch (err) {
        lastErr = err;
        if (err.serverError) throw err;
        if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  /* ── Public API methods ─────────────────────────────────── */
  return {

    /* Auth — Cloud Run only. Fails closed if CLOUD_RUN_URL is not configured. */
    async login(username, password) {
      if (!CONFIG.CLOUD_RUN_URL) {
        throw new Error('Authentication service not configured. Contact your administrator.');
      }
      const data = await _crPostRaw('/auth/login', { username, password }, 0);
      return { token: data.access_token, refresh_token: data.refresh_token, user: data.user };
    },

    async logout() {
      // JWT is stateless — nothing to revoke server-side until token revocation is implemented.
      sessionStorage.removeItem(CONFIG.SESSION_KEY);
      sessionStorage.removeItem(CONFIG.USER_KEY);
      sessionStorage.removeItem('patman_refresh_token');
    },

    async refreshToken(refreshToken) {
      return _crPostRaw('/auth/refresh', { refresh_token: refreshToken }, 0);
    },

    async verifySession() {
      // JWT sessions are validated locally — no round-trip needed.
      // Expiry enforcement is handled by checkSession() via _tokenExpiresAt().
      const user = JSON.parse(sessionStorage.getItem(CONFIG.USER_KEY) || 'null');
      if (user) return { user };
      throw new Error('No session');
    },

    /* Dashboard */
    async getDashboardKPIs() {
      return _get('getDashboardKPIs');
    },

    /* Performance */
    async getPerformanceData(weeks = 12) {
      return _get('getPerformanceData', { weeks });
    },

    /* Inventory / Box Lookup */
    async searchBox(query) {
      return _get('searchBox', { query });
    },

    async getInventoryList(page = 1, pageSize = CONFIG.PAGE_SIZE, search = '') {
      if (CONFIG.CLOUD_RUN_URL) return _crGet('/inventory', { page, pageSize, search });
      return _get('getInventoryList', { page, pageSize, search });
    },

    /* Orders */
    async getOrders(page = 1, pageSize = CONFIG.PAGE_SIZE, filters = {}) {
      return _get('getOrders', { page, pageSize, filters });
    },

    async getPlatforms() {
      return _get('getPlatforms');
    },

    /* Uploads — POST because CSV data is too large for a URL */
    async uploadInventory(csvText, filename) {
      return _post('uploadInventory', { csvText, filename }, 0);
    },

    async uploadOrders(csvText, filename) {
      return _post('uploadOrders', { csvText, filename }, 0);
    },

    async getUploadHistory(type = '') {
      return _get('getUploadHistory', { type });
    },

    /* Users */
    async getUsers() {
      return _get('getUsers');
    },

    async createUser(userData) {
      return _get('createUser', userData, 0);
    },

    async updateUser(userId, updates) {
      return _get('updateUser', { userId, updates }, 0);
    },

    async deleteUser(userId) {
      return _get('deleteUser', { userId }, 0);
    },

    /* System */
    async ping() {
      return _get('ping', {}, 0);
    },

    async getSystemStatus() {
      return _get('getSystemStatus');
    },

    async getLogs() {
      return _get('getLogs');
    },

    async bootstrapAdmin() {
      return _get('bootstrapAdmin', {}, 0);
    },
  };
})();
