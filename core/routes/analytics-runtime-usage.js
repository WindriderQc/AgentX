'use strict';

const router = require('express').Router();
const { ingestRuntimeUsage, readRuntimeUsage } = require('../src/services/runtimeUsageService');

router.post('/runtime-usage', async (req, res) => {
  try { res.json({ status: 'success', result: await ingestRuntimeUsage(req.body) }); }
  catch (error) {
    res.status(error.statusCode || 503).json({ status: 'error', code: error.code || 'RUNTIME_USAGE_UNAVAILABLE' });
  }
});
router.get('/runtime-usage/:receiptId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ status: 'success', result: await readRuntimeUsage(req.params.receiptId) }); }
  catch (error) { res.status(error.statusCode || 503).json({ status: 'error', code: error.code || 'RUNTIME_USAGE_UNAVAILABLE' }); }
});
module.exports = router;
