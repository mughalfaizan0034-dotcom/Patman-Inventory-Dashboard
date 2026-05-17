import { runUploadPipeline }   from '../uploads/core/pipelineRunner.js';
import { inventoryImporter }   from '../uploads/importers/inventoryImporter.js';
import { ordersImporter }      from '../uploads/importers/ordersImporter.js';

export function createUploadsService({ uploadsRepo }) {

  // Phase A (2026-05-18): callers now supply `uploadId` when running
  // the new async upload lifecycle — the route pre-creates an
  // `accepted` row, hands the uploadId to the pipeline, then
  // finalizes the row after Phase 2-4 completes. The third arg stays
  // optional so legacy callers (scripts, tests) that don't manage the
  // job row still work.
  function processInventoryUpload(organizationId, userId, stream, filename, uploadId = null) {
    return runUploadPipeline({
      importer: inventoryImporter,
      uploadsRepo, organizationId, userId, stream, filename, uploadId,
    });
  }

  function processOrdersUpload(organizationId, userId, stream, filename, uploadId = null) {
    return runUploadPipeline({
      importer: ordersImporter,
      uploadsRepo, organizationId, userId, stream, filename, uploadId,
    });
  }

  async function getHistory(organizationId, type) {
    return uploadsRepo.getHistory(organizationId, type);
  }

  async function getReport(organizationId, uploadId) {
    return uploadsRepo.getUploadReport(organizationId, uploadId);
  }

  async function getStatus(organizationId, uploadId) {
    return uploadsRepo.getUploadStatus(organizationId, uploadId);
  }

  return { processInventoryUpload, processOrdersUpload, getHistory, getReport, getStatus };
}
