'use strict';
const router = require('express').Router();
const logger = require('../config/logger');
const { describeTopology } = require('../src/services/runtimeTopologyService');

// Read-only (#360 phase 1): the declared topology modes and which one runs.
router.get('/runtime-topology', async (_req, res) => {
  try {
    res.json({ status: 'success', data: await describeTopology() });
  } catch (error) {
    logger.error('[NerveCenter] runtime topology read failed', { error: error.message });
    res.status(500).json({ status: 'error', code: 'RUNTIME_TOPOLOGY_READ_FAILED', message: 'Runtime topology unavailable' });
  }
});

module.exports = router;
