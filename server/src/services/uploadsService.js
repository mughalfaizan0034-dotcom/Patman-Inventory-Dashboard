import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { AppError } from '../utils/errors.js';

// Required columns per upload type.
const INVENTORY_REQUIRED = ['sku', 'upc', 'quantity'];
const ORDERS_REQUIRED    = ['order_id', 'order_date', 'sku', 'upc', 'quantity_sold', 'platform'];

// These fields must always be stored as strings to prevent UPC/SKU corruption.
const STRING_FIELDS = new Set(['sku', 'upc', 'part_number', 'box_number', 'order_id', 'shipped_from_box']);

const CHUNK_SIZE = 500;
const MAX_ROWS   = 100_000;

function parsePositiveInt(raw, field, rowNum) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { error: { row: rowNum, field, value: raw, reason: `${field} is required` } };

  const n = Number(trimmed);
  if (!Number.isFinite(n))        return { error: { row: rowNum, field, value: raw, reason: `${field} must be a whole number` } };
  if (!Number.isInteger(n))       return { error: { row: rowNum, field, value: raw, reason: `${field} must be a whole number (no decimals)` } };
  if (n < 0)                      return { error: { row: rowNum, field, value: raw, reason: `${field} must be a positive number` } };
  return { value: n };
}

function safeString(value) {
  return String(value ?? '').trim();
}

export function createUploadsService({ uploadsRepo }) {

  async function processInventoryUpload(organizationId, userId, stream, filename) {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let headers  = null;
    let lineNum  = 0;
    let dataRows = 0;
    const errors = [];
    let batch    = [];
    let inserted = 0;
    let deleted  = false;

    for await (const line of rl) {
      lineNum++;
      if (!line.trim()) continue;

      const cells = line.split('\t').map(c => c.trim());

      if (!headers) {
        headers = cells.map(h => h.toLowerCase().replace(/\s+/g, '_'));
        const missing = INVENTORY_REQUIRED.filter(c => !headers.includes(c));
        if (missing.length) {
          throw new AppError(400, `TXT missing required columns: ${missing.join(', ')}`);
        }
        continue;
      }

      dataRows++;
      if (dataRows > MAX_ROWS) throw new AppError(400, 'File exceeds 100,000 row limit');

      const raw = {};
      headers.forEach((h, i) => { raw[h] = cells[i] ?? ''; });

      if (!raw.sku?.trim()) {
        errors.push({ row: lineNum, field: 'sku', value: raw.sku, reason: 'sku is required' });
        continue;
      }
      if (!raw.upc?.trim()) {
        errors.push({ row: lineNum, field: 'upc', value: raw.upc, reason: 'upc is required' });
        continue;
      }

      const qty = parsePositiveInt(raw.quantity, 'quantity', lineNum);
      if (qty.error) { errors.push(qty.error); continue; }

      batch.push({
        organization_id: organizationId,
        sku:         safeString(raw.sku),
        upc:         safeString(raw.upc),
        part_number: safeString(raw.part_number) || null,
        box_number:  safeString(raw.box_number)  || null,
        quantity:    qty.value,
        date_added:  safeString(raw.date_added)  || null,
        notes:       safeString(raw.notes)       || null,
        updated_at:  new Date().toISOString(),
      });

      if (batch.length >= CHUNK_SIZE) {
        if (!deleted) {
          await uploadsRepo.deleteInventory(organizationId);
          deleted = true;
        }
        await uploadsRepo.insertInventoryBatch(batch);
        inserted += batch.length;
        batch = [];
      }
    }

    if (batch.length > 0) {
      if (!deleted) {
        await uploadsRepo.deleteInventory(organizationId);
      }
      await uploadsRepo.insertInventoryBatch(batch);
      inserted += batch.length;
    }

    if (inserted === 0 && !errors.length) throw new AppError(400, 'No data rows found in file');

    const uploadId = randomUUID();
    await uploadsRepo.logInventoryUpload({
      uploadId, organizationId, userId,
      filename: filename || 'inventory.txt',
      rowCount: inserted,
      status:   errors.length ? 'partial' : 'success',
    }).catch(() => {});

    return { upload_id: uploadId, inserted, skipped: errors.length, errors: errors.slice(0, 100), filename };
  }

  async function processOrdersUpload(organizationId, userId, stream, filename) {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let headers  = null;
    let lineNum  = 0;
    let dataRows = 0;
    const errors = [];
    let batch    = [];
    let inserted = 0;

    for await (const line of rl) {
      lineNum++;
      if (!line.trim()) continue;

      const cells = line.split('\t').map(c => c.trim());

      if (!headers) {
        headers = cells.map(h => h.toLowerCase().replace(/\s+/g, '_'));
        const missing = ORDERS_REQUIRED.filter(c => !headers.includes(c));
        if (missing.length) {
          throw new AppError(400, `TXT missing required columns: ${missing.join(', ')}`);
        }
        continue;
      }

      dataRows++;
      if (dataRows > MAX_ROWS) throw new AppError(400, 'File exceeds 100,000 row limit');

      const raw = {};
      headers.forEach((h, i) => { raw[h] = cells[i] ?? ''; });

      if (!raw.order_id?.trim()) {
        errors.push({ row: lineNum, field: 'order_id', value: raw.order_id, reason: 'order_id is required' });
        continue;
      }
      if (!raw.sku?.trim()) {
        errors.push({ row: lineNum, field: 'sku', value: raw.sku, reason: 'sku is required' });
        continue;
      }
      if (!raw.order_date?.trim()) {
        errors.push({ row: lineNum, field: 'order_date', value: raw.order_date, reason: 'order_date is required' });
        continue;
      }

      const qty = parsePositiveInt(raw.quantity_sold, 'quantity_sold', lineNum);
      if (qty.error) { errors.push(qty.error); continue; }

      batch.push({
        organization_id:  organizationId,
        order_id:         safeString(raw.order_id),
        order_date:       safeString(raw.order_date),
        sku:              safeString(raw.sku),
        upc:              safeString(raw.upc),
        quantity_sold:    qty.value,
        platform:         safeString(raw.platform) || 'Unknown',
        source_file:      safeString(raw.source_file)      || null,
        shipped_from_box: safeString(raw.shipped_from_box) || null,
        created_at:       new Date().toISOString(),
      });

      if (batch.length >= CHUNK_SIZE) {
        await uploadsRepo.insertOrdersBatch(batch);
        inserted += batch.length;
        batch = [];
      }
    }

    if (batch.length > 0) {
      await uploadsRepo.insertOrdersBatch(batch);
      inserted += batch.length;
    }

    if (inserted === 0 && !errors.length) throw new AppError(400, 'No data rows found in file');

    const uploadId = randomUUID();
    await uploadsRepo.logOrderUpload({
      uploadId, organizationId, userId,
      filename: filename || 'orders.txt',
      rowCount: inserted,
      status:   errors.length ? 'partial' : 'success',
    }).catch(() => {});

    return { upload_id: uploadId, inserted, skipped: errors.length, errors: errors.slice(0, 100), filename };
  }

  async function getHistory(organizationId, type) {
    return uploadsRepo.getHistory(organizationId, type);
  }

  return { processInventoryUpload, processOrdersUpload, getHistory };
}
