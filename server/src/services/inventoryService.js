export function createInventoryService({ inventoryRepo }) {
  async function list(filters) {
    const { items, total } = await inventoryRepo.findAll(filters);
    return {
      items,
      total,
      page:     filters.page,
      pageSize: filters.pageSize,
      pages:    Math.ceil(total / filters.pageSize),
    };
  }

  return { list };
}
