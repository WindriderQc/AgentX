'use strict';
const router = require('express').Router();
const fit = require('../../src/services/profiler/pinnedContextFitService');

function route(action) {
  return async (req, res) => {
    try { res.json({ status: 'success', data: await action(req) }); }
    catch (error) { res.status(error.statusCode || 500).json({ status: 'error', code: error.code || 'PINNED_FIT_FAILED', error: error.message }); }
  };
}
function only(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) {
    throw Object.assign(new Error('Unsupported fit request fields'), { statusCode: 400 });
  }
}
router.post('/request', route(req => {
  only(req.body, ['requestId', 'hostId', 'pinIndex']);
  return fit.request(req.body);
}));
router.post('/start', route(req => {
  only(req.body, ['mode', 'fitCheckId', 'hostId', 'queueRequestId', 'queueDispatchId']);
  return fit.start(req.body);
}));
router.get('/:id', route(req => fit.get(req.params.id)));
router.post('/:id/cancel', route(req => fit.cancel(req.params.id)));
router.post('/:id/reconcile', route(req => {
  only(req.body, ['nativeIdentity']);
  const identity = req.body.nativeIdentity || null;
  if (identity) {
    only(identity, ['admissionId', 'generation', 'principal', 'recoveryId']);
    if (Object.values(identity).some(value => typeof value !== 'string' || value.length < 1 || value.length > 200)
      || Object.keys(identity).length !== 4) throw Object.assign(new Error('Exact native release identity required'), { statusCode: 400 });
  }
  return fit.reconcile(req.params.id, identity);
}));
module.exports = router;
