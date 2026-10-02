'use strict';

const express = require('express');
const HostPreference = require('../models/HostPreference');
const { projectHostPreferenceForRead } = require('../src/services/hostPreferencePublicProjection');

module.exports = function hostConcurrencyRouter(resolveHostPreferenceUrl) {
  const router = express.Router();

  // Records an operator's observation, never changes the Ollama process or
  // inference admission. Ollama's HTTP API does not expose NUM_PARALLEL.
  router.put('/host-preferences/:hostUrl(*)/ollama-concurrency', async (req, res) => {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const { numParallel, observedAt, source } = req.body || {};
    const timestamp = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
    if (!Number.isSafeInteger(numParallel) || numParallel < 1
      || !Number.isFinite(timestamp) || timestamp > Date.now() + 30_000
      || !['process-environment', 'startup-log'].includes(source)) {
      return res.status(400).json({ status: 'error', message:
        'Require positive integer numParallel, observedAt date, and process-environment or startup-log source' });
    }
    try {
      const pref = await HostPreference.findOneAndUpdate({ hostUrl }, {
        $set: { ollamaConcurrency: { numParallel, observedAt: new Date(timestamp), source } }
      }, { new: true, runValidators: true }).lean();
      if (!pref) return res.status(404).json({ status: 'error', message: 'Host preference not found' });
      return res.json({ status: 'success', data: projectHostPreferenceForRead(pref) });
    } catch (error) {
      return res.status(500).json({ status: 'error', code: 'OLLAMA_CONCURRENCY_RECORD_FAILED', message: error.message });
    }
  });
  return router;
};
