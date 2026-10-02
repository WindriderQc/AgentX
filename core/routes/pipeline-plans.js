'use strict';

const router = require('express').Router();
const envelope = require('../src/helpers/responseEnvelope');
const plans = require('../src/services/pipelineTaskPlanService');

// Versioned task plans (agentx.pipeline-task-plan/v1). Reading, recording or
// deciding on a plan never starts work: launch keeps its own explicit path.
function send(res, work, statusCode = 200) {
  return work.then(
    (data) => envelope.success(res, data, null, statusCode),
    (error) => envelope.error(res, error.status || 500, error.status ? error.message : 'Plan operation failed', error.code || 'PLAN_ERROR'),
  );
}

router.get('/tasks/:id/plan', (req, res) => send(res, plans.readPlan(req.params.id)));
router.post('/tasks/:id/plan', (req, res) => send(res, plans.submitPlan(req.params.id, req.body), 201));
router.post('/tasks/:id/plan/decision', (req, res) => send(res, plans.decidePlan(req.params.id, req.body)));

module.exports = router;
