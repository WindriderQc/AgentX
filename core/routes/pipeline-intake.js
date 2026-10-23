'use strict';
const router = require('express').Router();
const envelope = require('../src/helpers/responseEnvelope');
const { redactTaskLeaseIds } = require('../src/services/pipelineTaskProjectionReadService');
router.post('/tasks/:id/intake', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    const result = await require('../src/services/taskIntakeService').decide(req.params.id, req.body);
    return envelope.success(res, { ...result, task: redactTaskLeaseIds(result.task) });
  } catch (error) { return envelope.error(res, error.status || 500, error.message, error.code); }
});
module.exports = router;
