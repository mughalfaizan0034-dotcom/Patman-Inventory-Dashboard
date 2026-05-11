'use strict';

var Orders = {

  getOrders: function (page, pageSize, filters) {
    page     = Math.max(1, parseInt(page)     || 1);
    pageSize = Math.min(200, parseInt(pageSize) || 50);
    var offset = (page - 1) * pageSize;

    var ord = BQ.tableRef(CONFIG.BQ.TABLES.ORDERS);
    var inv = BQ.tableRef(CONFIG.BQ.TABLES.INVENTORY);

    filters = filters || {};
    var conds = [];

    if (filters.platform) conds.push("o.platform = '" + Util.escapeSql(filters.platform) + "'");
    if (filters.dateFrom) conds.push("DATE(o.order_date) >= '" + Util.escapeSql(filters.dateFrom) + "'");
    if (filters.dateTo)   conds.push("DATE(o.order_date) <= '" + Util.escapeSql(filters.dateTo) + "'");
    if (filters.search) {
      var s = Util.escapeSql(filters.search);
      conds.push(
        "(o.order_id LIKE '%" + s + "%'" +
        " OR o.sku LIKE '%" + s + "%'" +
        " OR o.upc LIKE '%" + s + "%')"
      );
    }

    // Status filter requires the inventory LEFT JOIN result
    var needsInvJoin = !!filters.status;
    if (filters.status === 'undefined') conds.push('i.sku IS NULL');
    if (filters.status === 'matched')   conds.push('i.sku IS NOT NULL');

    var where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    // Always join inventory so is_undefined_sku can be computed
    var dataSql = [
      'SELECT',
      '  o.order_id,',
      '  o.order_date,',
      '  o.sku,',
      '  o.upc,',
      '  CAST(o.quantity_sold AS INT64)                       AS quantity_sold,',
      "  COALESCE(o.platform, '')                             AS platform,",
      "  COALESCE(o.shipped_from_box, '')                     AS shipped_from_box,",
      '  CASE WHEN i.sku IS NULL THEN TRUE ELSE FALSE END     AS is_undefined_sku',
      'FROM `' + ord + '` o',
      'LEFT JOIN `' + inv + '` i ON o.sku = i.sku',
      where,
      'ORDER BY o.order_date DESC, o.order_id',
      'LIMIT ' + pageSize + ' OFFSET ' + offset
    ].join('\n');

    // Count query needs the inventory join only when status filter is active
    var countJoin  = needsInvJoin ? 'LEFT JOIN `' + inv + '` i ON o.sku = i.sku' : '';
    var countSql   = [
      'SELECT COUNT(*) AS total',
      'FROM `' + ord + '` o',
      countJoin,
      where
    ].join('\n');

    var items     = BQ.runQuery(dataSql) || [];
    var countRows = BQ.runQuery(countSql);
    var total     = countRows && countRows[0] ? Number(countRows[0].total) : 0;

    // Return rows + top-level total to match frontend expectations
    return { rows: items, total: total };
  },

  getOrderStats: function () {
    var sql = [
      'SELECT',
      '  COUNT(DISTINCT order_id)             AS total_orders,',
      '  SUM(CAST(quantity_sold AS INT64))     AS total_units_sold,',
      '  COUNT(DISTINCT platform)             AS platform_count,',
      '  COUNT(DISTINCT sku)                  AS unique_skus',
      'FROM `' + BQ.tableRef(CONFIG.BQ.TABLES.ORDERS) + '`'
    ].join('\n');

    var rows = BQ.runQuery(sql);
    if (!rows || !rows.length) return { totalOrders: 0, totalUnitsSold: 0, platformCount: 0, uniqueSkus: 0 };

    var r = rows[0];
    return {
      totalOrders:    Number(r.total_orders)     || 0,
      totalUnitsSold: Number(r.total_units_sold) || 0,
      platformCount:  Number(r.platform_count)   || 0,
      uniqueSkus:     Number(r.unique_skus)      || 0
    };
  },

  getPlatforms: function () {
    var sql = [
      'SELECT DISTINCT platform',
      'FROM `' + BQ.tableRef(CONFIG.BQ.TABLES.ORDERS) + '`',
      "WHERE platform IS NOT NULL AND TRIM(platform) != ''",
      'ORDER BY platform'
    ].join('\n');

    return (BQ.runQuery(sql) || []).map(function (r) { return r.platform; });
  },

  getPerformanceData: function (weeks) {
    weeks = Math.min(52, parseInt(weeks) || 12);
    var ord = BQ.tableRef(CONFIG.BQ.TABLES.ORDERS);
    var inv = BQ.tableRef(CONFIG.BQ.TABLES.INVENTORY);

    var weeklySql = [
      "SELECT",
      "  FORMAT_DATE('%G-W%V', DATE(order_date))  AS week_label,",
      "  DATE_TRUNC(DATE(order_date), WEEK)        AS week_start,",
      "  COUNT(DISTINCT order_id)                  AS order_count,",
      "  SUM(CAST(quantity_sold AS INT64))          AS units_sold",
      'FROM `' + ord + '`',
      'WHERE DATE(order_date) >= DATE_SUB(CURRENT_DATE(), INTERVAL ' + weeks + ' WEEK)',
      'GROUP BY week_label, week_start',
      'ORDER BY week_start'
    ].join('\n');

    var platformSql = [
      "SELECT",
      "  COALESCE(NULLIF(TRIM(platform),''), 'Unknown')  AS platform,",
      "  COUNT(DISTINCT order_id)                         AS order_count,",
      "  SUM(CAST(quantity_sold AS INT64))                AS units_sold",
      'FROM `' + ord + '`',
      'GROUP BY platform',
      'ORDER BY units_sold DESC',
      'LIMIT 10'
    ].join('\n');

    var topSkuSql = [
      'SELECT',
      '  o.sku,',
      '  SUM(CAST(o.quantity_sold AS INT64))          AS units_sold,',
      '  CASE WHEN i.sku IS NULL THEN TRUE ELSE FALSE END AS is_undefined',
      'FROM `' + ord + '` o',
      'LEFT JOIN `' + inv + '` i ON o.sku = i.sku',
      'GROUP BY o.sku, is_undefined',
      'ORDER BY units_sold DESC',
      'LIMIT 20'
    ].join('\n');

    var monthlySql = [
      "SELECT",
      "  FORMAT_DATE('%Y-%m', DATE(order_date))  AS month_label,",
      "  DATE_TRUNC(DATE(order_date), MONTH)      AS month_start,",
      "  COUNT(DISTINCT order_id)                 AS order_count,",
      "  SUM(CAST(quantity_sold AS INT64))         AS units_sold",
      'FROM `' + ord + '`',
      'GROUP BY month_label, month_start',
      'ORDER BY month_start DESC',
      'LIMIT 12'
    ].join('\n');

    return {
      weekly:    BQ.runQuery(weeklySql)   || [],
      platforms: BQ.runQuery(platformSql) || [],
      topSkus:   BQ.runQuery(topSkuSql)   || [],
      monthly:   BQ.runQuery(monthlySql)  || []
    };
  }
};
