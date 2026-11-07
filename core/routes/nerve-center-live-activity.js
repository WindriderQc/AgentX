'use strict';

/**
 * GET /api/nerve-center/live-activity?minutes=15
 *
 * Read-only feed for the Nerve Center live charts: requests running through
 * Core now (heavy work counted, not listed), completed requests per minute and
 * per caller, and each GPU's recent power draw from the gpu-agent samples.
 */

const express = require('express');
const logger = require('../config/logger');
const { getLiveActivity } = require('../src/services/liveActivityService');

const router = express.Router();

router.get('/live-activity', async (req, res) => {
  try {
    const data = await getLiveActivity({ minutes: req.query.minutes });
    for (const part of ['requests', 'recent', 'power']) {
      if (!data[part].ok) logger.warn('[NerveCenter] live-activity part unavailable', { part, error: data[part].error });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ status: 'success', data });
  } catch (error) {
    logger.warn('[NerveCenter] live-activity failed', { error: error.message });
    return res.status(500).json({ status: 'error', message: 'Live activity unavailable' });
  }
});

module.exports = router;
