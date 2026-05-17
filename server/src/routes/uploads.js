import { authenticate, requireRole } from '../middleware/authenticate.js';
import { AppError } from '../utils/errors.js';

// Accepted upload format is TSV (Tab Separated Values). Excel exports TSV
// cleanly via "Save As → Tab Separated Values (.tsv)" — this avoids the
// ambiguity that occurred when users saved as "Text (Tab delimited) .txt"
// and Excel produced comma-separated content instead.
//
// .txt is still accepted as a backward-compat alias for users who already
// have correctly tab-delimited .txt files from earlier exports.
//
// File MIME types are NOT checked: browsers vary too much in what they send
// for TSV (text/plain, text/tab-separated-values, application/octet-stream,
// even empty). The extension check + downstream TSV parser are the real
// validators — a wrong-format upload fails parsing with a clear error.
function validateUploadFile(part) {
  if (!part) return 'No file uploaded';
  const name = (part.filename ?? '').toLowerCase();
  if (!/\.(tsv|txt)$/.test(name)) {
    return 'Only UTF-8 tab-separated .tsv files are accepted (use Excel → Save As → Tab Separated Values .tsv).';
  }
  return null;
}

export async function uploadsRoutes(fastify, { uploadsService, dashboardService, summaryRefreshService }) {

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

      const fileErr = validateUploadFile(part);
      if (fileErr) return reply.code(400).send({ success: false, error: fileErr });

      try {
        const { organization_id, user_id } = request.user;
        const result = await uploadsService.processInventoryUpload(
          organization_id, user_id, part.file, part.filename
        );
        dashboardService?.invalidateKPICache(organization_id);
        // Fire-and-forget summary rebuild. Refresh failures are logged
        // inside the service; the upload response is unaffected.
        summaryRefreshService?.refresh(organization_id).catch(() => {});

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
        return reply.code(500).send({ success: false, error: err?.message || 'Internal server error' });
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

      const fileErr = validateUploadFile(part);
      if (fileErr) return reply.code(400).send({ success: false, error: fileErr });

      try {
        const { organization_id, user_id } = request.user;
        const result = await uploadsService.processOrdersUpload(
          organization_id, user_id, part.file, part.filename
        );
        dashboardService?.invalidateKPICache(organization_id);
        // Fire-and-forget summary rebuild. Refresh failures are logged
        // inside the service; the upload response is unaffected.
        summaryRefreshService?.refresh(organization_id).catch(() => {});

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
        return reply.code(500).send({ success: false, error: err?.message || 'Internal server error' });
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
        return reply.code(500).send({ success: false, error: err?.message || 'Internal server error' });
      }
    }
  );

  // Download the per-upload plain-text summary report. Returned as
  // attachment so the browser triggers a save dialog. Org-scoped: a user
  // can only download reports for uploads in their current organization.
  fastify.get(
    '/report/:upload_id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const uploadId = request.params.upload_id;
      try {
        const row = await uploadsService.getReport(request.user.organization_id, uploadId);
        if (!row) {
          return reply.code(404).send({ success: false, error: 'Upload not found in your organization' });
        }
        const text = row.report || `No report available for this upload.\n`;
        const safeName = (row.filename || `upload_${uploadId}`)
          .replace(/\.(tsv|txt|csv)$/i, '')
          .replace(/[^a-zA-Z0-9._-]+/g, '_');
        const reportName = `${safeName}_report.txt`;

        reply.header('Content-Type', 'text/plain; charset=utf-8');
        reply.header('Content-Disposition', `attachment; filename="${reportName}"`);
        return reply.send(text);
      } catch (err) {
        request.log.error({ err }, 'Upload report error');
        return reply.code(500).send({ success: false, error: err?.message || 'Internal server error' });
      }
    }
  );

  // Template downloads — tab-delimited .txt files matching the upload format.
  fastify.get(
    '/template/:type',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { type } = request.params;

      const templates = {
        // uid is the canonical row tracker. For Add: leave blank — system
        // assigns one. For Update / Remove: paste the existing row's uid
        // (copy from the Inventory table or a previous export).
        inventory: [
          'action,uid,sku,upc,quantity,part_number,box_number,date_added,notes',
          'Add,,SKU-001,012345678901,25,PT-123,BX-001,2026-05-11,Sample item',
          'Add,,SKU-002,098765432109,10,,,2026-05-11,',
          'Update,UID-FROM-EXPORT,,,30,,,,',
          'Remove,UID-FROM-EXPORT,,,,,,, ',
        ].join('\r\n'),
        // Orders template — 8 columns:
        //   action, uid, order_id, order_date, sku, quantity_sold, platform, shipped_sku
        //
        //   uid          — INTERNAL row tracker. Leave blank on Add (auto-assigned);
        //                  paste from a previous export for Update / Remove.
        //   order_id     — EXTERNAL marketplace order number (Amazon order ID,
        //                  eBay sale ID, etc.). Required on Add.
        //   shipped_sku  — Fulfillment override. Accepts three forms:
        //                  "20" or "ARA20"  → same-part box override
        //                  "ARA20-4060915-037256018282"
        //                                  → full alternate SKU (wrong-part allowed)
        //                  blank           → no override
        //                  Legacy header `shipped_from_box` is still accepted.
        orders: [
          'action,uid,order_id,order_date,sku,quantity_sold,platform,shipped_sku',
          'Add,,111-2222222-3333333,2026-05-11,SKU-001,2,Amazon,BX-001',
          'Add,,EBAY-9876543210,2026-05-11,SKU-002,1,eBay,',
          'Update,UID-FROM-EXPORT,,,,3,,',
          'Remove,UID-FROM-EXPORT,,,,,,',
        ].join('\r\n'),
      };

      if (!templates[type]) {
        return reply.code(404).send({ success: false, error: 'Unknown template type' });
      }

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${type}_template.csv"`)
        .send('﻿' + templates[type]);
    }
  );
}
