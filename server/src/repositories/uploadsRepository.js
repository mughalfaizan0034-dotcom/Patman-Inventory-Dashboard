import { TABLES } from '../config/tables.js';

export function createUploadsRepository({ bq, projectId }) {
  const invUploads = `\`${projectId}.${TABLES.INVENTORY_UPLOADS}\``;
  const ordUploads = `\`${projectId}.${TABLES.ORDER_UPLOADS}\``;
  const invTable   = `\`${projectId}.${TABLES.INVENTORY}\``;
  const ordTable   = `\`${projectId}.${TABLES.ORDERS}\``;

  async function getHistory(organizationId, type = '') {
    const queries = [];

    if (!type || type === 'inventory') {
      queries.push(`
        SELECT 'inventory' AS type, upload_id, filename, row_count, status,
               (report IS NOT NULL AND report != '') AS has_report,
               created_at
        FROM ${invUploads}
        WHERE organization_id = @organizationId
      `);
    }
    if (!type || type === 'orders') {
      queries.push(`
        SELECT 'orders' AS type, upload_id, filename, row_count, status,
               (report IS NOT NULL AND report != '') AS has_report,
               created_at
        FROM ${ordUploads}
        WHERE organization_id = @organizationId
      `);
    }

    const combined = queries.join('\nUNION ALL\n');
    const query    = `${combined} ORDER BY created_at DESC LIMIT 100`;
    try {
      const [rows] = await bq.query({ query, params: { organizationId } });
      return rows.map(r => ({
        ...r,
        created_at: r.created_at?.value ?? r.created_at ?? null,
      }));
    } catch {
      // Tables may not exist yet (migration pending). Return empty rather than crashing.
      return [];
    }
  }

  async function logInventoryUpload({ uploadId, organizationId, userId, filename, rowCount, status, report }) {
    const query = `
      INSERT INTO ${invUploads}
        (upload_id, organization_id, user_id, filename, row_count, status, report, created_at)
      VALUES
        (@uploadId, @organizationId, @userId, @filename, @rowCount, @status, @report, CURRENT_TIMESTAMP())
    `;
    await bq.query({
      query,
      params: { uploadId, organizationId, userId, filename, rowCount, status, report: report ?? null },
      types:  { report: 'STRING' },
    });
  }

  async function logOrderUpload({ uploadId, organizationId, userId, filename, rowCount, status, report }) {
    const query = `
      INSERT INTO ${ordUploads}
        (upload_id, organization_id, user_id, filename, row_count, status, report, created_at)
      VALUES
        (@uploadId, @organizationId, @userId, @filename, @rowCount, @status, @report, CURRENT_TIMESTAMP())
    `;
    await bq.query({
      query,
      params: { uploadId, organizationId, userId, filename, rowCount, status, report: report ?? null },
      types:  { report: 'STRING' },
    });
  }

  // Fetch the stored report text for a single upload (admin / member only;
  // route enforces org scoping). Returns null if not found or no report.
  async function getUploadReport(organizationId, uploadId) {
    const query = `
      SELECT report, filename, status, created_at, 'inventory' AS type
      FROM ${invUploads}
      WHERE organization_id = @organizationId AND upload_id = @uploadId
      UNION ALL
      SELECT report, filename, status, created_at, 'orders' AS type
      FROM ${ordUploads}
      WHERE organization_id = @organizationId AND upload_id = @uploadId
      LIMIT 1
    `;
    try {
      const [rows] = await bq.query({ query, params: { organizationId, uploadId } });
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  // Full org inventory delete (legacy — kept for potential future use).
  async function deleteInventory(organizationId) {
    await bq.query({
      query:  `DELETE FROM ${invTable} WHERE organization_id = @organizationId`,
      params: { organizationId },
    });
  }

  // We use a DML INSERT (not streaming tabledata.insertAll) on purpose.
  // BigQuery's streaming buffer prevents UPDATE / DELETE from touching rows
  // for up to ~90 minutes after a streaming insert. That broke the workflow
  // where users Add rows via feed file and then Update / Remove them the
  // same session (the cause of the recurring "500 on orders Update/Remove
  // feed" report). DML INSERT places rows in regular storage immediately,
  // so the subsequent UPDATE / DELETE in the SAME upload pipeline works.
  //
  // DML rate limit is well within our needs: chunk size = 500 rows × ~10
  // columns ≈ 5K params per query (under BQ's 10K parameter limit), and
  // 100K-row uploads → 200 chunks per day per table, far under the 1,500
  // DML statements/table/day quota.
  async function insertInventoryBatch(rows) {
    if (!rows.length) return;
    const params = {
      rows: rows.map(r => ({
        organization_id: r.organization_id,
        row_uid:         r.row_uid,
        sku:             r.sku,
        upc:             r.upc ?? null,
        part_number:     r.part_number ?? null,
        box_number:      r.box_number  ?? null,
        quantity:        r.quantity,
        date_added:      r.date_added  ?? null,
        notes:           r.notes       ?? null,
        updated_at:      r.updated_at  ?? new Date().toISOString(),
      })),
    };
    const types = {
      rows: [{
        organization_id: 'STRING',
        row_uid:         'STRING',
        sku:             'STRING',
        upc:             'STRING',
        part_number:     'STRING',
        box_number:      'STRING',
        quantity:        'INT64',
        date_added:      'STRING',
        notes:           'STRING',
        updated_at:      'STRING',
      }],
    };
    const query = `
      INSERT INTO ${invTable}
        (organization_id, row_uid, sku, upc, part_number, box_number, quantity, date_added, notes, updated_at)
      SELECT
        organization_id, row_uid, sku, upc, part_number, box_number, quantity, date_added, notes,
        TIMESTAMP(updated_at)
      FROM UNNEST(@rows)
    `;
    await bq.query({ query, params, types });
  }

  async function insertOrdersBatch(rows) {
    if (!rows.length) return;
    const params = {
      rows: rows.map(r => ({
        order_row_id:         r.order_row_id,
        organization_id:      r.organization_id,
        order_id:             r.order_id,
        order_date:           r.order_date,
        sku:                  r.sku,
        quantity_sold:        r.quantity_sold,
        platform:             r.platform,
        shipped_from_box:     r.shipped_from_box     ?? null,
        shipped_sku_override: r.shipped_sku_override ?? null,
        created_at:           r.created_at ?? new Date().toISOString(),
      })),
    };
    const types = {
      rows: [{
        order_row_id:         'STRING',
        organization_id:      'STRING',
        order_id:             'STRING',
        order_date:           'STRING',
        sku:                  'STRING',
        quantity_sold:        'INT64',
        platform:             'STRING',
        shipped_from_box:     'STRING',
        shipped_sku_override: 'STRING',
        created_at:           'STRING',
      }],
    };
    const query = `
      INSERT INTO ${ordTable}
        (order_row_id, organization_id, order_id, order_date, sku, quantity_sold, platform, shipped_from_box, shipped_sku_override, created_at)
      SELECT
        order_row_id, organization_id, order_id, order_date, sku, quantity_sold, platform, shipped_from_box, shipped_sku_override,
        TIMESTAMP(created_at)
      FROM UNNEST(@rows)
    `;
    await bq.query({ query, params, types });
  }

  // Returns a Set of row_uids that already exist for this org (from the given candidate list).
  async function getInventoryKeySet(organizationId, rowUids) {
    if (!rowUids.length) return new Set();
    const query = `
      SELECT row_uid FROM ${invTable}
      WHERE organization_id = @organizationId
        AND row_uid IN UNNEST(@rowUids)
    `;
    const [rows] = await bq.query({ query, params: { organizationId, rowUids } });
    return new Set(rows.map(r => r.row_uid));
  }

  // Returns a Set of order_row_ids that already exist for this org.
  async function getOrderKeySet(organizationId, orderIds) {
    if (!orderIds.length) return new Set();
    const query = `
      SELECT order_row_id FROM ${ordTable}
      WHERE organization_id = @organizationId
        AND order_row_id IN UNNEST(@orderIds)
    `;
    const [rows] = await bq.query({ query, params: { organizationId, orderIds } });
    return new Set(rows.map(r => r.order_row_id));
  }

  // BigQuery's streaming buffer rejects UPDATE/DELETE against rows that
  // were recently streamed (it can hold rows for ~90 min). New inserts now
  // use DML so they don't suffer — but legacy rows already in the buffer
  // do. We detect that specific error and surface it as a per-row failure
  // so the rest of the batch can still succeed.
  const STREAMING_BUFFER_REASON =
    'row is in BigQuery streaming buffer (added recently via streaming insert) — wait up to ~90 minutes for the buffer to flush, then retry';

  function _isStreamingBufferError(err) {
    return /streaming buffer/i.test(String(err?.message ?? ''));
  }

  // Bulk partial-update via a single MERGE statement per chunk.
  //
  // Why MERGE (not a per-row UPDATE loop):
  //   500 separate UPDATEs × ~0.5s each = ~4 minutes per chunk; on Cloud Run
  //   this exceeds the 5-min request budget, the container is killed before
  //   it can return, and the browser sees a CORS error (no headers returned).
  //   A single MERGE applies the whole chunk in one query.
  //
  // COALESCE(s.X, t.X) preserves the existing target value when the source
  // column is NULL — i.e. when the user left that cell blank in the feed.
  // Each schema only populates row.X when the user provided a non-empty
  // value, so NULL = "don't touch this field".
  //
  // Returns { failures: [{ key, reason }] }. On streaming-buffer rejection
  // the whole chunk is reported as failed (per-row retry is too slow for
  // big chunks and would just blow the same timeout).
  async function updateInventoryByRowUid(organizationId, rows) {
    if (!rows.length) return { failures: [] };
    const now = new Date().toISOString();
    const params = {
      organizationId,
      rows: rows.map(r => ({
        row_uid:     r.row_uid,
        sku:         r.sku         ?? null,
        upc:         r.upc         ?? null,
        part_number: r.part_number ?? null,
        box_number:  r.box_number  ?? null,
        quantity:    r.quantity    ?? null,
        date_added:  r.date_added  ?? null,
        notes:       r.notes       ?? null,
        updated_at:  r.updated_at  ?? now,
      })),
    };
    const types = {
      rows: [{
        row_uid:     'STRING',
        sku:         'STRING',
        upc:         'STRING',
        part_number: 'STRING',
        box_number:  'STRING',
        quantity:    'INT64',
        date_added:  'STRING',
        notes:       'STRING',
        updated_at:  'STRING',
      }],
    };
    const query = `
      MERGE INTO ${invTable} AS t
      USING (SELECT * FROM UNNEST(@rows)) AS s
      ON t.organization_id = @organizationId AND t.row_uid = s.row_uid
      WHEN MATCHED THEN
        UPDATE SET
          sku         = COALESCE(s.sku,         t.sku),
          upc         = COALESCE(s.upc,         t.upc),
          part_number = COALESCE(s.part_number, t.part_number),
          box_number  = COALESCE(s.box_number,  t.box_number),
          quantity    = COALESCE(s.quantity,    t.quantity),
          date_added  = COALESCE(s.date_added,  t.date_added),
          notes       = COALESCE(s.notes,       t.notes),
          updated_at  = TIMESTAMP(s.updated_at)
    `;
    try {
      await bq.query({ query, params, types });
      return { failures: [] };
    } catch (err) {
      if (_isStreamingBufferError(err)) {
        return { failures: rows.map(r => ({ key: r.row_uid, reason: STREAMING_BUFFER_REASON })) };
      }
      throw err;
    }
  }

  async function updateOrdersByOrderId(organizationId, rows) {
    if (!rows.length) return { failures: [] };
    // `shipped_touched` is the sentinel: when the user fills the shipped_sku
    // cell, the schema sets the field on the row. We then OVERWRITE BOTH
    // shipped columns (one will be null, the other populated) instead of
    // COALESCE-preserving. Without this, switching from a box-override to a
    // wrong-part override would leave the old shipped_from_box hanging.
    const params = {
      organizationId,
      rows: rows.map(r => {
        const shippedTouched = Object.prototype.hasOwnProperty.call(r, 'shipped_from_box')
                            || Object.prototype.hasOwnProperty.call(r, 'shipped_sku_override');
        return {
          order_row_id:         r.order_row_id,
          order_date:           r.order_date       ?? null,
          sku:                  r.sku              ?? null,
          quantity_sold:        r.quantity_sold    ?? null,
          platform:             r.platform         ?? null,
          shipped_from_box:     r.shipped_from_box     ?? null,
          shipped_sku_override: r.shipped_sku_override ?? null,
          shipped_touched:      shippedTouched,
        };
      }),
    };
    const types = {
      rows: [{
        order_row_id:         'STRING',
        order_date:           'STRING',
        sku:                  'STRING',
        quantity_sold:        'INT64',
        platform:             'STRING',
        shipped_from_box:     'STRING',
        shipped_sku_override: 'STRING',
        shipped_touched:      'BOOL',
      }],
    };
    const query = `
      MERGE INTO ${ordTable} AS t
      USING (SELECT * FROM UNNEST(@rows)) AS s
      ON t.organization_id = @organizationId AND t.order_row_id = s.order_row_id
      WHEN MATCHED THEN
        UPDATE SET
          order_date           = COALESCE(s.order_date,    t.order_date),
          sku                  = COALESCE(s.sku,           t.sku),
          quantity_sold        = COALESCE(s.quantity_sold, t.quantity_sold),
          platform             = COALESCE(s.platform,      t.platform),
          shipped_from_box     = CASE WHEN s.shipped_touched THEN s.shipped_from_box     ELSE t.shipped_from_box     END,
          shipped_sku_override = CASE WHEN s.shipped_touched THEN s.shipped_sku_override ELSE t.shipped_sku_override END
    `;
    try {
      await bq.query({ query, params, types });
      return { failures: [] };
    } catch (err) {
      if (_isStreamingBufferError(err)) {
        return { failures: rows.map(r => ({ key: r.order_row_id, reason: STREAMING_BUFFER_REASON })) };
      }
      throw err;
    }
  }

  // Single batch DELETE per chunk. No per-row fallback — for big chunks
  // (CHUNK_SIZE_REMOVE = 10000) a per-row loop would dwarf Cloud Run's
  // 5-min request budget, killing the container and producing a CORS
  // error in the browser. On buffer rejection we report all keys in the
  // chunk as failures so the rest of the upload (other chunks, other
  // operations) still completes and the user knows exactly what to retry.
  async function deleteInventoryByRowUids(organizationId, rowUids) {
    if (!rowUids.length) return { failures: [] };
    const query = `
      DELETE FROM ${invTable}
      WHERE organization_id = @organizationId
        AND row_uid IN UNNEST(@rowUids)
    `;
    try {
      await bq.query({ query, params: { organizationId, rowUids } });
      return { failures: [] };
    } catch (err) {
      if (_isStreamingBufferError(err)) {
        return { failures: rowUids.map(id => ({ key: id, reason: STREAMING_BUFFER_REASON })) };
      }
      throw err;
    }
  }

  async function deleteOrdersByOrderIds(organizationId, orderIds) {
    if (!orderIds.length) return { failures: [] };
    const query = `
      DELETE FROM ${ordTable}
      WHERE organization_id = @organizationId
        AND order_row_id IN UNNEST(@orderIds)
    `;
    try {
      await bq.query({ query, params: { organizationId, orderIds } });
      return { failures: [] };
    } catch (err) {
      if (_isStreamingBufferError(err)) {
        return { failures: orderIds.map(id => ({ key: id, reason: STREAMING_BUFFER_REASON })) };
      }
      throw err;
    }
  }

  return {
    getHistory, logInventoryUpload, logOrderUpload, getUploadReport,
    deleteInventory, insertInventoryBatch, insertOrdersBatch,
    getInventoryKeySet, getOrderKeySet,
    updateInventoryByRowUid, updateOrdersByOrderId,
    deleteInventoryByRowUids, deleteOrdersByOrderIds,
  };
}
