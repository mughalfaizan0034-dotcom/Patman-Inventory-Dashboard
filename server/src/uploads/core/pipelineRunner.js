import { randomUUID } from 'crypto';
import { parseTxtStream } from './txtStreamParser.js';
import { AppError } from '../../utils/errors.js';

// Per-operation chunk sizes. Removes can be much larger because the DELETE
// payload is just a list of UIDs — BigQuery DML handles 10K-element UNNEST
// arrays comfortably. Add/Update payloads are heavier (full row data), so
// stay at 500 to keep individual query size reasonable.
const CHUNK_SIZE_ADD    = 500;
const CHUNK_SIZE_UPDATE = 500;
const CHUNK_SIZE_REMOVE = 10000;
const MAX_ERRORS = 200;

/**
 * Feed-based CRUD upload pipeline.
 *
 * Phase 1: Stream all rows into adds / updates / removes buckets.
 * Phase 2: Fetch the existing key set for the affected keys.
 * Phase 3: Validate each row against the key set (duplicate / not-found guards).
 * Phase 4: Execute operations in CHUNK_SIZE batches.
 *
 * @returns {{ upload_id, added, updated, removed, failed, errors, filename }}
 */
export async function runUploadPipeline({ importer, uploadsRepo, organizationId, userId, stream, filename }) {
  const { schema } = importer;

  const adds    = []; // [{ row, lineNum }]
  const updates = [];
  const removes = [];
  const errors  = [];
  let   failed  = 0;

  // ── Phase 1: collect ──────────────────────────────────────────────────────
  for await (const event of parseTxtStream(stream)) {
    if (event.type === 'headers') {
      if (schema.required.length) {
        const missing = schema.required.filter(col => !event.headers.includes(col));
        if (missing.length) {
          throw new AppError(400, `TXT missing required columns: ${missing.join(', ')}`);
        }
      }
      continue;
    }

    const { lineNum, raw } = event;
    const result = schema.buildRow(raw, organizationId, lineNum);

    if (result.error) {
      failed++;
      if (errors.length < MAX_ERRORS) errors.push(result.error);
      continue;
    }

    if (result.action === 'Add')    adds.push({ row: result.row, lineNum });
    else if (result.action === 'Update') updates.push({ row: result.row, lineNum });
    else if (result.action === 'Remove') removes.push({ row: result.row, lineNum });
  }

  const totalParsed = adds.length + updates.length + removes.length;
  if (totalParsed === 0 && failed === 0) {
    throw new AppError(400, 'No data rows found in file');
  }

  // ── Phase 2: fetch existing key set ──────────────────────────────────────
  const addKeys    = adds.map(({ row }) => importer.getKey(row));
  const updateKeys = updates.map(({ row }) => importer.getKey(row));
  const removeKeys = removes.map(({ row }) => importer.getKey(row));
  const allKeys    = [...new Set([...addKeys, ...updateKeys, ...removeKeys])];

  const existingKeys = await importer.fetchKeySet(uploadsRepo, organizationId, allKeys);

  // ── Phase 3: validate ────────────────────────────────────────────────────
  const validAdds       = [];
  const validUpdates    = [];
  const validRemoveKeys = [];

  for (const { row, lineNum } of adds) {
    const key = importer.getKey(row);
    if (existingKeys.has(key)) {
      failed++;
      if (errors.length < MAX_ERRORS) {
        errors.push({ row: lineNum, field: importer.keyField, reason: `${key} already exists — use action Update to modify` });
      }
    } else {
      validAdds.push(row);
    }
  }

  for (const { row, lineNum } of updates) {
    const key = importer.getKey(row);
    if (!existingKeys.has(key)) {
      failed++;
      if (errors.length < MAX_ERRORS) {
        errors.push({ row: lineNum, field: importer.keyField, reason: `${key} not found — use action Add to create it` });
      }
    } else {
      validUpdates.push(row);
    }
  }

  for (const { row, lineNum } of removes) {
    const key = importer.getKey(row);
    if (!existingKeys.has(key)) {
      failed++;
      if (errors.length < MAX_ERRORS) {
        errors.push({ row: lineNum, field: importer.keyField, reason: `${key} not found` });
      }
    } else {
      validRemoveKeys.push(key);
    }
  }

  // ── Phase 4: execute ─────────────────────────────────────────────────────
  // BigQuery's streaming buffer prevents UPDATE/DELETE on rows added via
  // streaming insert for up to ~90 minutes. New inserts now go through DML
  // (see uploadsRepository.insertInventoryBatch / insertOrdersBatch) so the
  // problem is bounded to LEGACY rows from before that change. If we see
  // the specific BQ error here, surface a clear AppError instead of a raw
  // 500 so the user understands the cause and the wait window.
  const _wrapBqError = (op) => async () => {
    try { return await op(); }
    catch (err) {
      const msg = String(err?.message ?? '');
      if (/streaming buffer/i.test(msg)) {
        throw new AppError(
          409,
          'Some rows were added via streaming insert recently and cannot be ' +
          'updated or removed yet. BigQuery holds them in a streaming buffer for ' +
          'up to ~90 minutes. Wait for the buffer to flush and retry, or split ' +
          'the file so older rows process first.',
        );
      }
      throw err;
    }
  };

  let added = 0, updated = 0, removed = 0;

  for (let i = 0; i < validAdds.length; i += CHUNK_SIZE_ADD) {
    const chunk = validAdds.slice(i, i + CHUNK_SIZE_ADD);
    await _wrapBqError(() => importer.addBatch(uploadsRepo, chunk))();
    added += chunk.length;
  }

  for (let i = 0; i < validUpdates.length; i += CHUNK_SIZE_UPDATE) {
    const chunk = validUpdates.slice(i, i + CHUNK_SIZE_UPDATE);
    await _wrapBqError(() => importer.updateBatch(uploadsRepo, organizationId, chunk))();
    updated += chunk.length;
  }

  if (validRemoveKeys.length) {
    for (let i = 0; i < validRemoveKeys.length; i += CHUNK_SIZE_REMOVE) {
      const chunkKeys = validRemoveKeys.slice(i, i + CHUNK_SIZE_REMOVE);
      await _wrapBqError(() => importer.removeBatch(uploadsRepo, organizationId, chunkKeys))();
    }
    removed = validRemoveKeys.length;
  }

  if (added + updated + removed === 0 && failed === 0) {
    throw new AppError(400, 'No valid rows to process');
  }

  // Status derivation:
  //   - All rows OK              → 'success'
  //   - Some OK, some failed     → 'partial'
  //   - Zero OK, all failed      → 'failed'
  const successCount = added + updated + removed;
  const status = (successCount === 0 && failed > 0) ? 'failed'
               : (failed > 0)                       ? 'partial'
               :                                      'success';

  const uploadId = randomUUID();
  const report   = _buildReportText({
    filename, type: importer.type, status,
    added, updated, removed, failed, errors,
    timestamp: new Date(),
  });

  await importer.logUpload(uploadsRepo, {
    uploadId,
    organizationId,
    userId,
    filename: filename || `${importer.type}.txt`,
    rowCount: successCount,
    status,
    report,
  }).catch(err => { /* non-fatal — main operation already committed */
    // eslint-disable-next-line no-console
    console.warn('[pipelineRunner] logUpload failed (non-fatal):', err?.message ?? err);
  });

  return { upload_id: uploadId, added, updated, removed, failed, errors, filename, status, report };
}

// Human-readable plain-text summary stored with each upload and downloadable
// from the Upload History UI. Truncates the errors list to MAX_ERRORS.
function _buildReportText({ filename, type, status, added, updated, removed, failed, errors, timestamp }) {
  const total = added + updated + removed + failed;
  const lines = [
    'PATMAN UPLOAD SUMMARY',
    '='.repeat(60),
    '',
    `File:       ${filename || `${type}.txt`}`,
    `Type:       ${type}`,
    `Date (UTC): ${timestamp.toISOString().replace('T', ' ').slice(0, 19)}`,
    `Status:     ${status.toUpperCase()}`,
    '',
    'RESULT',
    '-'.repeat(60),
    `  Added:    ${added.toLocaleString().padStart(8)}`,
    `  Updated:  ${updated.toLocaleString().padStart(8)}`,
    `  Removed:  ${removed.toLocaleString().padStart(8)}`,
    `  Failed:   ${failed.toLocaleString().padStart(8)}`,
    `  ----------------`,
    `  Total:    ${total.toLocaleString().padStart(8)}`,
    '',
  ];

  if (errors.length) {
    lines.push('ERRORS');
    lines.push('-'.repeat(60));
    for (const e of errors) {
      const field = e.field ? `[${e.field}]` : '';
      const val   = e.value !== undefined && e.value !== '' ? ` (value: "${e.value}")` : '';
      lines.push(`  Row ${String(e.row ?? '?').padStart(5)}  ${field.padEnd(18)} ${e.reason}${val}`);
    }
    if (failed > errors.length) {
      lines.push(`  ...and ${(failed - errors.length).toLocaleString()} more errors not shown (limit ${MAX_ERRORS}).`);
    }
    lines.push('');
  }

  lines.push('-'.repeat(60));
  lines.push('Generated by Patman Inventory.');
  return lines.join('\n');
}
