'use strict';

var BQ = {

  // tableName is expected to be a dataset.table string (e.g. 'patman_inventory.inventory')
  // as produced by the TABLES constants in Config.gs.
  tableRef: function (tableName) {
    return CONFIG.BQ.PROJECT_ID + '.' + tableName;
  },

  // Execute a SQL query and return an array of plain row objects.
  runQuery: function (sql) {
    try {
      var request = {
        query:        sql,
        useLegacySql: false,
        timeoutMs:    CONFIG.APP.QUERY_TIMEOUT_MS,
        location:     'US'
      };

      var response = BigQuery.Jobs.query(request, CONFIG.BQ.PROJECT_ID);

      // Poll until the job finishes if needed
      if (!response.jobComplete) {
        var jobId  = response.jobReference.jobId;
        var waited = 0;
        var maxWait = 60;

        while (!response.jobComplete && waited < maxWait) {
          Utilities.sleep(1000);
          waited++;
          response = BigQuery.Jobs.getQueryResults(
            CONFIG.BQ.PROJECT_ID, jobId, { timeoutMs: 10000, location: 'US' }
          );
        }

        if (!response.jobComplete) {
          throw new Error('BigQuery job timed out after ' + maxWait + 's');
        }
      }

      if (response.status && response.status.errorResult) {
        throw new Error(response.status.errorResult.message);
      }

      return BQ._parseRows(response);

    } catch (e) {
      Debug.log('BigQuery', 'runQuery', 'error', {
        sql:   sql.substring(0, 300),
        error: e.message
      });
      throw new Error('BigQuery query failed: ' + e.message);
    }
  },

  // Streaming insert — fastest way to append rows. No deduplication by default.
  insertRows: function (tableName, rows) {
    if (!rows || rows.length === 0) return { insertedCount: 0 };

    try {
      var insertRequest = {
        rows: rows.map(function (row) {
          return { insertId: Util.generateId(), json: row };
        }),
        skipInvalidRows:    false,
        ignoreUnknownValues: false
      };

      // tableName is 'dataset.table' — split for the Tabledata API
      var parts     = tableName.split('.');
      var datasetId = parts[0];
      var tableId   = parts[1];

      var resp = BigQuery.Tabledata.insertAll(
        insertRequest,
        CONFIG.BQ.PROJECT_ID,
        datasetId,
        tableId
      );

      if (resp.insertErrors && resp.insertErrors.length > 0) {
        var msgs = resp.insertErrors.map(function (ie) {
          var errs = (ie.errors || []).map(function (e) { return e.message; }).join(', ');
          return 'Row ' + ie.index + ': ' + errs;
        });
        throw new Error('Insert errors: ' + msgs.join(' | '));
      }

      return { insertedCount: rows.length };

    } catch (e) {
      Debug.log('BigQuery', 'insertRows', 'error', { table: tableName, error: e.message });
      throw new Error('BigQuery insert failed for ' + tableName + ': ' + e.message);
    }
  },

  // DML (UPDATE / DELETE) — uses asynchronous job API, waits for completion.
  runDML: function (sql) {
    try {
      var job = BigQuery.Jobs.insert(
        { configuration: { query: { query: sql, useLegacySql: false } } },
        CONFIG.BQ.PROJECT_ID
      );

      var jobId  = job.jobReference.jobId;
      var waited = 0;
      var status = BigQuery.Jobs.get(CONFIG.BQ.PROJECT_ID, jobId);

      while (status.status.state !== 'DONE' && waited < 60) {
        Utilities.sleep(1000);
        waited++;
        status = BigQuery.Jobs.get(CONFIG.BQ.PROJECT_ID, jobId);
      }

      if (status.status.errorResult) {
        throw new Error(status.status.errorResult.message);
      }

      return { success: true };

    } catch (e) {
      Debug.log('BigQuery', 'runDML', 'error', { sql: sql.substring(0, 300), error: e.message });
      throw new Error('BigQuery DML failed: ' + e.message);
    }
  },

  _parseRows: function (response) {
    if (!response || !response.rows) return [];

    var fields = response.schema ? response.schema.fields.map(function (f) { return f.name; }) : null;

    return response.rows.map(function (row) {
      var obj = {};
      row.f.forEach(function (cell, i) {
        var key = fields ? fields[i] : String(i);
        obj[key] = cell.v;
      });
      return obj;
    });
  }
};
