'use strict';
const express = require('express');
const router = express.Router();
const service = require('../src/services/pipelineCodingAutonomyService');
const envelope = require('../src/helpers/responseEnvelope');
function route(handler) {
  return async (req, res) => {
    try { return envelope.success(res, await handler(req)); }
    catch (error) { return envelope.error(res, error.statusCode || error.status || 500,
      error.statusCode ? error.message : 'Coding autonomy is unavailable; reconcile the original request', error.code || 'CODING_AUTONOMY_UNAVAILABLE'); }
  };
}
router.get('/coding-autonomy', route(() => service.status()));
router.post('/coding-autonomy/config', route(req => service.configure(req.body || {})));
router.post('/coding-autonomy/tasks/:id/authorization', route(req => service.authorize(req.params.id, req.body || {})));
router.post('/coding-autonomy/tasks/:id/disposition', route(async req => service.projection(
  await require('../src/services/pipelineCodingDisposition').archive(req.params.id, req.body || {}))));
router.post('/coding-autonomy/tasks/:id/review', route(req => service.recordReview(req.params.id, req.body || {})));
router.post('/coding-autonomy/tasks/:id/runs/:requestId/stop', route(req => service.stop(req.params.id, req.params.requestId, req.body || {})));
router.post('/coding-autonomy/tasks/:id/runs/:requestId/recover', route(req => service.recover(req.params.id, req.params.requestId, req.body || {})));
router.post('/coding-autonomy/tasks/:id/runs/:requestId/continuation', route(req => service.continueRecovered(req.params.id, req.params.requestId, req.body || {})));
router.get('/coding-autonomy/tasks/:id/runs/:requestId/manifest', route(req => service.workerManifest(req.params.id, req.params.requestId)));
router.post('/coding-autonomy/tasks/:id/runs/:requestId/code-step-plan', route(req =>
  service.submitCodeStepPlan(req.params.id, req.params.requestId, req.body || {})));
router.put('/coding-autonomy/tasks/:id/runs/:requestId/artifacts/:stepId',
  express.raw({ type: ['application/octet-stream', 'application/x-git-bundle'], limit: '8mb' }),
  route(req => service.storeCodeStepArtifact(req.params.id, req.params.requestId, req.params.stepId, req.body)));
router.get('/coding-autonomy/tasks/:id/runs/:requestId/artifacts/:artifactId', async (req, res) => {
  try {
    const artifact = await service.downloadCodeStepArtifact(req.params.id, req.params.requestId, req.params.artifactId);
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Length', String(artifact.bytes.length));
    res.set('X-AgentX-Artifact-Sha256', artifact.metadata.sha256);
    return res.send(artifact.bytes);
  } catch (error) {
    return envelope.error(res, error.statusCode || error.status || 500,
      error.statusCode ? error.message : 'Code-step artifact is unavailable', error.code || 'CODE_STEP_ARTIFACT_UNAVAILABLE');
  }
});
router.post('/coding-autonomy/tasks/:id/runs/:requestId/code-step-result', route(req =>
  service.settleCodeStep(req.params.id, req.params.requestId, req.body || {})));
router.post('/coding-autonomy/tasks/:id/runs/:requestId/code-step-adoption', route(req =>
  service.recordCodeStepAdoption(req.params.id, req.params.requestId, req.body || {})));
router.post('/coding-autonomy/tasks/:id/runs/:requestId/code-step-assembly', route(req =>
  service.completeCodeStepAssembly(req.params.id, req.params.requestId, req.body || {})));
// Automatic continuation of private reports (#835): switch and status.
const continuation = require('../src/services/pipelineReportContinuationService');
router.get('/report-continuation', route(() => continuation.status()));
router.post('/report-continuation/config', route(req => continuation.configureSwitch(req.body || {})));
router.post('/report-continuation/escalation', route(req => require('../src/services/pipelineReportEscalation').configure(req.body || {})));
// One-click resume of a report (#878): preview, then plan with a When choice.
const reportResume = require('../src/services/pipelineReportResume');
router.get('/tasks/:id/report-resume', route(req => reportResume.preview(req.params.id)));
router.post('/tasks/:id/report-resume', route(req => reportResume.resume(req.params.id, req.body || {})));
module.exports = router;
