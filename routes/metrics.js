const express = require('express');
const router = express.Router();
const metricsCollector = require('../src/services/metricsCollector');
const { optionalAuth } = require('../src/middleware/auth');

const METRIC_TYPES = ['health', 'performance', 'cost', 'resource', 'quality', 'usage'];

function createRecordHandler(type) {
  return async (req, res) => {
    const { componentId, value, metadata = {}, timestamp } = req.body || {};

    if (!componentId || !Number.isFinite(value)) {
      return res.status(400).json({
        status: 'error',
        message: 'componentId and numeric value are required'
      });
    }

    try {
      const meta = { ...metadata };
      if (timestamp) meta.timestamp = timestamp;

      const metric = await metricsCollector.record(type, componentId, value, meta);
      await metricsCollector.flush();

      return res.status(201).json({
        status: 'success',
        data: {
          metricId: metric._id,
          timestamp: metric.timestamp,
          type: metric.type,
          componentId: metric.componentId,
          value: metric.value,
          metadata: metric.metadata
        }
      });
    } catch (error) {
      return res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  };
}

METRIC_TYPES.forEach((type) => {
  router.post(`/${type}`, optionalAuth, createRecordHandler(type));
});

router.get('/query', optionalAuth, async (req, res) => {
  const { type, componentId, from, to, metadata } = req.query;

  let parsedMetadata = {};
  if (metadata) {
    try {
      parsedMetadata = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    } catch (err) {
      return res.status(400).json({ status: 'error', message: 'metadata must be valid JSON' });
    }
  }

  try {
    const result = await metricsCollector.query(
      { type, componentId, metadata: parsedMetadata },
      { from, to }
    );

    return res.json({
      status: 'success',
      data: {
        count: result.count,
        results: result.results
      }
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

router.get('/latest', optionalAuth, async (req, res) => {
  const { componentId, type } = req.query;

  if (!componentId) {
    return res.status(400).json({ status: 'error', message: 'componentId is required' });
  }

  try {
    const metric = await metricsCollector.getLatest(componentId, type || null);

    if (!metric) {
      return res.status(404).json({ status: 'error', message: 'No metrics found' });
    }

    return res.json({
      status: 'success',
      data: metric
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

module.exports = router;
