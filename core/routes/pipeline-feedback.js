'use strict';
const express = require('express');
const router = express.Router();
const envelope = require('../src/helpers/responseEnvelope');
const { recordFeedback } = require('../src/services/pipelineFeedback');

router.post('/tasks/:id/feedback', async (req, res) => {
  const result = await recordFeedback(req.params.id, req.body);
  if (result.error) return envelope.error(res, result.status, result.error.message, result.error.code);
  return envelope.success(res, result.data);
});

module.exports = router;
