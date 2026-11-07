'use strict';

/**
 * GET /api/nerve-center/live-activity?minutes=15
 *
 * Read-only feed for the Nerve Center live charts: requests running through
 * Core now (heavy work counted, not listed), completed requests per minute and
 * per caller, and each GPU's recent power draw from the gpu-agent samples.
 *
 * GET /api/nerve-center/live-activity/minute?at=<ISO time>
 *
 * The requests completed in that minute (last 24 hours, at most 60): caller,
 * machine, model, duration, status and a stable failure reason. Never the
 * error text.
 */

const express = require('express');
const logger = require('../config/logger');
const { getLiveActivity, readMinuteRequests } = require('../src/services/liveActivityService');

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

router.get('/live-activity/minute', async (req, res) => {
  try {
    const data = await readMinuteRequests({ at: req.query.at });
    res.set('Cache-Control', 'no-store');
    return res.json({ status: 'success', data });
  } catch (error) {
    if (error.statusCode === 400) return res.status(400).json({ status: 'error', message: error.message });
    logger.warn('[NerveCenter] live-activity minute failed', { error: error.message });
    return res.status(500).json({ status: 'error', message: 'Requests of that minute unavailable' });
  }
});

module.exports = router;
