/**
 * Config Variant Routes
 * Provides API endpoints for accessing config presets for benchmarking
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger');
const ConfigVariant = require('../models/ConfigVariant');

/**
 * GET /api/config-variants/test-scenarios/list
 * Get predefined test scenarios for config testing
 * NOTE: This route must come BEFORE /:id route to avoid being caught by it
 */
router.get('/test-scenarios/list', async (req, res) => {
  try {
    const scenariosPath = path.join(__dirname, '..', 'data', 'config-test-scenarios.json');

    if (!fs.existsSync(scenariosPath)) {
      return res.status(404).json({
        status: 'error',
        message: 'Test scenarios file not found'
      });
    }

    const scenariosData = fs.readFileSync(scenariosPath, 'utf8');
    const scenarios = JSON.parse(scenariosData);

    res.json({
      status: 'success',
      data: scenarios
    });
  } catch (err) {
    logger.error('Failed to fetch test scenarios', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/config-variants
 * Get all config variants for testing and comparison
 */
router.get('/', async (req, res) => {
  try {
    const variants = await ConfigVariant.find()
      .sort({ isSystem: -1, name: 1 }); // System configs first, then alphabetically

    res.json({
      status: 'success',
      data: {
        variants,
        count: variants.length
      }
    });
  } catch (err) {
    logger.error('Failed to fetch config variants', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

/**
 * GET /api/config-variants/:id
 * Get a specific config variant by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const variant = await ConfigVariant.findById(req.params.id);

    if (!variant) {
      return res.status(404).json({
        status: 'error',
        message: 'Config variant not found'
      });
    }

    res.json({
      status: 'success',
      data: { variant }
    });
  } catch (err) {
    logger.error('Failed to fetch config variant', { error: err.message, id: req.params.id });
    res.status(500).json({
      status: 'error',
      message: err.message
    });
  }
});

module.exports = router;
