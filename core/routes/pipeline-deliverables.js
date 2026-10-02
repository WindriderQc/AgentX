'use strict';

// Task deliverables: files a pipeline task produced, served only inside that
// task's scope. Gateway traffic reaches /api/pipeline only with an adult
// session (parentalAccess); the family entry never lists these paths.
const router = require('express').Router();
const envelope = require('../src/helpers/responseEnvelope');
const logger = require('../config/logger');
const deliverables = require('../src/services/pipelineTaskDeliverableService');

const ID_RE = /^[0-9A-Za-z_-]{1,16}$/;
function sendError(res, error) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) {
    logger.error('[pipeline-deliverables] request failed', { error: error.message });
    return envelope.error(res, 500, 'Deliverable registry unavailable', 'DELIVERABLE_REGISTRY_UNAVAILABLE');
  }
  if (error.details) {
    return res.status(status).json({ ok: false, status: 'error', error: error.message, message: error.message, code: error.code, details: error.details });
  }
  return envelope.error(res, status, error.message, error.code);
}
function validId(req, res, next) {
  if (!ID_RE.test(req.params.id)) return envelope.error(res, 400, 'Invalid pipeline id', 'INVALID_PIPELINE_ID');
  res.set('Cache-Control', 'private, no-store');
  return next();
}

router.get('/tasks/:id/deliverables', validId, async (req, res) => {
  try {
    const rows = await deliverables.list(req.params.id);
    return envelope.success(res, {
      deliverables: rows,
      limits: { maxBytes: deliverables.MAX_BYTES, maxPerTask: deliverables.MAX_PER_TASK },
    });
  } catch (error) { return sendError(res, error); }
});

router.post('/tasks/:id/deliverables', validId, async (req, res) => {
  try {
    const { created, receipt } = await deliverables.register(req.params.id, req.body || {});
    if (created) {
      logger.info('[pipeline-deliverables] stored', { ref: receipt.ref, sha256: receipt.sha256, size: receipt.size, channel: receipt.producer.channel });
    }
    return envelope.success(res, { created, receipt }, undefined, created ? 201 : 200);
  } catch (error) { return sendError(res, error); }
});

// Re-reads the stored bytes and recomputes the digest.
router.get('/tasks/:id/deliverables/:deliverableId', validId, async (req, res) => {
  try {
    return envelope.success(res, { receipt: await deliverables.verify(req.params.id, req.params.deliverableId) });
  } catch (error) { return sendError(res, error); }
});

router.get('/tasks/:id/deliverables/:deliverableId/download', validId, async (req, res) => {
  try {
    const { receipt, data } = await deliverables.download(req.params.id, req.params.deliverableId);
    res.attachment(receipt.name);
    res.set({
      'Content-Type': receipt.mimeType,
      'Content-Length': String(data.length),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-AgentX-Deliverable-Sha256': receipt.sha256,
    });
    return res.status(200).end(data);
  } catch (error) { return sendError(res, error); }
});

module.exports = router;
