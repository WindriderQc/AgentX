'use strict';

const router = require('express').Router();
const { getSelfHealingStatus } = require('../src/services/selfHealingStatusService');

router.get('/self-healing', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json({ status: 'success', data: await getSelfHealingStatus() });
  } catch (_error) {
    res.status(500).json({ status: 'error', message: 'Automation evidence unavailable' });
  }
});

module.exports = router;
