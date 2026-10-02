'use strict';

const router = require('express').Router();
const envelope = require('../src/helpers/responseEnvelope');
const { readTaskEligibility } = require('../src/services/pipelineEligibilityReadService');
const { readAttention } = require('../src/services/pipelineAttentionService');

// Paginated attention queue for one lane scope. Read-only: no slot, claim or attempt.
// GET /api/pipeline/attention?scope=engineering|private&offset=&limit=&service=&lane=&status=&epic=&search=
router.get('/attention', async (req, res) => {
  try {
    return envelope.success(res, { attention: await readAttention(req.query) });
  } catch (error) {
    return error.status === 400 ? envelope.error(res, 400, error.message, error.code)
      : envelope.error(res, 500, 'Attention observation unavailable', 'ATTENTION_UNAVAILABLE');
  }
});

router.get('/tasks/:id/eligibility', async (req, res) => {
  if (!/^\d{3,4}$/.test(req.params.id)) return envelope.error(res, 400, 'Invalid pipeline id', 'INVALID_PIPELINE_ID');
  try {
    const automated = ['1', 'true', 'yes', 'on', 'review_only'].includes(String(req.query.automation || '').toLowerCase());
    const eligibility = await readTaskEligibility(req.params.id, { automated });
    return eligibility ? envelope.success(res, { eligibility })
      : envelope.error(res, 404, 'Task unavailable', 'NOT_FOUND');
  } catch (error) {
    return envelope.error(res, 500, 'Eligibility observation unavailable', 'ELIGIBILITY_UNAVAILABLE');
  }
});

router.use(require('./pipeline-task-diagnosis'));

module.exports = router;
