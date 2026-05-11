import { authenticate, requireRole } from '../middleware/authenticate.js';
import { AppError } from '../utils/errors.js';

const ALLOWED_MIME = new Set([
  'text/plain',
  'text/tab-separated-values',
  'application/octet-stream', // some browsers send .txt as this
]);

function validateTxtFile(part) {
  if (!part) return 'No file uploaded';
  const name = part.filename ?? '';
  if (!name.toLowerCase().endsWith('.txt')) return 'Only UTF-8 tab-delimited .txt files are accepted';
  return null;
}

export async function uploadsRoutes(fastify, { uploadsService }) {

  fastify.post(
    '/inventory',
    { preHandler: [authenticate, requireRole('manager')] },
    async (request, reply) => {
      let part;
      try {
        part = await request.file();
      } catch {
        return reply.code(400).send({ success: false, error: 'Multipart upload required' });
      }

      const fileErr = validateTxtFile(part);
      if (fileErr) return reply.code(400).send({ success: false, error: fileErr });

      try {
        const { organization_id, user_id } = request.user;
        const result = await uploadsService.processInventoryUpload(
          organization_id, user_id, part.file, part.filename
        );

        request.log.info(
          { event: 'inventory_upload', user_id, organization_id, added: result.added, updated: result.updated, removed: result.removed },
          'Inventory uploaded'
        );
        return reply.send({ success: true, data: result });
      } catch (err) {
        if (err instanceof AppError) {
          return reply.code(err.statusCode).send({ success: false, error: err.message });
        }
        request.log.error({ err }, 'Inventory upload error');
        return reply.code(500).send({ success: false, error: 'Internal server error' });
      }
    }
  );

  fastify.post(
    '/orders',
    { preHandler: [authenticate, requireRole('manager')] },
    async (request, reply) => {
      let part;
      try {
        part = await request.file();
      } catch {
        return reply.code(400).send({ success: false, error: 'Multipart upload required' });
      }

      const fileErr = validateTxtFile(part);
      if (fileErr) return reply.code(400).send({ success: false, error: fileErr });

      try {
        const { organization_id, user_id } = request.user;
        const result = await uploadsService.processOrdersUpload(
          organization_id, user_id, part.file, part.filename
        );

        request.log.info(
          { event: 'orders_upload', user_id, organization_id, added: result.added, updated: result.updated, removed: result.removed },
          'Orders uploaded'
        );
        return reply.send({ success: true, data: result });
      } catch (err) {
        if (err instanceof AppError) {
          return reply.code(err.statusCode).send({ success: false, error: err.message });
        }
        request.log.error({ err }, 'Orders upload error');
        return reply.code(500).send({ success: false, error: 'Internal server error' });
      }
    }
  );

  fastify.get(
    '/history',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const type = ['inventory', 'orders', ''].includes(request.query.type ?? '')
        ? (request.query.type ?? '')
        : '';
      try {
        const data = await uploadsService.getHistory(request.user.organization_id, type);
        return reply.send({ success: true, data });
      } catch (err) {
        request.log.error({ err }, 'Upload history error');
        return reply.code(500).send({ success: false, error: 'Internal server error' });
      }
    }
  );

  // Template downloads — return tab-delimited .txt with column headers.
  fastify.get(
    '/template/:type',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { type } = request.params;

      const templates = {
        inventory: [
          'action\tsku\tupc\tquantity\tpart_number\tbox_number\tdate_added\tnotes',
          'Add\tSKU-001\t012345678901\t25\tPT-123\tBX-001\t2026-05-11\tSample item',
          'Add\tSKU-002\t098765432109\t10\t\t\t2026-05-11\t',
          'Update\tSKU-001\t\t30\t\t\t\t',
          'Remove\tSKU-002\t\t\t\t\t\t',
        ].join('\r\n'),
        orders: [
          'action\torder_id\torder_date\tsku\tquantity_sold\tplatform\tshipped_from_box',
          'Add\t\t2026-05-11\tSKU-001\t2\tAmazon\tBX-001',
          'Add\t\t2026-05-11\tSKU-002\t1\teBay\t',
          'Update\tORD-UUID-HERE\t\t\t3\t\t',
          'Remove\tORD-UUID-HERE\t\t\t\t\t',
        ].join('\r\n'),
      };

      if (!templates[type]) {
        return reply.code(404).send({ success: false, error: 'Unknown template type' });
      }

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${type}_template.csv"`)
        .send(templates[type]);
    }
  );
}
