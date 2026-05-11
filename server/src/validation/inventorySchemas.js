import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();

export const inventoryQuerySchema = z.object({
  page:     positiveInt.optional().default(1),
  pageSize: positiveInt.max(200).optional().default(50),
  search:   z.string().optional(),
  platform: z.string().optional(),
  status:   z.enum(['active', 'inactive', 'all']).optional().default('all'),
  sortBy:   z.enum(['sku', 'name', 'platform', 'stock', 'updated_at']).optional().default('updated_at'),
  sortDir:  z.enum(['asc', 'desc']).optional().default('desc'),
});
