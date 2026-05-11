import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();

export const inventoryQuerySchema = z.object({
  page:          positiveInt.optional().default(1),
  pageSize:      positiveInt.max(200).optional().default(50),
  search:        z.string().optional(),
  sortBy:        z.enum(['sku', 'upc', 'box_number', 'quantity', 'date_added', 'part_number', 'notes', 'units_sold', 'remaining_stock']).optional().default('date_added'),
  sortDir:       z.enum(['asc', 'desc']).optional().default('desc'),
  filter:        z.enum(['all', 'in-stock', 'oos', 'undefined']).optional().default('all'),
});
