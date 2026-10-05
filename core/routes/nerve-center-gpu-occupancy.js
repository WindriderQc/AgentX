'use strict';

/**
 * GET /api/nerve-center/inference/gpu-occupancy?window=1h|6h|24h|7d|30d&busyAtPct=
 *
 * GPU occupancy per physical GPU over a window (#365): busy share, utilization,
 * VRAM, power and throttled time, each with its sample count and coverage,
 * joined to the configured Ollama hosts and the physical resource map.
 */

const express = require('express');
const logger = require('../config/logger');
const { getConfiguredHosts } = require('../src/helpers/ollamaHostConfig');
const { getGpuOccupancy } = require('../src/services/gpuOccupancyService');

const router = express.Router();

router.get('/inference/gpu-occupancy', async (req, res) => {
  const result = await getGpuOccupancy({
    window: req.query.window, busyAtPct: req.query.busyAtPct, configuredHosts: getConfiguredHosts(),
  });
  if (!result.ok) {
    logger.warn('[NerveCenter] gpu-occupancy unavailable', { error: result.error });
    return res.status(result.status).json({ status: 'error', message: result.error });
  }
  return res.json({ status: 'success', data: result.data });
});

module.exports = router;
