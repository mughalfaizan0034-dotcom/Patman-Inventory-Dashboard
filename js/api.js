/* ============================================================
   api.js — Cloud Run API client.

   Transport functions:
     _crGet(path, params)      — GET  with Bearer token + 401 auto-refresh
     _crPost(path, body)       — POST JSON with Bearer token + 401 auto-refresh
     _crPatch(path, body)      — PATCH JSON with Bearer token + 401 auto-refresh
     _crDelete(path)           — DELETE with Bearer token + 401 auto-refresh
     _crMultipart(path, file)  — POST multipart/form-data (file uploads)

   Auth endpoints use raw transport to break the refresh retry loop.
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
    sessionStorage.removeItem(CONFIG.ORG_KEY);
    sessionStorage.removeItem(CONFIG.MEMBERSHIPS_KEY);
    sessionStorage.removeItem('patman_refresh_token');
    window.dispatchEvent(new CustomEvent('auth:logout'));
  }

  function _attemptRefresh() {
    if (_refreshPromise) return _refreshPromise;
    const storedRefresh   = sessionStorage.getItem('patman_refresh_token');
    const storedMembershipId = _getMembershipIdFromToken();
    if (!storedRefresh) { _forceLogout(); return Promise.reject(new Error('Session expired')); }
    _refreshPromise = _crPostRaw('/auth/refresh', { refresh_token: storedRefresh, membership_id: storedMembershipId })
      .then(data => {
        sessionStorage.setItem(CONFIG.SESSION_KEY, data.access_token);
        if (data.refresh_token) sessionStorage.setItem('patman_refresh_token', data.refresh_token);
      })
      .catch(err => {
        // Only force-logout on 401 (token invalid, user inactive).
        // 503/500/network errors = server issue — keep session so the user is not
        // ejected due to a backend outage or a missing BigQuery table.
        if (!err.status || err.status === 401) _forceLogout();
        throw err;
      })
      .finally(() => { _refreshPromise = null; });
    return _refreshPromise;
  }

  function _getMembershipIdFromToken() {
    const token = getToken();
    if (!token) return null;
    try {
      return JSON.parse(atob(token.split('.')[1])).membership_id || null;
    } catch { return null; }
  }

  /* ── Shared fetch helpers ────────────────────────────────── */
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

  async function _parseResponse(res) {
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* non-JSON — fall through */ }

    if (!res.ok) {
      const message = parsed?.error || `HTTP ${res.status}: ${res.statusText}`;
      const err     = new Error(message);
      err.status    = res.status;
      if (parsed?.success === false) err.serverError = true;
      throw err;
    }

    if (parsed?.success === false) {
      const err     = new Error(parsed.error || 'Server returned an error.');
      err.serverError = true;
      throw err;
    }
    return parsed?.data !== undefined ? parsed.data : parsed;
  }

  /* ── GET ─────────────────────────────────────────────────── */
  async function _crGetRaw(path, params = {}) {
    const tok = getToken();
    const url = new URL(CONFIG.CLOUD_RUN_URL + path);
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === '') continue;
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const res = await _fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    }, CONFIG.TIMEOUT_MS);
    return _parseResponse(res);
  }

  async function _crGet(path, params = {}) {
    try { return await _crGetRaw(path, params); }
    catch (err) {
      if (err.status !== 401) throw err;
      await _attemptRefresh();
      return _crGetRaw(path, params);
    }
  }

  /* ── GET (raw Blob — for CSV exports) ───────────────────── */
  async function _crGetBlobRaw(path, params = {}) {
    const tok = getToken();
    const url = new URL(CONFIG.CLOUD_RUN_URL + path);
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    const res = await _fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    }, 120000);
    if (!res.ok) {
      const err = new Error(`Export failed: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.blob();
  }

  async function _crGetBlob(path, params = {}) {
    try { return await _crGetBlobRaw(path, params); }
    catch (err) {
      if (err.status !== 401) throw err;
      await _attemptRefresh();
      return _crGetBlobRaw(path, params);
    }
  }

  /* ── POST ────────────────────────────────────────────────── */
  async function _crPostRaw(path, body) {
    const tok = getToken();
    const res = await _fetchWithTimeout(CONFIG.CLOUD_RUN_URL + path, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      body:    JSON.stringify(body),
    }, CONFIG.TIMEOUT_MS);
    return _parseResponse(res);
  }

  async function _crPost(path, body) {
    try { return await _crPostRaw(path, body); }
    catch (err) {
      if (err.status !== 401) throw err;
      await _attemptRefresh();
      return _crPostRaw(path, body);
    }
  }

  /* ── PATCH ───────────────────────────────────────────────── */
  async function _crPatchRaw(path, body) {
    const tok = getToken();
    const res = await _fetchWithTimeout(CONFIG.CLOUD_RUN_URL + path, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      body:    JSON.stringify(body),
    }, CONFIG.TIMEOUT_MS);
    return _parseResponse(res);
  }

  async function _crPatch(path, body) {
    try { return await _crPatchRaw(path, body); }
    catch (err) {
      if (err.status !== 401) throw err;
      await _attemptRefresh();
      return _crPatchRaw(path, body);
    }
  }

  /* ── DELETE ──────────────────────────────────────────────── */
  async function _crDeleteRaw(path, body) {
    const tok = getToken();
    const headers = tok ? { Authorization: `Bearer ${tok}` } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await _fetchWithTimeout(CONFIG.CLOUD_RUN_URL + path, {
      method:  'DELETE',
      headers,
      body:    body !== undefined ? JSON.stringify(body) : undefined,
    }, CONFIG.TIMEOUT_MS);
    return _parseResponse(res);
  }

  async function _crDelete(path, body) {
    try { return await _crDeleteRaw(path, body); }
    catch (err) {
      if (err.status !== 401) throw err;
      await _attemptRefresh();
      return _crDeleteRaw(path, body);
    }
  }

  /* ── MULTIPART (file upload) ─────────────────────────────── */
  // Sends a File object as multipart/form-data.
  // Do NOT set Content-Type — the browser sets it with the boundary automatically.
  async function _crMultipartRaw(path, file) {
    const tok      = getToken();
    const formData = new FormData();
    formData.append('file', file, file.name);
    const res = await _fetchWithTimeout(CONFIG.CLOUD_RUN_URL + path, {
      method:  'POST',
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      body:    formData,
    }, CONFIG.TIMEOUT_MS);
    return _parseResponse(res);
  }

  async function _crMultipart(path, file) {
    try { return await _crMultipartRaw(path, file); }
    catch (err) {
      if (err.status !== 401) throw err;
      await _attemptRefresh();
      return _crMultipartRaw(path, file);
    }
  }

  /* ── Public API ─────────────────────────────────────────── */
  return {

    /* Auth — raw transport: never trigger 401 refresh on auth endpoints */
    async login(username, password) {
      const data = await _crPostRaw('/auth/login', { username, password });
      // data shape differs: single-org vs multi-org
      return data;
    },

    async selectOrg(pendingToken, membershipId) {
      const res = await _fetchWithTimeout(CONFIG.CLOUD_RUN_URL + '/auth/select-org', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pendingToken}` },
        body:    JSON.stringify({ membership_id: membershipId }),
      }, CONFIG.TIMEOUT_MS);
      return _parseResponse(res);
    },

    async switchOrg(membershipId) {
      return _crPost('/auth/switch-org', { membership_id: membershipId });
    },

    async logout() {
      sessionStorage.removeItem(CONFIG.SESSION_KEY);
      sessionStorage.removeItem(CONFIG.USER_KEY);
      sessionStorage.removeItem(CONFIG.ORG_KEY);
      sessionStorage.removeItem(CONFIG.MEMBERSHIPS_KEY);
      sessionStorage.removeItem('patman_refresh_token');
    },

    async refreshToken(refreshToken, membershipId) {
      return _crPostRaw('/auth/refresh', { refresh_token: refreshToken, membership_id: membershipId });
    },

    async verifySession() {
      const user = JSON.parse(sessionStorage.getItem(CONFIG.USER_KEY) || 'null');
      if (user) return { user };
      throw new Error('No session');
    },

    /* Dashboard */
    async getDashboardKPIs()                        { return _crGet('/dashboard/kpis'); },
    async getPerformanceData(weeks=12, platform='') { return _crGet('/dashboard/performance', { weeks, ...(platform ? { platform } : {}) }); },
    async getInventoryAnalytics()                   { return _crGet('/dashboard/inventory-analytics'); },

    /* Lookup */
    async lookup(query) { return _crGet('/lookup', { query }); },

    /* Inventory */
    async searchBox(query)                                    { return _crGet('/inventory', { search: query, pageSize: 10, page: 1 }); },
    async getInventoryList(page=1, pageSize=CONFIG.PAGE_SIZE, search='', options={}) { return _crGet('/inventory', { page, pageSize, search, ...options }); },
    async exportInventory(filters={}) { return _crGetBlob('/inventory/export', filters); },

    /* Orders */
    async getOrders(page=1, pageSize=CONFIG.PAGE_SIZE, filters={}) { return _crGet('/orders', { page, pageSize, ...filters }); },
    async exportOrders(filters={})    { return _crGetBlob('/orders/export', filters); },
    async getPlatforms()                                            { return _crGet('/orders/platforms'); },
    async deleteOrders(payload)                                     { return _crDelete('/orders/rows', payload); },
    async updateOrder(rowId, updates)                               { return _crPatch(`/orders/${encodeURIComponent(rowId)}`, updates); },

    /* Inventory */
    async getInventoryAlternatives(sku)                                        { return _crGet('/inventory/alternatives', { sku }); },
    async updateInventory(originalSku, updates)                                { return _crPatch(`/inventory/${encodeURIComponent(originalSku)}`, updates); },
    async deleteInventoryRows(skus)                                            { return _crDelete('/inventory/rows', { skus }); },

    /* Activity */
    async getActivity(limit=10)                                                { return _crGet('/activity', { limit }); },

    /* Uploads — file is a File object (multipart) */
    async uploadInventory(file) { return _crMultipart('/uploads/inventory', file); },
    async uploadOrders(file)    { return _crMultipart('/uploads/orders', file); },
    async getUploadHistory(type='') { return _crGet('/uploads/history', { type }); },
    async downloadTemplate(type)    { return _crGet(`/uploads/template/${type}`); },

    /* Users / Memberships */
    async getUsers()                         { return _crGet('/users'); },
    async createUser(userData)               { return _crPost('/users', userData); },
    async updateUser(membershipId, updates)  { return _crPatch(`/users/${membershipId}`, updates); },
    async deleteUser(membershipId)           { return _crDelete(`/users/${membershipId}`); },

    /* Memberships */
    async getMemberships()                   { return _crGet('/memberships'); },
    async addMembership(userId, role)        { return _crPost('/memberships', { user_id: userId, role }); },
    async updateMembership(id, updates)      { return _crPatch(`/memberships/${id}`, updates); },
    async removeMembership(id)               { return _crDelete(`/memberships/${id}`); },

    /* Organizations */
    async getOrganizations()                 { return _crGet('/organizations'); },
    async createOrganization(data)           { return _crPost('/organizations', data); },
    async updateOrganization(id, updates)    { return _crPatch(`/organizations/${id}`, updates); },

    /* System */
    async ping()              { return _crGet('/health'); },
    async getSystemStatus()   { return _crGet('/health'); },
    async getLogs()           { return { entries: [] }; },
  };
})();
