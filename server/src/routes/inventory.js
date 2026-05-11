import { authenticate } from '../middleware/authenticate.js';
import { inventoryQuerySchema } from '../validation/inventorySchemas.js';
import { z } from 'zod';

const inventoryExportSchema = z.object({
  search:   z.string().optional(),
  sort_by:  z.enum(['sku','upc','box_number','quantity','date_added','part_number','notes','units_sold','remaining_stock']).optional().default('date_added'),
  sort_dir: z.enum(['asc','desc']).optional().default('desc'),
  status:   z.enum(['all','in_stock','oos','phantom','undefined']).optional().default('all'),
});

const inventoryPatchSchema = z.object({
  sku:        z.string().min(1),
  upc:        z.string().min(1),
  quantity:   z.coerce.number().int(),
  part_number: z.string().optional().default(''),
  box_number:  z.string().optional().default(''),
  notes:       z.string().optional().default(''),
  date_added:  z.string().optional().default(''),
});

const deleteBodySchema = z.object({
  skus: z.array(z.string().min(1)).min(1),
});

export async function inventoryRoutes(fastify, { inventoryService, activityService }) {
  fastify.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = inventoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid query parameters', details: parsed.error.flatten() });
    }
    try {
      const { sort_by, sort_dir, ...rest } = parsed.data;
      const result = await inventoryService.list(request.user.organization_id, {
        ...rest,
        sortBy:  sort_by,
        sortDir: sort_dir,
      });
      return reply.send({ success: true, data: result });
    } catch (err) {
      request.log.error({ err }, 'Inventory list error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  fastify.get('/export', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = inventoryExportSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid query parameters' });
    }
    try {
      const { sort_by, sort_dir, ...rest } = parsed.data;
      const rows = await inventoryService.exportAll(request.user.organization_id, {
        ...rest,
        sortBy:  sort_by,
        sortDir: sort_dir,
      });

      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = 'SKU,Box #,Part #,UPC,Initial Qty,Units Sold,Remaining,Date Added,Notes';
      const lines  = rows.map(r => [
        r.sku, r.box_number, r.part_number, r.upc,
        r.quantity, r.units_sold, r.remaining_stock,
        r.date_added, r.notes,
      ].map(esc).join(','));

      const isFiltered = rest.search || rest.status !== 'all';
      const filename   = `inventory_${isFiltered ? 'filtered_' : ''}export_${new Date().toISOString().slice(0,10)}.csv`;
      const csv        = '﻿' + [header, ...lines].join('\n');

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(csv);
    } catch (err) {
      request.log.error({ err }, 'Inventory export error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  fastify.get('/alternatives', { preHandler: [authenticate] }, async (request, reply) => {
    const sku = request.query.sku;
    if (!sku) return reply.code(400).send({ success: false, error: 'sku is required' });
    try {
      const data = await inventoryService.findAlternatives(request.user.organization_id, sku);
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Inventory alternatives error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  fastify.patch('/:sku', { preHandler: [authenticate] }, async (request, reply) => {
    const originalSku = decodeURIComponent(request.params.sku);
    const parsed = inventoryPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid body', details: parsed.error.flatten() });
    }
    try {
      await inventoryService.updateRow(request.user.organization_id, originalSku, parsed.data);
      activityService?.log({
        organizationId: request.user.organization_id,
        userId:         request.user.user_id,
        actionType:     'edit_inventory',
        entityType:     'inventory',
        description:    `Updated inventory SKU ${parsed.data.sku}`,
      }).catch(() => {});
      return reply.send({ success: true });
    } catch (err) {
      request.log.error({ err }, 'Inventory update error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  fastify.delete('/rows', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = deleteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: parsed.error.errors[0]?.message || 'Invalid body' });
    }
    try {
      const result = await inventoryService.deleteRows(request.user.organization_id, parsed.data.skus);
      activityService?.log({
        organizationId: request.user.organization_id,
        userId:         request.user.user_id,
        actionType:     'delete_inventory',
        entityType:     'inventory',
        description:    `Deleted ${result.deleted} inventory ${result.deleted === 1 ? 'row' : 'rows'}`,
      }).catch(() => {});
      return reply.send({ success: true, data: result });
    } catch (err) {
      request.log.error({ err }, 'Inventory delete error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
