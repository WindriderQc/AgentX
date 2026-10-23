'use strict';

// Task deliverables: files a pipeline task produced, served only inside that
// task's scope. Human management uses the private LAN; native workers keep
// their bounded task scope. A selected page does not establish human identity.
const router = require('express').Router();
const envelope = require('../src/helpers/responseEnvelope');
const logger = require('../config/logger');
const deliverables = require('../src/services/pipelineTaskDeliverableService');
const reports = require('../src/services/pipelineReportService');

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

router.post('/tasks/:id/reports/:requestId/start', validId, async (req, res) => {
  try { return envelope.success(res, await reports.start(req.params.id, req.params.requestId, req.body || {})); }
  catch (error) {
    try {
      const receipt = await require('../src/services/pipelineReportPreflight').receive(req.params.id, req.params.requestId, req.body || {}, error);
      if (receipt) return res.status(error.statusCode || 409).json({ ok: false, status: 'error', code: error.code, message: error.message,
        data: { reportRefusalReceived: true, requestId: receipt.requestId, pipelineId: receipt.pipelineId, claimSeq: receipt.claimSeq } });
    } catch (settlement) { return sendError(res, settlement); }
    return sendError(res, error);
  }
});
router.post('/tasks/:id/reports/:requestId/archive-checkpoint', validId, async (req, res) => {
  try { return envelope.success(res, await require('../src/services/pipelineReportCheckpointArchive').archive(req.params.id, req.params.requestId, req.body || {})); }
  catch (error) { return sendError(res, error); }
});
// Explicit operator custody for calls predating native admission binding. The
// private-LAN caller header is attribution, not an authentication mechanism.
router.post('/tasks/:id/reports/:requestId/map-native-termination', validId, async (req, res) => {
  if (req.get('x-agentx-caller') !== 'operator' || req.get('x-agentx-report-request'))
    return envelope.error(res, 403, 'Explicit operator recovery is required', 'REPORT_OPERATOR_REQUIRED');
  try { return envelope.success(res, await require('../src/services/pipelineReportModelRecovery').mapLegacy(req.params.id, req.params.requestId, req.body || {})); }
  catch (error) { return sendError(res, error); }
});
router.post('/tasks/:id/reports/:requestId/receive-cloud-refusal', validId, async (req, res) => {
  if (req.get('x-agentx-caller') !== 'operator' || req.get('x-agentx-report-request'))
    return envelope.error(res, 403, 'Explicit operator recovery is required', 'REPORT_OPERATOR_REQUIRED');
  try {
    const control = { status: input => require('../src/services/pipelineReportModelRecovery').nativeStatus(input) };
    const receiver = require('../src/services/pipelineReportCloudRecovery').createRecovery({ control });
    return envelope.success(res, await receiver.receive(req.params.id, req.params.requestId, req.body || {}));
  } catch (error) { return sendError(res, error); }
});
router.post('/tasks/:id/reports/:requestId/preflight-result', validId, async (req, res) => {
  try {
    const receipt = await require('../src/services/pipelineReportPreflight').receive(req.params.id, req.params.requestId, req.body || {},
      { code: 'REPORT_PREFLIGHT_FAILED', message: 'Native preparation failed before model dispatch' });
    if (!receipt) throw Object.assign(new Error('Preparation refusal remains unverified'), { statusCode: 409, code: 'REPORT_PREFLIGHT_UNVERIFIED' });
    return envelope.success(res, { reportRefusalReceived: true, requestId: receipt.requestId, pipelineId: receipt.pipelineId, claimSeq: receipt.claimSeq });
  } catch (error) { return sendError(res, error); }
});
router.get('/tasks/:id/reports/:requestId', validId, async (req, res) => {
  try { return envelope.success(res, await reports.status(req.params.id, req.params.requestId)); }
  catch (error) { return sendError(res, error); }
});
router.get('/tasks/:id/reports/:requestId/checkpoint', validId, async (req, res) => {
  try { return envelope.success(res, await reports.checkpoint(req.params.id, req.params.requestId)); }
  catch (error) { return sendError(res, error); }
});
router.post('/tasks/:id/reports/:requestId/result', validId, async (req, res) => {
  try { return envelope.success(res, await reports.submit(req.params.id, req.params.requestId, req.body || {})); }
  catch (error) { return sendError(res, error); }
});
router.post('/tasks/:id/reports/:requestId/stop-result', validId, async (req, res) => {
  try { return envelope.success(res, await reports.stop(req.params.id, req.params.requestId, req.body || {})); }
  catch (error) { return sendError(res, error); }
});
router.post('/tasks/:id/reports/:requestId/reconcile-models', validId, async (req, res) => {
  try { return envelope.success(res, await reports.reconcileModels(req.params.id, req.params.requestId)); }
  catch (error) { return sendError(res, error); }
});
router.post('/tasks/:id/reports/:requestId/heartbeat', validId, async (req, res) => {
  try { return envelope.success(res, await reports.heartbeat(req.params.id, req.params.requestId)); }
  catch (error) { return sendError(res, error); }
});

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
