'use strict';

var Inventory = {

  // Dashboard KPIs — all calculated server-side in BigQuery.
  getDashboardKPIs: function () {
    var inv    = BQ.tableRef(CONFIG.BQ.TABLES.INVENTORY);
    var ord    = BQ.tableRef(CONFIG.BQ.TABLES.ORDERS);
    var invUpl = BQ.tableRef(CONFIG.BQ.TABLES.INVENTORY_UPLOADS);
    var ordUpl = BQ.tableRef(CONFIG.BQ.TABLES.ORDER_UPLOADS);

    var kpiSql = [
      'WITH sku_calc AS (',
      '  SELECT',
      '    i.sku,',
      '    CAST(i.quantity AS INT64)                                             AS initial_stock,',
      '    COALESCE(SUM(CAST(o.quantity_sold AS INT64)), 0)                      AS units_sold,',
      '    GREATEST(0, COALESCE(SUM(CAST(o.quantity_sold AS INT64)), 0)',
      '               - CAST(i.quantity AS INT64))                               AS phantom_units,',
      '    GREATEST(0, CAST(i.quantity AS INT64)',
      '               - COALESCE(SUM(CAST(o.quantity_sold AS INT64)), 0))        AS remaining_stock',
      '  FROM `' + inv + '` i',
      '  LEFT JOIN `' + ord + '` o ON i.sku = o.sku',
      '  GROUP BY i.sku, i.quantity',
      '),',
      'undef AS (',
      '  SELECT COALESCE(SUM(CAST(o.quantity_sold AS INT64)), 0) AS undefined_sku_sales',
      '  FROM `' + ord + '` o',
      '  LEFT JOIN `' + inv + '` i ON o.sku = i.sku',
      '  WHERE i.sku IS NULL',
      ')',
      'SELECT',
      '  COUNT(DISTINCT s.sku)                                    AS total_skus,',
      '  SUM(s.initial_stock)                                     AS total_units,',
      '  SUM(s.units_sold)                                        AS units_sold,',
      '  SUM(s.phantom_units)                                     AS phantom_units,',
      '  SUM(s.remaining_stock)                                   AS remaining_stock,',
      '  u.undefined_sku_sales,',
      '  (SELECT COUNT(DISTINCT CASE',
      '     WHEN platform IS NOT NULL AND TRIM(platform) != \'\' THEN platform END)',
      '   FROM `' + ord + '`)                                     AS active_platforms,',
      '  (SELECT CAST(MAX(uploaded_at) AS STRING)',
      '   FROM (SELECT uploaded_at FROM `' + invUpl + '`',
      '         UNION ALL',
      '         SELECT uploaded_at FROM `' + ordUpl + '`))        AS last_upload_date',
      'FROM sku_calc s',
      'CROSS JOIN undef u'
    ].join('\n');

    var rows = BQ.runQuery(kpiSql);
    var r    = (rows && rows.length) ? rows[0] : {};

    var result = {
      totalSkus:         Number(r.total_skus)         || 0,
      totalUnits:        Number(r.total_units)        || 0,
      unitsSold:         Number(r.units_sold)         || 0,
      phantomUnits:      Number(r.phantom_units)      || 0,
      remainingStock:    Number(r.remaining_stock)    || 0,
      undefinedSkuSales: Number(r.undefined_sku_sales)|| 0,
      activePlatforms:   Number(r.active_platforms)   || 0,
      lastUploadDate:    r.last_upload_date            || null
    };

    // Recent activity — last 5 completed uploads
    try {
      var actSql = [
        'SELECT filename, type AS upload_type, uploaded_at, status',
        'FROM (',
        '  SELECT filename, type, uploaded_at, status FROM `' + invUpl + '`',
        '  UNION ALL',
        '  SELECT filename, type, uploaded_at, status FROM `' + ordUpl + '`',
        ')',
        "WHERE status IN ('success', 'failed')",
        'ORDER BY uploaded_at DESC',
        'LIMIT 5'
      ].join('\n');

      var actRows = BQ.runQuery(actSql) || [];
      result.recentActivity = actRows.map(function (a) {
        var isInv = a.upload_type === 'inventory';
        return {
          icon:  a.status === 'success' ? (isInv ? '📦' : '🛒') : '⚠️',
          title: (a.status === 'success' ? 'Uploaded ' : 'Upload failed: ') +
                 (a.filename || (isInv ? 'inventory' : 'orders')),
          date:  a.uploaded_at
        };
      });
    } catch (_) {
      result.recentActivity = [];
    }

    return result;
  },

  // Paginated inventory list with per-SKU stock calculations.
  getInventoryList: function (page, pageSize, search) {
    page     = Math.max(1, parseInt(page)     || 1);
    pageSize = Math.min(200, parseInt(pageSize) || 50);
    var offset = (page - 1) * pageSize;

    var inv = BQ.tableRef(CONFIG.BQ.TABLES.INVENTORY);
    var ord = BQ.tableRef(CONFIG.BQ.TABLES.ORDERS);

    var searchWhere = '';
    if (search && search.trim()) {
      var s = Util.escapeSql(search.trim());
      searchWhere = [
        "WHERE i.sku LIKE '%" + s + "%'",
        "   OR i.upc LIKE '%" + s + "%'",
        "   OR i.part_number LIKE '%" + s + "%'",
        "   OR i.box_number LIKE '%" + s + "%'"
      ].join('\n');
    }

    var dataSql = [
      'SELECT',
      '  i.sku,',
      '  i.box_number,',
      '  i.part_number,',
      '  i.upc,',
      '  CAST(i.quantity AS INT64)                                          AS initial_stock,',
      '  COALESCE(SUM(CAST(o.quantity_sold AS INT64)), 0)                   AS units_sold,',
      '  GREATEST(0, COALESCE(SUM(CAST(o.quantity_sold AS INT64)), 0)',
      '              - CAST(i.quantity AS INT64))                            AS phantom_units,',
      '  GREATEST(0, CAST(i.quantity AS INT64)',
      '              - COALESCE(SUM(CAST(o.quantity_sold AS INT64)), 0))     AS remaining_stock,',
      '  i.date_added,',
      '  i.notes',
      'FROM `' + inv + '` i',
      'LEFT JOIN `' + ord + '` o ON i.sku = o.sku',
      searchWhere,
      'GROUP BY i.sku, i.box_number, i.part_number, i.upc, i.quantity, i.date_added, i.notes',
      'ORDER BY CAST(i.box_number AS STRING), i.sku',
      'LIMIT ' + pageSize + ' OFFSET ' + offset
    ].join('\n');

    var countSql = [
      'SELECT COUNT(DISTINCT i.sku) AS total',
      'FROM `' + inv + '` i',
      searchWhere
    ].join('\n');

    var items     = BQ.runQuery(dataSql) || [];
    var countRows = BQ.runQuery(countSql);
    var total     = countRows && countRows[0] ? Number(countRows[0].total) : 0;

    return { items: items, total: total };
  },

  // Box Lookup — search by SKU, UPC, part number, or box number.
  searchBox: function (query) {
    if (!query || !query.trim()) return { items: [] };

    var q   = Util.escapeSql(query.trim());
    var inv = BQ.tableRef(CONFIG.BQ.TABLES.INVENTORY);
    var ord = BQ.tableRef(CONFIG.BQ.TABLES.ORDERS);

    var sql = [
      'WITH matches AS (',
      '  SELECT DISTINCT i.sku',
      '  FROM `' + inv + '` i',
      "  WHERE i.sku         = '" + q + "'",
      "     OR i.upc         = '" + q + "'",
      "     OR i.part_number = '" + q + "'",
      "     OR LOWER(i.sku)         LIKE LOWER('%" + q + "%')",
      "     OR LOWER(i.upc)         LIKE LOWER('%" + q + "%')",
      "     OR LOWER(i.part_number) LIKE LOWER('%" + q + "%')",
      '),',
      'sku_stats AS (',
      '  SELECT',
      '    i.sku,',
      '    i.box_number,',
      '    i.part_number,',
      '    i.upc,',
      '    CAST(i.quantity AS INT64)                                        AS initial_stock,',
      '    COALESCE(SUM(CAST(o.quantity_sold AS INT64)), 0)                 AS units_sold,',
      '    GREATEST(0, COALESCE(SUM(CAST(o.quantity_sold AS INT64)), 0)',
      '                - CAST(i.quantity AS INT64))                          AS phantom_units,',
      '    GREATEST(0, CAST(i.quantity AS INT64)',
      '                - COALESCE(SUM(CAST(o.quantity_sold AS INT64)), 0))   AS remaining_stock',
      '  FROM `' + inv + '` i',
      '  LEFT JOIN `' + ord + '` o ON i.sku = o.sku',
      '  WHERE i.sku IN (SELECT sku FROM matches)',
      '  GROUP BY i.sku, i.box_number, i.part_number, i.upc, i.quantity',
      ')',
      'SELECT * FROM sku_stats ORDER BY box_number, sku'
    ].join('\n');

    return { items: BQ.runQuery(sql) || [] };
  }
};
