import { authenticate, requireRole } from '../middleware/authenticate.js';
import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();

const STATUS_VALUES = z.enum(['all', 'normal', 'unknown']).optional().default('all');

const effectiveShippedSku = (sku, shippedFromBox) => {
  if (!sku) return '';
  const m = sku.match(/^ARA(\d+)(-.+)$/);
  if (!m) return sku;
  return shippedFromBox ? `ARA${shippedFromBox}${m[2]}` : sku;
};

const ordersExportSchema = z.object({
  platform:   z.string().optional(),
  start_date: z.string().optional(),
  end_date:   z.string().optional(),
  search:     z.string().optional(),
  sort_by:    z.enum(['order_date','sku','quantity_sold','platform','shipped_from_box']).optional().default('order_date'),
  sort_dir:   z.enum(['asc','desc']).optional().default('desc'),
  status:     STATUS_VALUES,
});

const ordersQuerySchema = z.object({
  page:       positiveInt.optional().default(1),
  pageSize:   positiveInt.max(10000).optional().default(50),
  platform:   z.string().optional(),
  start_date: z.string().optional(),
  end_date:   z.string().optional(),
  search:     z.string().optional(),
  sort_by:    z.enum(['order_date', 'sku', 'quantity_sold', 'platform', 'shipped_from_box']).optional().default('order_date'),
  sort_dir:   z.enum(['asc', 'desc']).optional().default('desc'),
  status:     STATUS_VALUES,
});

const deleteFiltersSchema = z.object({
  platform:   z.string().optional(),
  start_date: z.string().optional(),
  end_date:   z.string().optional(),
  search:     z.string().optional(),
});

const deleteBodySchema = z.object({
  row_ids: z.array(z.string()).min(1).optional(),
  filters: deleteFiltersSchema.optional(),
}).refine(
  data => (data.row_ids?.length > 0) || (data.filters && Object.values(data.filters).some(v => v)),
  { message: 'Provide row_ids or at least one filter criterion' }
);

const patchSchema = z.object({
  order_date:       z.string().min(1),
  quantity_sold:    z.coerce.number().int().positive(),
  platform:         z.string().min(1),
  shipped_from_box: z.string().optional().default(''),
  original_sku:     z.string().optional().default(''),
});

export async function ordersRoutes(fastify, { ordersService, activityService }) {
  fastify.get('/export', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = ordersExportSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid query parameters' });
    }
    try {
      const { sort_by, sort_dir, status, start_date, end_date, ...rest } = parsed.data;
      const rows = await ordersService.exportAll(request.user.organization_id, {
        ...rest,
        startDate: start_date || null,
        endDate:   end_date   || null,
        sortBy:    sort_by,
        sortDir:   sort_dir,
        status:    status     || 'all',
      });

      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = 'Order Date,SKU,Qty Sold,Shipped SKU,Platform';
      const lines  = rows.map(r => [
        r.order_date,
        r.sku,
        r.quantity_sold,
        effectiveShippedSku(r.sku, r.shipped_from_box),
        r.platform,
      ].map(esc).join(','));

      const filename = `orders-export-${new Date().toISOString().slice(0,10)}.csv`;
      const csv      = '﻿' + [header, ...lines].join('\n');

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(csv);
    } catch (err) {
      request.log.error({ err }, 'Orders export error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  fastify.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = ordersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid query parameters' });
    }

    const { page, pageSize, platform, start_date, end_date, search, sort_by, sort_dir, status } = parsed.data;
    try {
      const data = await ordersService.list(request.user.organization_id, {
        page, pageSize,
        platform:  platform   || null,
        startDate: start_date || null,
        endDate:   end_date   || null,
        search:    search     || null,
        sortBy:    sort_by,
        sortDir:   sort_dir,
        status:    status     || 'all',
      });
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Orders list error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  fastify.get('/platforms', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const data = await ordersService.getPlatforms(request.user.organization_id);
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Platforms error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  fastify.patch('/:rowId', { preHandler: [authenticate, requireRole('staff')] }, async (request, reply) => {
    const rowId  = request.params.rowId;
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid body', details: parsed.error.flatten() });
    }
    const { original_sku, ...rowUpdates } = parsed.data;
    const updates = {
      ...rowUpdates,
      shipped_from_box: rowUpdates.shipped_from_box || null,
    };
    try {
      await ordersService.updateRow(request.user.organization_id, rowId, updates);
      const originalLabel  = original_sku || rowId;
      const reassignedDesc = updates.shipped_from_box
        ? `Reassigned fulfillment: ${originalLabel} → shipped from box ${updates.shipped_from_box} (order ${rowId})`
        : `Reverted to original fulfillment SKU for ${originalLabel} (order ${rowId})`;
      activityService?.log({
        organizationId: request.user.organization_id,
        userId:         request.user.user_id,
        actionType:     'reassign_fulfillment_sku',
        entityType:     'orders',
        description:    reassignedDesc,
      }).catch(() => {});
      return reply.send({ success: true });
    } catch (err) {
      request.log.error({ err }, 'Order update error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  fastify.delete('/rows', { preHandler: [authenticate, requireRole('manager')] }, async (request, reply) => {
    const parsed = deleteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const msg = parsed.error.errors[0]?.message || 'Invalid request body';
      return reply.code(400).send({ success: false, error: msg });
    }

    const { row_ids, filters } = parsed.data;
    try {
      const data = await ordersService.deleteRows(request.user.organization_id, {
        rowIds:  row_ids || null,
        filters: filters ? {
          platform:  filters.platform  || null,
          startDate: filters.start_date || null,
          endDate:   filters.end_date   || null,
          search:    filters.search     || null,
        } : null,
      });
      activityService?.log({
        organizationId: request.user.organization_id,
        userId:         request.user.user_id,
        actionType:     'delete_orders',
        entityType:     'orders',
        description:    `Deleted ${data.deleted} order${data.deleted !== 1 ? 's' : ''}`,
      }).catch(() => {});
      return reply.send({ success: true, data });
    } catch (err) {
      if (err.code === 400) return reply.code(400).send({ success: false, error: err.message });
      request.log.error({ err }, 'Orders delete error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
