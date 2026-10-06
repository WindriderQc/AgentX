'use strict';

// Household priority over evaluation workloads (#62). The workload owner calls
// this before each prompt with its exact admission proof and the number of its
// own requests still in flight. `yield: true` means wait and call again after
// retryAfterMs; `yielded` says whether Core now admits shared household
// inference on the workload's hosts. The call renews the admission TTL while
// the owner waits.

const express = require('express');
const { requestPrincipal } = require('../src/helpers/requestCaller');
const interactivePriority = require('../src/services/interactivePriorityService');

const router = express.Router();

router.post('/workload-admissions/:admissionId/yield-point', async (req, res) => {
  const inFlight = Number(req.body?.inFlight ?? 0);
  if (!Number.isInteger(inFlight) || inFlight < 0) {
    return res.status(400).json({ status: 'error', code: 'YIELD_POINT_INVALID', message: 'inFlight must be a non-negative integer' });
  }
  try {
    const result = await interactivePriority.yieldPoint({
      admissionId: req.params.admissionId,
      generation: req.body?.generation,
      principal: requestPrincipal(req),
      inFlight,
      ttl: req.body?.ttlMs
    });
    const status = result.reason ? 409 : 200;
    return res.status(status).json({ status: status === 200 ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'YIELD_POINT_FAILED', message: error.message });
  }
});

// Read by work that only starts when the household is quiet.
router.get('/interactive-priority/status', (_req, res) => res.json({ status: 'success', data: interactivePriority.householdIdle() }));

module.exports = router;
