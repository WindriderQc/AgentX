'use strict';
const router = require('express').Router();
const envelope = require('../src/helpers/responseEnvelope');
const service = require('../src/services/pipelineWorkReferences');
function route(handler) {
  return async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { return envelope.success(res, await handler(req)); }
    catch (error) { return envelope.error(res, error.status || error.statusCode || 500,
      error.status || error.statusCode ? error.message : 'The work relationship operation is unavailable. Retain its request identity.', error.code || 'WORK_REFERENCE_UNAVAILABLE'); }
  };
}
router.get('/work-references', route(req => {
  const { limit, ...ref } = req.query;
  if (ref.number !== undefined) ref.number = Number(ref.number);
  return service.lookup(ref, limit === undefined ? 20 : Number(limit));
}));
router.get('/tasks/:id/relationships', route(req => service.read(req.params.id, {
  limit: req.query.limit === undefined ? 10 : Number(req.query.limit), offset: req.query.offset === undefined ? 0 : Number(req.query.offset) })));
router.post('/tasks/:id/relationships', route(req => service.decide(req.params.id, req.body)));
router.post('/report-intake', route(req => require('../src/services/pipelineWorkAdmission').admit(req.body)));
module.exports = router;
