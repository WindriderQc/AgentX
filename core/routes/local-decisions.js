'use strict';

const express = require('express');
const envelope = require('../src/helpers/responseEnvelope');
const { createLocalDecisionService } = require('../src/services/decisions/localDecisionService');

function createRouter(service = createLocalDecisionService()) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.get('/', (_req, res) => envelope.success(res, service.catalog()));
  router.post('/evaluate', express.json({ limit: '24kb' }), async (req, res) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const closed = () => { if (!res.writableEnded) cancel(); };
    req.once('aborted', cancel);
    res.once('close', closed);
    try {
      const data = await service.evaluate(req.body, { signal: controller.signal });
      if (!controller.signal.aborted) envelope.success(res, data);
    } catch (error) {
      if (!controller.signal.aborted) {
        const timedOut = error.name === 'TimeoutError';
        const code = timedOut ? 'DECISION_TIMEOUT'
          : /^[A-Z][A-Z0-9_]{0,79}$/.test(String(error.code || '')) ? error.code : 'DECISION_UNAVAILABLE';
        envelope.error(res, timedOut ? 504 : error.statusCode || 503,
          'Local decision unavailable; keep the existing workflow or request review.', code);
      }
    } finally {
      req.removeListener('aborted', cancel);
      res.removeListener('close', closed);
    }
  });
  return router;
}

module.exports = { createRouter };
