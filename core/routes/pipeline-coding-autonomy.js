'use strict';
const router = require('express').Router();
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
router.post('/coding-autonomy/tasks/:id/review', route(req => service.recordReview(req.params.id, req.body || {})));
router.post('/coding-autonomy/tasks/:id/runs/:requestId/stop', route(req => service.stop(req.params.id, req.params.requestId, req.body || {})));
router.get('/coding-autonomy/tasks/:id/runs/:requestId/manifest', route(req => service.workerManifest(req.params.id, req.params.requestId)));
module.exports = router;
