import { safeString, parsePositiveInt, normalizeDate } from '../core/rowNormalizer.js';

export const inventorySchema = {
  required: ['sku', 'upc', 'quantity'],

  buildRow(raw, organizationId, lineNum) {
    if (!raw.sku?.trim()) {
      return { error: { row: lineNum, field: 'sku', value: raw.sku, reason: 'sku is required' } };
    }
    if (!raw.upc?.trim()) {
      return { error: { row: lineNum, field: 'upc', value: raw.upc, reason: 'upc is required' } };
    }

    const qty = parsePositiveInt(raw.quantity, 'quantity', lineNum);
    if (qty.error) return { error: qty.error };

    // date_added is optional — normalize if present, store null if blank or unparseable.
    // Never reject the row for a date format issue.
    const dateAdded = normalizeDate(raw.date_added);

    return {
      row: {
        organization_id: organizationId,
        sku:         safeString(raw.sku),
        upc:         safeString(raw.upc),
        part_number: safeString(raw.part_number) || null,
        box_number:  safeString(raw.box_number)  || null,
        quantity:    qty.value,
        date_added:  dateAdded,
        notes:       safeString(raw.notes)       || null,
        updated_at:  new Date().toISOString(),
      },
    };
  },
};
