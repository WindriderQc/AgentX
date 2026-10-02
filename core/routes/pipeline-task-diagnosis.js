'use strict';

const router = require('express').Router();
const envelope = require('../src/helpers/responseEnvelope');
const { readTaskDiagnosis, readStalledTaskDiagnoses, parseLimit, MAX_LIMIT } = require('../src/services/pipelineTaskDiagnosisReadService');

// Read-only stalled-task diagnosis. These routes change nothing and grant no
// authority; any correction goes through the existing guarded task actions.
router.get('/diagnosis', async (req, res) => {
  const limit = parseLimit(req.query.limit);
  if (limit === null) return envelope.error(res, 400, `limit must be an integer from 1 to ${MAX_LIMIT}`, 'INVALID_LIMIT');
  try {
    return envelope.success(res, { diagnoses: await readStalledTaskDiagnoses({ limit }) });
  } catch {
    return envelope.error(res, 500, 'Task diagnosis unavailable', 'DIAGNOSIS_UNAVAILABLE');
  }
});

router.get('/tasks/:id/diagnosis', async (req, res) => {
  if (!/^\d{3,4}$/.test(req.params.id)) return envelope.error(res, 400, 'Invalid pipeline id', 'INVALID_PIPELINE_ID');
  try {
    const diagnosis = await readTaskDiagnosis(req.params.id);
    return diagnosis ? envelope.success(res, { diagnosis }) : envelope.error(res, 404, 'Task not found', 'NOT_FOUND');
  } catch {
    return envelope.error(res, 500, 'Task diagnosis unavailable', 'DIAGNOSIS_UNAVAILABLE');
  }
});

module.exports = router;
