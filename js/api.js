/* ============================================================
   api.js — Centralized fetch layer.

   When CLOUD_RUN_URL is set in CONFIG:
     Auth (login/refresh/verify)  → POST  Cloud Run  (JSON body)
     All other actions            → GET   Apps Script (query params)

   When CLOUD_RUN_URL is empty:
     Everything falls through to Apps Script GET transport.

   All fetch goes through this module.  No other file may call
   fetch() directly.
   ============================================================ */

const API = (() => {

  function getToken() {
    return sessionStorage.getItem(CONFIG.SESSION_KEY) || null;
  }

  /* ── Cloud Run POST — JSON body, Bearer auth ────────────── */
  async function _crPost(path, body, retries = 0) {
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
        if (err.serverError) throw err;
        if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    throw lastErr;
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
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error('Invalid response from server.'); }
    if (parsed.success === false) {
      const err = new Error(parsed.error || 'Server returned an error.');
      err.serverError = true;
      throw err;
    }
    return parsed.data !== undefined ? parsed.data : parsed;
  }

  /* ── GET request — primary transport ─────────────────────── */
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

    /* Auth — Cloud Run when available, Apps Script fallback */
    async login(organization, username, password) {
      if (CONFIG.CLOUD_RUN_URL) {
        const data = await _crPost('/auth/login', { organization, username, password }, 0);
        // Normalize Cloud Run response to shape Auth.saveSession() expects
        return { token: data.access_token, refresh_token: data.refresh_token, user: data.user };
      }
      // Apps Script fallback: temporary, org/username not supported there
      return _get('login', { email: username, password }, 0);
    },

    async logout() {
      try { await _get('logout', {}, 0); } catch { /* best-effort */ }
      sessionStorage.removeItem(CONFIG.SESSION_KEY);
      sessionStorage.removeItem(CONFIG.USER_KEY);
      sessionStorage.removeItem('patman_refresh_token');
    },

    async verifySession() {
      if (CONFIG.CLOUD_RUN_URL) {
        // JWT is stateless — if the token parses, session is valid.
        // Return the user from local storage rather than making a round-trip.
        const user = JSON.parse(sessionStorage.getItem(CONFIG.USER_KEY) || 'null');
        if (user) return { user };
        throw new Error('No session');
      }
      return _get('verifySession', {}, 0);
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
