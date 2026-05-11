export const DATASETS = {
  CORE:      'patman_inventory',
  LOGS:      'patman_inventory',
  STAGING:   'patman_inventory',
  ANALYTICS: 'patman_inventory',
};

export const TABLES = {
  ORGANIZATIONS:     `${DATASETS.CORE}.organizations`,
  MEMBERSHIPS:       `${DATASETS.CORE}.memberships`,
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
