'use strict';

// ── HTTP entry points ─────────────────────────────────────────────────────────
// All read/auth actions are routed through doGet() using ?action=<name> params.
// doPost() is retained exclusively for upload actions (large CSV bodies).

function doGet(e) {
  return Routes.handleRequest(e);
}

function doPost(e) {
  return Routes.handleUpload(e);
}

// ── Router ────────────────────────────────────────────────────────────────────

var Routes = {

  handleRequest: function (e) {
    try {
      var action = e.parameter.action;
      var token  = e.parameter.token || '';
      var params = Routes._parseParams(e.parameter);

      // ── Public routes (no auth) ──────────────────────────────────────────
      if (action === 'ping') {
        return Response.success({ status: 'ok', version: CONFIG.APP.VERSION });
      }

      if (action === 'login') {
        return Response.fromResult(Auth.login(params.email, params.password));
      }

      if (action === 'bootstrapAdmin') {
        Auth.bootstrapAdminUser();
        return Response.success({ message: 'Bootstrap complete' });
      }

      // ── All other routes require a valid session ─────────────────────────
      var session;
      try {
        session = Auth.requireAuth(token);
      } catch (_) {
        return Response.error('Session expired or invalid. Please log in again.');
      }

      switch (action) {

        // ── Auth ─────────────────────────────────────────────────────────── //
        case 'logout':
          return Response.fromResult(Auth.logout(token));

        case 'verifySession':
          return Response.success({ user: session });

        // ── Dashboard ────────────────────────────────────────────────────── //
        case 'getDashboardKPIs':
          return Response.success(Inventory.getDashboardKPIs());

        // ── Inventory ────────────────────────────────────────────────────── //
        case 'searchBox':
          return Response.success(Inventory.searchBox(params.query));

        case 'getInventoryList':
        case 'getInventory':
          return Response.success(
            Inventory.getInventoryList(params.page, params.pageSize, params.search)
          );

        // ── Orders ───────────────────────────────────────────────────────── //
        case 'getOrders':
          return Response.success(
            Orders.getOrders(params.page, params.pageSize, params.filters)
          );

        case 'getPlatforms':
          return Response.success(Orders.getPlatforms());

        case 'getPerformanceData':
        case 'getPerformance':
          return Response.success(Orders.getPerformanceData(params.weeks));

        // ── Uploads ──────────────────────────────────────────────────────── //
        case 'getUploadHistory':
          return Response.success({ rows: Uploads.getUploadHistory(params.type) });

        // ── Users ────────────────────────────────────────────────────────── //
        case 'getUsers':
          Auth.requireRole(token, CONFIG.AUTH.ROLES.ADMIN);
          return Response.success(Users.getUsers());

        case 'createUser':
          Auth.requireRole(token, CONFIG.AUTH.ROLES.ADMIN);
          return Response.fromResult(Users.createUser(
            params.email,
            params.display_name || params.displayName,
            params.role,
            params.password
          ));

        case 'updateUser':
          Auth.requireRole(token, CONFIG.AUTH.ROLES.ADMIN);
          return Response.fromResult(Users.updateUser(params.userId, params.updates));

        case 'deleteUser':
          Auth.requireRole(token, CONFIG.AUTH.ROLES.ADMIN);
          return Response.fromResult(Users.deleteUser(params.userId));

        // ── System / Debug ───────────────────────────────────────────────── //
        case 'getSystemStatus':
          Auth.requireRole(token, CONFIG.AUTH.ROLES.ADMIN);
          return Response.success(Debug.getSystemStatus());

        case 'getLogs':
        case 'getDebugLogs':
          Auth.requireRole(token, CONFIG.AUTH.ROLES.ADMIN);
          return Response.success({
            entries: Debug.getLogs(params.limit, params.module, params.status)
          });

        default:
          return Response.error('Unknown action: ' + action);
      }

    } catch (err) {
      var msg = err.message || 'Unknown error';
      if (msg === 'UNAUTHORIZED') return Response.error('Session expired. Please log in again.');
      if (msg === 'FORBIDDEN')    return Response.error('You do not have permission for this action.');
      Debug.log('Routes', 'handleRequest', 'error', { error: msg });
      return Response.error(msg);
    }
  },

  // Upload actions still use POST because CSV payloads are too large for a URL.
  handleUpload: function (e) {
    try {
      var payload = JSON.parse(e.postData.contents);
      var action  = payload.action;
      var data    = payload.data  || {};
      var token   = payload.token || '';

      var session;
      try {
        session = Auth.requireRole(token, CONFIG.AUTH.ROLES.MANAGER);
      } catch (_) {
        return Response.error('Session expired or insufficient permissions.');
      }

      if (action === 'uploadInventory') {
        return Response.fromResult(
          Uploads.processInventoryUpload(data.csvText, data.filename, session.email)
        );
      }

      if (action === 'uploadOrders') {
        return Response.fromResult(
          Uploads.processOrdersUpload(data.csvText, data.filename, session.email)
        );
      }

      return Response.error('Unknown upload action: ' + action);

    } catch (err) {
      return Response.error(err.message || 'Upload request failed');
    }
  },

  // Parse e.parameter into a data object.
  // Numeric strings become numbers; JSON strings become objects/arrays.
  // 'action' and 'token' are excluded (handled separately).
  _parseParams: function (parameter) {
    var data = {};
    for (var key in parameter) {
      if (key === 'action' || key === 'token') continue;
      var raw = parameter[key];
      try {
        data[key] = JSON.parse(raw);
      } catch (_) {
        data[key] = raw;
      }
    }
    return data;
  }
};
