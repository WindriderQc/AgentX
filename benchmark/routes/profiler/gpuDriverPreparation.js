'use strict';

const router = require('express').Router();
const preparation = require('../../src/services/profiler/gpuDriverPreparationService');
const evidence = require('../../src/services/profiler/gpuDriverPreparedEvidenceService');
const activation = require('../../src/services/profiler/gpuDriverActivationService');
const { abandon } = require('../../src/services/profiler/gpuDriverPreparationAbandon');
const hostProfiles = require('../../src/services/profiler/hostProfileService');
const { assertQualificationAuthority } = require('../../src/services/profiler/gpuDriverQualificationAuthority');

const handle = operation => async (req, res) => {
  try { return res.json({ status: 'success', data: await operation(req) }); }
  catch (error) { return res.status(error.statusCode || error.status || 503).json({ status: 'error', code: error.code, error: error.message }); }
};

router.get('/:hostId', handle(req => preparation.inspect(req.params.hostId)));
router.post('/:hostId/activate', handle(req => activation.activate({ hostId: req.params.hostId,
  requestId: req.body?.requestId, preparationId: req.body?.preparationId })));
router.post('/:hostId/abandon', handle(req => abandon({ hostId: req.params.hostId,
  requestId: req.body?.requestId, preparationId: req.body?.preparationId })));
router.post('/:hostId/prepare', handle(req => preparation.prepare({ hostId: req.params.hostId,
  requestId: req.body?.requestId, expectedFingerprint: req.body?.expectedFingerprint })));
router.get('/:hostId/prepared/:requestId', handle(async req => {
  const result = await evidence.inspectPrepared(req.params.hostId, req.params.requestId);
  return { hostId: result.hostId, requestId: result.requestId, ready: result.ready,
    models: result.models.map(model => ({ modelName: model.modelName, ready: model.ready, reasons: model.reasons })) };
}));
router.post('/:hostId/qualification-evidence', handle(async req => {
  const host = await hostProfiles.getById(req.params.hostId);
  if (!host) throw Object.assign(new Error('Host not found'), { statusCode: 404 });
  await assertQualificationAuthority(host.hostUrl, req.body?.authority);
  const result = await evidence.qualificationEvidence(host.hostId, req.body?.requestId, req.body?.modelName);
  return { hostProfile: result.hostProfile, modelProfile: result.modelProfile,
    contextProfile: result.contextProfile, toolQualification: result.toolQualification,
    servingContext: result.servingContext, driverPreparationId: result.driverPreparationId };
}));

module.exports = router;
