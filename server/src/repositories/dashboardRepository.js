import { TABLES } from '../config/tables.js';

export function createDashboardRepository({ bq, projectId }) {
  const ordTable = `\`${projectId}.${TABLES.ORDERS}\``;

  async function getPerformance(organizationId, weeks = 12, platform = null) {
    const safeWeeks = Math.min(Math.max(parseInt(weeks, 10) || 12, 1), 52);
    const p      = { organizationId, platform: platform ?? null };
    const pTypes = { platform: 'STRING' };
    const platCond = `AND (@platform IS NULL OR platform = @platform)`;

    // The legacy is_ignored column has been dropped (Phase D). Every order
    // in the table is live, so no soft-delete filter is needed.
    const notIgnored = '';

    const weeklyQuery = `
      SELECT
        DATE_TRUNC(SAFE_CAST(order_date AS DATE), WEEK) AS week_start,
        SUM(quantity_sold) AS units_sold,
        COUNT(*)           AS orders
      FROM ${ordTable}
      WHERE organization_id = @organizationId
        AND SAFE_CAST(order_date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${safeWeeks} WEEK)
        ${notIgnored}
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
        ${notIgnored}
        ${platCond}
      GROUP BY platform
      ORDER BY units_sold DESC
    `;

    const topSkuQuery = `
      SELECT sku, SUM(quantity_sold) AS units_sold
      FROM ${ordTable}
      WHERE organization_id = @organizationId
        AND SAFE_CAST(order_date AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${safeWeeks} WEEK)
        ${notIgnored}
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
          ${notIgnored}
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

  return { getPerformance };
}
