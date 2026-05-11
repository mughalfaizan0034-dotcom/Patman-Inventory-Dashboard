import { TABLES } from '../config/tables.js';

export function createDashboardRepository({ bq, projectId }) {
  const invTable    = `\`${projectId}.${TABLES.INVENTORY}\``;
  const ordTable    = `\`${projectId}.${TABLES.ORDERS}\``;
  const invUplTable = `\`${projectId}.${TABLES.INVENTORY_UPLOADS}\``;
  const ordUplTable = `\`${projectId}.${TABLES.ORDER_UPLOADS}\``;

  // Reusable CTE: resolves effective_sku by applying shipped_from_box override
  // for ARA-pattern SKUs, then aggregates quantity_sold per effective_sku.
  const _ordersAggCTE = () => `
    orders_agg AS (
      SELECT
        CASE
          WHEN shipped_from_box IS NOT NULL
               AND TRIM(CAST(shipped_from_box AS STRING)) != ''
               AND REGEXP_CONTAINS(sku, r'^ARA[0-9]+-.+$')
          THEN CONCAT('ARA', TRIM(CAST(shipped_from_box AS STRING)),
                      REGEXP_EXTRACT(sku, r'^ARA[0-9]+(.+)$'))
          ELSE sku
        END AS effective_sku,
        SUM(quantity_sold) AS sold
      FROM ${ordTable}
      WHERE organization_id = @organizationId
      GROUP BY effective_sku
    )`;

  async function getKPIs(organizationId) {
    const invQuery = `
      SELECT COUNT(*) AS total_skus, SUM(quantity) AS total_units
      FROM ${invTable}
      WHERE organization_id = @organizationId
    `;

    const ordQuery = `
      SELECT
        COUNT(*)                  AS total_orders,
        SUM(quantity_sold)        AS units_sold,
        COUNT(DISTINCT CASE WHEN platform IS NOT NULL THEN platform END) AS active_platforms
      FROM ${ordTable}
      WHERE organization_id = @organizationId
    `;

    const metricsQuery = `
      WITH inv AS (
        SELECT sku, quantity FROM ${invTable} WHERE organization_id = @organizationId
      ),
      ord AS (
        SELECT
          CASE
            WHEN shipped_from_box IS NOT NULL
                 AND TRIM(CAST(shipped_from_box AS STRING)) != ''
                 AND REGEXP_CONTAINS(sku, r'^ARA[0-9]+-.+$')
            THEN CONCAT('ARA', TRIM(CAST(shipped_from_box AS STRING)), REGEXP_EXTRACT(sku, r'^ARA[0-9]+(.+)$'))
            ELSE sku
          END AS effective_sku,
          SUM(quantity_sold) AS sold
        FROM ${ordTable} WHERE organization_id = @organizationId
        GROUP BY effective_sku
      ),
      remaining AS (
        SELECT i.quantity - COALESCE(o.sold, 0) AS rem
        FROM inv i LEFT JOIN ord o ON i.sku = o.effective_sku
      )
      SELECT
        ABS(SUM(CASE WHEN rem < 0 THEN rem ELSE 0 END)) AS phantom_units,
        (
          SELECT COUNT(DISTINCT o2.sku)
          FROM ${ordTable} o2
          WHERE o2.organization_id = @organizationId
            AND o2.sku NOT IN (SELECT sku FROM inv)
        ) AS undefined_sku_orders
      FROM remaining
    `;

    const undefinedSkusQuery = `
      SELECT COUNT(*) AS undefined_skus
      FROM ${invTable}
      WHERE organization_id = @organizationId
        AND (
          UPPER(TRIM(COALESCE(sku, '')))         IN ('NA','N/A','')
          OR UPPER(TRIM(COALESCE(upc, '')))      IN ('NA','N/A','')
          OR UPPER(TRIM(COALESCE(part_number,''))) IN ('NA','N/A','')
        )
    `;

    try {
      const [invR, ordR, metR, undR] = await Promise.all([
        bq.query({ query: invQuery,            params: { organizationId } }).then(r => r[0][0] ?? {}),
        bq.query({ query: ordQuery,            params: { organizationId } }).then(r => r[0][0] ?? {}),
        bq.query({ query: metricsQuery,        params: { organizationId } }).then(r => r[0][0] ?? {}),
        bq.query({ query: undefinedSkusQuery,  params: { organizationId } }).then(r => r[0][0] ?? {}),
      ]);

      const totalUnits = Number(invR.total_units ?? 0);
      const unitsSold  = Number(ordR.units_sold  ?? 0);

      return {
        totalSkus:          Number(invR.total_skus           ?? 0),
        totalUnits,
        unitsSold,
        totalOrders:        Number(ordR.total_orders         ?? 0),
        remainingStock:     totalUnits - unitsSold,
        phantomUnits:       Number(metR.phantom_units        ?? 0),
        undefinedSkuOrders: Number(metR.undefined_sku_orders ?? 0),
        activePlatforms:    Number(ordR.active_platforms     ?? 0),
        undefinedSkus:      Number(undR.undefined_skus       ?? 0),
      };
    } catch (err) {
      console.error('[dashboardRepo.getKPIs] query failed:', err?.message ?? err);
      return {
        totalSkus: 0, totalUnits: 0, unitsSold: 0, totalOrders: 0,
        remainingStock: 0, phantomUnits: 0, undefinedSkuOrders: 0,
        activePlatforms: 0, undefinedSkus: 0,
      };
    }
  }

  async function getPerformance(organizationId, weeks = 12, platform = null) {
    const safeWeeks = Math.min(Math.max(parseInt(weeks, 10) || 12, 1), 52);
    const p      = { organizationId, platform: platform ?? null };
    const pTypes = { platform: 'STRING' };
    const platCond = `AND (@platform IS NULL OR platform = @platform)`;

    const weeklyQuery = `
      SELECT
        DATE_TRUNC(SAFE_CAST(order_date AS DATE), WEEK) AS week_start,
        SUM(quantity_sold) AS units_sold,
        COUNT(*)           AS orders
      FROM ${ordTable}
      WHERE organization_id = @organizationId
        AND SAFE_CAST(order_date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${safeWeeks} WEEK)
        ${platCond}
      GROUP BY week_start
      ORDER BY week_start ASC
    `;

    const platformQuery = `
      SELECT platform, SUM(quantity_sold) AS units_sold, COUNT(*) AS order_count
      FROM ${ordTable}
      WHERE organization_id = @organizationId
        AND SAFE_CAST(order_date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${safeWeeks} WEEK)
        AND platform IS NOT NULL
        ${platCond}
      GROUP BY platform
      ORDER BY units_sold DESC
    `;

    const topSkuQuery = `
      SELECT sku, SUM(quantity_sold) AS units_sold
      FROM ${ordTable}
      WHERE organization_id = @organizationId
        AND SAFE_CAST(order_date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${safeWeeks} WEEK)
        ${platCond}
      GROUP BY sku
      ORDER BY units_sold DESC
      LIMIT 10
    `;

    // Rewritten to avoid mixing aggregate functions inside window function ORDER BY.
    // monthly_platform first computes per-(month,platform) counts, then the window
    // function operates on those aggregated rows cleanly.
    const monthlyQuery = `
      WITH monthly_all AS (
        SELECT
          FORMAT_DATE('%Y-%m', SAFE_CAST(order_date AS DATE)) AS month,
          platform,
          quantity_sold
        FROM ${ordTable}
        WHERE organization_id = @organizationId
          AND SAFE_CAST(order_date AS DATE) IS NOT NULL
          ${platCond}
      ),
      monthly_totals AS (
        SELECT month, COUNT(*) AS order_count, SUM(quantity_sold) AS units_sold
        FROM monthly_all
        GROUP BY month
      ),
      platform_counts AS (
        SELECT month, platform, COUNT(*) AS cnt
        FROM monthly_all
        WHERE platform IS NOT NULL
        GROUP BY month, platform
      ),
      top_platform AS (
        SELECT month, platform
        FROM (
          SELECT month, platform,
                 ROW_NUMBER() OVER (PARTITION BY month ORDER BY cnt DESC) AS rn
          FROM platform_counts
        )
        WHERE rn = 1
      )
      SELECT t.month, t.order_count, t.units_sold, p.platform AS top_platform
      FROM monthly_totals t
      LEFT JOIN top_platform p USING (month)
      ORDER BY t.month DESC
      LIMIT 12
    `;

    const run = (query, label) =>
      bq.query({ query, params: p, types: pTypes })
        .then(r => r[0])
        .catch(err => {
          console.error(`[dashboardRepo.getPerformance] ${label} failed:`, err?.message ?? err);
          return [];
        });

    const [wR, pR, sR, mR] = await Promise.all([
      run(weeklyQuery,   'weekly'),
      run(platformQuery, 'platform'),
      run(topSkuQuery,   'topSku'),
      run(monthlyQuery,  'monthly'),
    ]);
    return { weekly: wR, platforms: pR, topSkus: sR, monthly: mR };
  }

  async function getInventoryAnalytics(organizationId) {
    const p = { organizationId };

    const ordAgg = _ordersAggCTE();

    const stockStatusQuery = `
      WITH ${ordAgg},
      remaining AS (
        SELECT
          i.sku,
          i.quantity - COALESCE(o.sold, 0) AS rem,
          (
            UPPER(TRIM(COALESCE(i.sku, '')))          IN ('NA','N/A','') OR
            UPPER(TRIM(COALESCE(i.upc, '')))          IN ('NA','N/A','') OR
            UPPER(TRIM(COALESCE(i.part_number, ''))) IN ('NA','N/A','')
          ) AS is_undefined
        FROM ${invTable} i
        LEFT JOIN orders_agg o ON i.sku = o.effective_sku
        WHERE i.organization_id = @organizationId
      )
      SELECT
        CASE
          WHEN is_undefined THEN 'Undefined'
          WHEN rem > 0     THEN 'In Stock'
          WHEN rem = 0     THEN 'OOS'
          ELSE 'Phantom'
        END AS status,
        COUNT(*) AS count
      FROM remaining
      GROUP BY status
      ORDER BY count DESC
    `;

    const topBoxesQuery = `
      WITH ${ordAgg},
      box_remaining AS (
        SELECT
          i.box_number,
          SUM(i.quantity - COALESCE(o.sold, 0)) AS remaining_units,
          COUNT(DISTINCT i.sku) AS sku_count
        FROM ${invTable} i
        LEFT JOIN orders_agg o ON i.sku = o.effective_sku
        WHERE i.organization_id = @organizationId
          AND i.box_number IS NOT NULL AND TRIM(CAST(i.box_number AS STRING)) != ''
        GROUP BY i.box_number
      )
      SELECT box_number, remaining_units, sku_count
      FROM box_remaining
      ORDER BY remaining_units DESC
      LIMIT 10
    `;

    const healthByMonthQuery = `
      WITH ${ordAgg},
      remaining AS (
        SELECT
          LEFT(COALESCE(CAST(i.date_added AS STRING), ''), 7) AS month,
          i.quantity - COALESCE(o.sold, 0) AS rem
        FROM ${invTable} i
        LEFT JOIN orders_agg o ON i.sku = o.effective_sku
        WHERE i.organization_id = @organizationId
          AND i.date_added IS NOT NULL
          AND LENGTH(CAST(i.date_added AS STRING)) >= 7
      )
      SELECT
        month,
        COUNTIF(rem > 0) AS in_stock,
        COUNTIF(rem = 0) AS oos,
        COUNTIF(rem < 0) AS phantom,
        COUNT(*)         AS total
      FROM remaining
      WHERE month != '' AND month IS NOT NULL
      GROUP BY month
      ORDER BY month ASC
      LIMIT 24
    `;

    const oversoldSkusQuery = `
      WITH ${ordAgg}
      SELECT
        i.sku,
        i.quantity                      AS original_qty,
        COALESCE(o.sold, 0)             AS units_sold,
        i.quantity - COALESCE(o.sold, 0) AS remaining
      FROM ${invTable} i
      LEFT JOIN orders_agg o ON i.sku = o.effective_sku
      WHERE i.organization_id = @organizationId
        AND i.quantity - COALESCE(o.sold, 0) < 0
      ORDER BY remaining ASC
      LIMIT 10
    `;

    const boxUtilizationQuery = `
      WITH ${ordAgg},
      box_stats AS (
        SELECT
          i.box_number,
          COUNT(DISTINCT i.sku) AS total_skus,
          COUNT(DISTINCT CASE WHEN i.quantity - COALESCE(o.sold, 0) > 0 THEN i.sku END) AS active_skus
        FROM ${invTable} i
        LEFT JOIN orders_agg o ON i.sku = o.effective_sku
        WHERE i.organization_id = @organizationId
          AND i.box_number IS NOT NULL AND TRIM(CAST(i.box_number AS STRING)) != ''
        GROUP BY i.box_number
      )
      SELECT box_number, total_skus, active_skus
      FROM box_stats
      ORDER BY total_skus DESC
      LIMIT 10
    `;

    const run = (query, label) =>
      bq.query({ query, params: p })
        .then(r => r[0])
        .catch(err => {
          console.error(`[dashboardRepo.getInventoryAnalytics] ${label} failed:`, err?.message ?? err);
          return [];
        });

    const [stockStatus, topBoxes, healthByMonth, mostOversoldSkus, boxUtilization] = await Promise.all([
      run(stockStatusQuery,    'stockStatus'),
      run(topBoxesQuery,       'topBoxes'),
      run(healthByMonthQuery,  'healthByMonth'),
      run(oversoldSkusQuery,   'oversoldSkus'),
      run(boxUtilizationQuery, 'boxUtilization'),
    ]);

    return { stockStatus, topBoxes, healthByMonth, mostOversoldSkus, boxUtilization };
  }

  return { getKPIs, getPerformance, getInventoryAnalytics };
}
