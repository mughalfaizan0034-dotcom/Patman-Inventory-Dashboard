import { safeString, parsePositiveInt, normalizeDate } from '../core/rowNormalizer.js';

export const ordersSchema = {
  required: ['order_date', 'sku', 'quantity_sold', 'shipped_from_box', 'platform'],

  buildRow(raw, organizationId, lineNum) {
    if (!raw.order_date?.trim()) {
      return { error: { row: lineNum, field: 'order_date', value: raw.order_date, reason: 'order_date is required' } };
    }
    // Normalize from any common format (M/D/YYYY, MM/DD/YYYY, YYYY-MM-DD, Excel serial, etc.)
    const orderDate = normalizeDate(raw.order_date);
    if (!orderDate) {
      return { error: { row: lineNum, field: 'order_date', value: raw.order_date, reason: 'order_date could not be parsed — accepted formats: YYYY-MM-DD, M/D/YYYY, MM/DD/YYYY' } };
    }

    if (!raw.sku?.trim()) {
      return { error: { row: lineNum, field: 'sku', value: raw.sku, reason: 'sku is required' } };
    }

    const qty = parsePositiveInt(raw.quantity_sold, 'quantity_sold', lineNum);
    if (qty.error) return { error: qty.error };

    if (!raw.shipped_from_box?.trim()) {
      return { error: { row: lineNum, field: 'shipped_from_box', value: raw.shipped_from_box, reason: 'shipped_from_box is required' } };
    }

    if (!raw.platform?.trim()) {
      return { error: { row: lineNum, field: 'platform', value: raw.platform, reason: 'platform is required' } };
    }

    return {
      row: {
        organization_id:  organizationId,
        order_date:       orderDate,
        sku:              safeString(raw.sku),
        quantity_sold:    qty.value,
        shipped_from_box: safeString(raw.shipped_from_box),
        platform:         safeString(raw.platform),
        created_at:       new Date().toISOString(),
      },
    };
  },
};
