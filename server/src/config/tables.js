// Logical dataset groupings.
// All point to the single 'patman_inventory' dataset during the Apps Script
// transition.  When Phase 6 splits BigQuery into real datasets (core / logs /
// staging / analytics), only DATASETS values need updating here.
export const DATASETS = {
  CORE:      'patman_inventory',
  LOGS:      'patman_inventory',
  STAGING:   'patman_inventory',
  ANALYTICS: 'patman_inventory',
};

// Fully-qualified dataset.table strings.
// Usage: `${GCP_PROJECT_ID}.${TABLES.INVENTORY}` → 'patman-inventory.patman_inventory.inventory'
export const TABLES = {
  INVENTORY:         `${DATASETS.CORE}.inventory`,
  ORDERS:            `${DATASETS.CORE}.orders`,
  USERS:             `${DATASETS.CORE}.users`,
  ACCESS_REQUESTS:   `${DATASETS.CORE}.access_requests`,
  SKU_CORRECTIONS:   `${DATASETS.CORE}.sku_corrections`,

  VALIDATION_ERRORS: `${DATASETS.LOGS}.validation_errors`,
  DEBUG_LOGS:        `${DATASETS.LOGS}.debug_logs`,

  INVENTORY_UPLOADS: `${DATASETS.STAGING}.inventory_uploads`,
  ORDER_UPLOADS:     `${DATASETS.STAGING}.order_uploads`,
};
