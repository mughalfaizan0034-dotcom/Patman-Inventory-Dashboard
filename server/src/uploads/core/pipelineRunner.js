import { randomUUID } from 'crypto';
import { parseTxtStream } from './txtStreamParser.js';
import { AppError } from '../../utils/errors.js';

// Phase A async lifecycle (2026-05-18): when an `uploadId` is supplied
// by the caller, pipelineRunner uses it as the row identifier and
// SKIPS the final logUpload INSERT — the caller has already created an
// `accepted` row via uploadsRepo.createUploadJob and is responsible for
// finalizing the terminal status afterwards. When no `uploadId` is
// supplied, the runner falls back to the legacy self-insert path
// (kept so direct callers / scripts don't break).

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
export async function runUploadPipeline({ importer, uploadsRepo, organizationId, userId, stream, filename, uploadId: existingUploadId = null }) {
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
  // We track lineNum alongside the row / key so that per-row failures
  // returned from Phase 4 (e.g. streaming-buffer-blocked) can be attributed
  // back to the source file row in the validation report.
  const validAdds          = [];     // rows (no lineNum tracking needed — adds rarely fail per-row)
  const validUpdates       = [];     // [{ row, lineNum }]
  const validRemoves       = [];     // [{ key, lineNum }]

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
      validUpdates.push({ row, lineNum });
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
      validRemoves.push({ key, lineNum });
    }
  }

  // ── Phase 4: execute ─────────────────────────────────────────────────────
  // BigQuery's streaming buffer prevents UPDATE/DELETE on rows that were
  // inserted via streaming for up to ~90 min. New inserts now use DML so
  // they are immediately UPDATE/DELETE-able, but legacy rows from before
  // that change can still be in the buffer. Per-row failure tolerance:
  // updateBatch / removeBatch return { failures: [{ key, reason }] } and
  // we attribute each failure back to the source line via the maps below.
  // The rest of the chunk continues to succeed.
  let added = 0, updated = 0, removed = 0;

  for (let i = 0; i < validAdds.length; i += CHUNK_SIZE_ADD) {
    const chunk = validAdds.slice(i, i + CHUNK_SIZE_ADD);
    await importer.addBatch(uploadsRepo, chunk);
    added += chunk.length;
  }

  function _recordFailures(failureList, lineByKey) {
    for (const f of failureList) {
      failed++;
      if (errors.length < MAX_ERRORS) {
        errors.push({
          row:    lineByKey.get(f.key) ?? null,
          field:  importer.keyField,
          reason: f.reason,
        });
      }
    }
  }

  for (let i = 0; i < validUpdates.length; i += CHUNK_SIZE_UPDATE) {
    const chunk = validUpdates.slice(i, i + CHUNK_SIZE_UPDATE);
    const lineByKey = new Map(chunk.map(({ row, lineNum }) => [importer.getKey(row), lineNum]));
    const { failures = [] } = (await importer.updateBatch(uploadsRepo, organizationId, chunk.map(c => c.row))) ?? {};
    updated += chunk.length - failures.length;
    _recordFailures(failures, lineByKey);
  }

  for (let i = 0; i < validRemoves.length; i += CHUNK_SIZE_REMOVE) {
    const chunk = validRemoves.slice(i, i + CHUNK_SIZE_REMOVE);
    const lineByKey = new Map(chunk.map(({ key, lineNum }) => [key, lineNum]));
    const { failures = [] } = (await importer.removeBatch(uploadsRepo, organizationId, chunk.map(c => c.key))) ?? {};
    removed += chunk.length - failures.length;
    _recordFailures(failures, lineByKey);
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

  const uploadId = existingUploadId || randomUUID();
  const report   = _buildReportText({
    filename, type: importer.type, status,
    added, updated, removed, failed, errors,
    timestamp: new Date(),
  });

  // Legacy path: when the caller didn't pre-create a job row (e.g.
  // direct script invocation), do the original final INSERT so the
  // Upload History table still has an audit entry. The new async
  // upload route ALWAYS supplies uploadId and finalizes itself.
  if (!existingUploadId) {
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
  }

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
