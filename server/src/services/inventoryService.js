export function createInventoryService({ inventoryRepo }) {
  async function list(organizationId, filters) {
    const { items, total } = await inventoryRepo.findAll({ organizationId, ...filters });
    return {
      items,
      total,
      page:     filters.page,
      pageSize: filters.pageSize,
      pages:    Math.ceil(total / filters.pageSize),
    };
  }

  async function deleteRows(organizationId, skus) {
    const deleted = await inventoryRepo.deleteBySkus(organizationId, skus);
    return { deleted };
  }

  async function updateRow(organizationId, originalSku, updates) {
    await inventoryRepo.updateRow(organizationId, originalSku, updates);
  }

  async function findAlternatives(organizationId, sku) {
    const { originalBox, alternatives } = await inventoryRepo.findAlternativeBoxes(organizationId, sku);
    return {
      originalBox,
      alternatives,
      inStock:  alternatives.filter(a => a.remaining_stock > 0),
    };
  }

  async function exportAll(organizationId, filters) {
    return inventoryRepo.exportAll({ organizationId, ...filters });
  }

  return { list, exportAll, deleteRows, updateRow, findAlternatives };
}
