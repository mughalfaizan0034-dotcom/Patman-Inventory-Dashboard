'use strict';

var Uploads = {

  processInventoryUpload: function (csvText, filename, userEmail) {
    var uploadId = Util.generateId();
    var rec = {
      upload_id:   uploadId,
      filename:    filename || 'inventory.csv',
      uploaded_by: userEmail || '',
      uploaded_at: new Date().toISOString(),
      type:        'inventory',
      status:      'processing',
      row_count:   0,
      error_count: 0,
      notes:       ''
    };

    try {
      var parsed = Util.parseCSV(csvText);

      var missing = Validation.checkRequiredColumns(parsed.headers, CONFIG.UPLOAD.INVENTORY_REQUIRED_COLS);
      if (missing.length) {
        rec.status = 'failed';
        rec.notes  = 'Missing columns: ' + missing.join(', ');
        Uploads._saveUploadRecord(CONFIG.BQ.TABLES.INVENTORY_UPLOADS, rec);
        return Util.error('Missing required columns: ' + missing.join(', '), { missingColumns: missing });
      }

      if (!parsed.rows.length) {
        rec.status = 'failed'; rec.notes = 'No data rows';
        Uploads._saveUploadRecord(CONFIG.BQ.TABLES.INVENTORY_UPLOADS, rec);
        return Util.error('No data rows found in the file');
      }

      if (parsed.rows.length > CONFIG.UPLOAD.MAX_ROWS) {
        return Util.error('File exceeds the ' + CONFIG.UPLOAD.MAX_ROWS + ' row limit');
      }

      var errors = Validation.validateInventoryData(parsed.rows);

      if (errors.length) {
        Uploads._saveValidationErrors(uploadId, 'inventory', errors);
        rec.status      = 'failed';
        rec.row_count   = parsed.rows.length;
        rec.error_count = errors.length;
        rec.notes       = errors.length + ' validation errors';
        Uploads._saveUploadRecord(CONFIG.BQ.TABLES.INVENTORY_UPLOADS, rec);
        return Util.error('Validation failed: ' + errors.length + ' error(s)', {
          uploadId: uploadId,
          errors:   errors.slice(0, 50)
        });
      }

      var rows = parsed.rows.map(function (r) {
        return {
          sku:         r.sku.trim(),
          box_number:  r.box_number.toString().trim(),
          part_number: r.part_number.toString().trim(),
          upc:         r.upc.toString().trim(),
          quantity:    parseInt(r.quantity),
          date_added:  r.date_added.trim(),
          notes:       r.notes || '',
          upload_id:   uploadId,
          created_at:  new Date().toISOString()
        };
      });

      Util.chunkArray(rows, CONFIG.UPLOAD.INSERT_CHUNK_SIZE).forEach(function (chunk) {
        BQ.insertRows(CONFIG.BQ.TABLES.INVENTORY, chunk);
      });

      rec.status    = 'success';
      rec.row_count = rows.length;
      rec.notes     = rows.length + ' records imported';
      Uploads._saveUploadRecord(CONFIG.BQ.TABLES.INVENTORY_UPLOADS, rec);

      Debug.logWithUser('Uploads', 'processInventoryUpload', 'success',
        { uploadId: uploadId, rows: rows.length }, userEmail);

      return Util.success({
        uploadId:    uploadId,
        rowsInserted: rows.length,
        message:     rows.length + ' inventory records imported successfully'
      });

    } catch (e) {
      rec.status = 'error'; rec.notes = e.message;
      try { Uploads._saveUploadRecord(CONFIG.BQ.TABLES.INVENTORY_UPLOADS, rec); } catch (_) {}
      Debug.log('Uploads', 'processInventoryUpload', 'error', { error: e.message });
      return Util.error('Upload processing failed: ' + e.message);
    }
  },

  processOrdersUpload: function (csvText, filename, userEmail) {
    var uploadId = Util.generateId();
    var rec = {
      upload_id:   uploadId,
      filename:    filename || 'orders.csv',
      uploaded_by: userEmail || '',
      uploaded_at: new Date().toISOString(),
      type:        'orders',
      status:      'processing',
      row_count:   0,
      error_count: 0,
      notes:       ''
    };

    try {
      var parsed = Util.parseCSV(csvText);

      var missing = Validation.checkRequiredColumns(parsed.headers, CONFIG.UPLOAD.ORDERS_REQUIRED_COLS);
      if (missing.length) {
        rec.status = 'failed'; rec.notes = 'Missing columns: ' + missing.join(', ');
        Uploads._saveUploadRecord(CONFIG.BQ.TABLES.ORDER_UPLOADS, rec);
        return Util.error('Missing required columns: ' + missing.join(', '), { missingColumns: missing });
      }

      if (!parsed.rows.length) {
        return Util.error('No data rows found in the file');
      }

      var errors = Validation.validateOrdersData(parsed.rows);

      if (errors.length) {
        Uploads._saveValidationErrors(uploadId, 'orders', errors);
        rec.status      = 'failed';
        rec.row_count   = parsed.rows.length;
        rec.error_count = errors.length;
        rec.notes       = errors.length + ' validation errors';
        Uploads._saveUploadRecord(CONFIG.BQ.TABLES.ORDER_UPLOADS, rec);
        return Util.error('Validation failed: ' + errors.length + ' error(s)', {
          uploadId: uploadId,
          errors:   errors.slice(0, 50)
        });
      }

      // Duplicate check against BigQuery
      var allIds = parsed.rows.map(function (r) {
        return "'" + Util.escapeSql(r.order_id.toString().trim()) + "'";
      });
      var existSql = [
        'SELECT order_id FROM `' + BQ.tableRef(CONFIG.BQ.TABLES.ORDERS) + '`',
        'WHERE order_id IN (' + allIds.join(',') + ')'
      ].join('\n');
      var existRows = BQ.runQuery(existSql) || [];
      var existSet  = {};
      existRows.forEach(function (r) { existSet[r.order_id] = true; });

      var toInsert = [], skipped = 0;
      parsed.rows.forEach(function (r) {
        var oid = r.order_id.toString().trim();
        if (existSet[oid]) { skipped++; return; }
        toInsert.push({
          order_id:         oid,
          order_date:       r.order_date.trim(),
          sku:              r.sku.trim(),
          upc:              r.upc.toString().trim(),
          quantity_sold:    parseInt(r.quantity_sold),
          source_file:      r.source_file    || filename || '',
          processed_at:     r.processed_at   || new Date().toISOString(),
          shipped_from_box: r.shipped_from_box || '',
          platform:         r.platform        || '',
          upload_id:        uploadId,
          created_at:       new Date().toISOString()
        });
      });

      if (toInsert.length) {
        Util.chunkArray(toInsert, CONFIG.UPLOAD.INSERT_CHUNK_SIZE).forEach(function (chunk) {
          BQ.insertRows(CONFIG.BQ.TABLES.ORDERS, chunk);
        });
      }

      rec.status    = 'success';
      rec.row_count = toInsert.length;
      rec.notes     = toInsert.length + ' imported, ' + skipped + ' skipped (duplicates)';
      Uploads._saveUploadRecord(CONFIG.BQ.TABLES.ORDER_UPLOADS, rec);

      Debug.logWithUser('Uploads', 'processOrdersUpload', 'success',
        { uploadId: uploadId, inserted: toInsert.length, skipped: skipped }, userEmail);

      return Util.success({
        uploadId:    uploadId,
        rowsInserted: toInsert.length,
        rowsSkipped:  skipped,
        message:     toInsert.length + ' orders imported.' +
          (skipped ? ' ' + skipped + ' order(s) skipped — already exist.' : '')
      });

    } catch (e) {
      rec.status = 'error'; rec.notes = e.message;
      try { Uploads._saveUploadRecord(CONFIG.BQ.TABLES.ORDER_UPLOADS, rec); } catch (_) {}
      Debug.log('Uploads', 'processOrdersUpload', 'error', { error: e.message });
      return Util.error('Upload processing failed: ' + e.message);
    }
  },

  getUploadHistory: function (type) {
    var invTbl = CONFIG.BQ.TABLES.INVENTORY_UPLOADS;
    var ordTbl = CONFIG.BQ.TABLES.ORDER_UPLOADS;

    // Alias DB column names to what the frontend expects:
    //   type        → upload_type
    //   row_count   → rows_inserted
    //   error_count → rows_skipped
    var cols = [
      'upload_id, filename, uploaded_by, uploaded_at,',
      'type AS upload_type, status,',
      'row_count AS rows_inserted, error_count AS rows_skipped, notes'
    ].join(' ');

    var invSql = "SELECT " + cols + " FROM `" + BQ.tableRef(invTbl) + "`";
    var ordSql = "SELECT " + cols + " FROM `" + BQ.tableRef(ordTbl) + "`";

    var sql;
    if (type === 'inventory') {
      sql = invSql + ' ORDER BY uploaded_at DESC LIMIT 50';
    } else if (type === 'orders') {
      sql = ordSql + ' ORDER BY uploaded_at DESC LIMIT 50';
    } else {
      sql = '(' + invSql + ') UNION ALL (' + ordSql + ') ORDER BY uploaded_at DESC LIMIT 100';
    }

    return BQ.runQuery(sql) || [];
  },

  getValidationErrors: function (uploadId) {
    var where = uploadId
      ? "WHERE upload_id = '" + Util.escapeSql(uploadId) + "'"
      : '';

    var sql = [
      'SELECT error_id, upload_id, upload_type, row_number, column_name, issue, created_at',
      'FROM `' + BQ.tableRef(CONFIG.BQ.TABLES.VALIDATION_ERRORS) + '`',
      where,
      'ORDER BY upload_id, row_number',
      'LIMIT 1000'
    ].join('\n');

    return BQ.runQuery(sql) || [];
  },

  // Returns CSV text for template download (called from doGet)
  getTemplateCSV: function (type) {
    if (type === 'orders') {
      return Util.buildCSVTemplate(CONFIG.UPLOAD.ORDERS_ALL_COLS);
    }
    return Util.buildCSVTemplate(CONFIG.UPLOAD.INVENTORY_ALL_COLS);
  },

  _saveUploadRecord: function (table, rec) {
    try { BQ.insertRows(table, [rec]); } catch (e) {
      Debug.log('Uploads', '_saveUploadRecord', 'error', { table: table, error: e.message });
    }
  },

  _saveValidationErrors: function (uploadId, uploadType, errors) {
    try {
      var rows = errors.map(function (e) {
        return {
          error_id:    Util.generateId(),
          upload_id:   uploadId,
          upload_type: uploadType,
          row_number:  e.row,
          column_name: e.column,
          issue:       e.issue,
          created_at:  new Date().toISOString()
        };
      });
      Util.chunkArray(rows, CONFIG.UPLOAD.INSERT_CHUNK_SIZE).forEach(function (chunk) {
        BQ.insertRows(CONFIG.BQ.TABLES.VALIDATION_ERRORS, chunk);
      });
    } catch (e) {
      Debug.log('Uploads', '_saveValidationErrors', 'error', { error: e.message });
    }
  }
};
