'use strict';

// Logical dataset groupings — all point to the same BigQuery dataset while the
// project runs on Apps Script.  When Cloud Run migration is done, split into
// real separate datasets (core / logs / staging).
var DATASETS = {
  CORE:    'patman_inventory',
  LOGS:    'patman_inventory',
  STAGING: 'patman_inventory'
};

// Fully-qualified dataset.table references (project prefix added by BQ.tableRef).
var TABLES = {
  // Core domain
  INVENTORY:         DATASETS.CORE    + '.inventory',
  ORDERS:            DATASETS.CORE    + '.orders',
  USERS:             DATASETS.CORE    + '.users',
  ACCESS_REQUESTS:   DATASETS.CORE    + '.access_requests',
  SKU_CORRECTIONS:   DATASETS.CORE    + '.sku_corrections',

  // Observability
  VALIDATION_ERRORS: DATASETS.LOGS    + '.validation_errors',
  DEBUG_LOGS:        DATASETS.LOGS    + '.debug_logs',

  // Staging / upload tracking
  INVENTORY_UPLOADS: DATASETS.STAGING + '.inventory_uploads',
  ORDER_UPLOADS:     DATASETS.STAGING + '.order_uploads'
};

var CONFIG = {
  BQ: {
    PROJECT_ID: 'patman-inventory',
    DATASETS:   DATASETS,
    TABLES:     TABLES
  },

  AUTH: {
    SESSION_CACHE_SECONDS: 8 * 60 * 60,   // 8 hours
    ROLES: {
      ADMIN:   'admin',
      MANAGER: 'manager',
      VIEWER:  'viewer'
    },
    ROLE_HIERARCHY: { admin: 3, manager: 2, viewer: 1 }
  },

  UPLOAD: {
    INVENTORY_REQUIRED_COLS: ['sku', 'box_number', 'part_number', 'upc', 'quantity', 'date_added'],
    INVENTORY_ALL_COLS:      ['sku', 'box_number', 'part_number', 'upc', 'quantity', 'date_added', 'notes'],
    ORDERS_REQUIRED_COLS:    ['order_id', 'order_date', 'sku', 'upc', 'quantity_sold'],
    ORDERS_ALL_COLS:         ['order_id', 'order_date', 'sku', 'upc', 'quantity_sold',
                              'source_file', 'processed_at', 'shipped_from_box', 'platform'],
    MAX_ROWS:          10000,
    INSERT_CHUNK_SIZE: 500
  },

  APP: {
    NAME:                     'Patman Inventory',
    VERSION:                  '2.1.0',
    DEBUG_LOG_RETENTION_DAYS: 30,
    QUERY_TIMEOUT_MS:         60000
  }
};
