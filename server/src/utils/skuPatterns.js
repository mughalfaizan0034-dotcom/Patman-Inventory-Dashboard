/**
 * skuPatterns — SQL fragments for SKU resolution.
 *
 * The "effective SKU" for an order is the SKU it deducts inventory from,
 * which differs from the ordered SKU when a fulfillment override
 * (shipped_from_box) is set. The canonical effective SKU format is:
 *
 *     ARA{shipped_from_box}-{part_number}-{upc}
 *
 * The CANONICAL storage form for shipped_from_box is bare digits ("20").
 * Older rows may contain "ARA20" or even a full SKU "ARA20-part-upc" — both
 * caused by user error before the upload normalizer (uploads/core/rowNormalizer)
 * was wired in. The SQL below strips back to bare digits so legacy data
 * resolves correctly without a one-time backfill.
 *
 * Every analytic / lookup query that needs the effective SKU MUST use
 * effectiveSkuSql() so the resolution stays consistent across pages.
 */

/**
 * Build the CASE expression that resolves to the effective SKU.
 *
 * @param {object} opts
 * @param {string} [opts.skuCol='sku']                       — column / expression for ordered SKU
 * @param {string} [opts.shippedCol='shipped_from_box']      — column / expression for shipped_from_box override
 * @returns {string} SQL CASE expression (NOT aliased — caller appends AS effective_sku)
 */
export function effectiveSkuSql({ skuCol = 'sku', shippedCol = 'shipped_from_box' } = {}) {
  // COALESCE(REGEXP_EXTRACT(..., r'^(?:ARA)?(\d+)'), <trimmed>) collapses any of
  //   "20" / "ARA20" / "ARA20-4060915-037256018282"
  // back to "20". Non-ARA values like "BX-001" are preserved unchanged.
  return `
    CASE
      WHEN ${shippedCol} IS NOT NULL
           AND TRIM(CAST(${shippedCol} AS STRING)) != ''
           AND REGEXP_CONTAINS(${skuCol}, r'^ARA[0-9]+-.+$')
      THEN CONCAT(
             'ARA',
             COALESCE(
               REGEXP_EXTRACT(TRIM(CAST(${shippedCol} AS STRING)), r'^(?:ARA)?(\\d+)'),
               TRIM(CAST(${shippedCol} AS STRING))
             ),
             REGEXP_EXTRACT(${skuCol}, r'^ARA[0-9]+(.+)$')
           )
      ELSE ${skuCol}
    END
  `.trim();
}
