import { authenticate } from '../middleware/authenticate.js';
import { inventoryQuerySchema } from '../validation/inventorySchemas.js';

export async function inventoryRoutes(fastify, { inventoryService }) {
  fastify.get(
    '/',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const parsed = inventoryQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Invalid query parameters', details: parsed.error.flatten() });
      }

      try {
        const result = await inventoryService.list(parsed.data);
        return reply.send({ success: true, data: result });
      } catch (err) {
        request.log.error({ err }, 'Inventory list error');
        return reply.code(500).send({ success: false, error: 'Internal server error' });
      }
    }
  );
}
