/**
 * Model Registry Routes
 *
 * API endpoints for model metadata, capabilities, and categorization.
 * Enables intelligent routing, benchmark filtering, and capability-based selection.
 *
 * Endpoints:
 *   GET    /api/models/registry              - List all active models
 *   GET    /api/models/registry/:name        - Get specific model details
 *   POST   /api/models/registry              - Create/register new model
 *   PATCH  /api/models/registry/:name        - Update model metadata
 *   DELETE /api/models/registry/:name        - Retire model
 *   GET    /api/models/registry/category/:cat - Get models by category
 *   GET    /api/models/registry/tag/:tag     - Get models by tag
 *   GET    /api/models/registry/stats        - Get category statistics
 *   POST   /api/models/registry/:name/sync   - Sync benchmark stats
 *
 * @see /models/ModelRegistry.js
 * @see /docs/planning/BENCHMARK_ENHANCEMENT_PLAN.md
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const ModelRegistry = require('../models/ModelRegistry');
const { requireAuth } = require('../src/middleware/auth');

/**
 * GET /api/models/registry
 *
 * List all active models with optional filtering
 *
 * Query params:
 *   - category: Filter by category
 *   - tag: Filter by tag
 *   - vendor: Filter by vendor
 *   - status: Filter by status (default: active)
 *
 * Returns: Array of model objects
 */
router.get('/', async (req, res) => {
  try {
    const { category, tag, vendor, status } = req.query;

    let query = { isActive: true };

    if (category) {
      query.categories = category;
    }
    if (tag) {
      query.tags = tag;
    }
    if (vendor) {
      query.vendor = vendor;
    }
    if (status) {
      query.status = status;
    }

    const models = await ModelRegistry.find(query)
      .sort({ displayName: 1 })
      .lean();

    logger.info('Retrieved models from registry', {
      count: models.length,
      filters: { category, tag, vendor, status }
    });

    res.json({
      status: 'success',
      data: {
        models,
        count: models.length
      }
    });
  } catch (err) {
    logger.error('Failed to retrieve models from registry', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve models',
      error: err.message
    });
  }
});

/**
 * GET /api/models/registry/stats
 *
 * Get category statistics and distribution
 *
 * Returns: Category stats object
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await ModelRegistry.getCategoryStats();

    logger.info('Retrieved category statistics');

    res.json({
      status: 'success',
      data: stats
    });
  } catch (err) {
    logger.error('Failed to retrieve category stats', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve category stats',
      error: err.message
    });
  }
});

/**
 * GET /api/models/registry/grouped
 *
 * Get models grouped by category
 *
 * Returns: Object with category keys and model arrays
 */
router.get('/grouped', async (req, res) => {
  try {
    const grouped = await ModelRegistry.getGroupedByCategory();

    logger.info('Retrieved models grouped by category');

    res.json({
      status: 'success',
      data: grouped
    });
  } catch (err) {
    logger.error('Failed to retrieve grouped models', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve grouped models',
      error: err.message
    });
  }
});

/**
 * GET /api/models/registry/category/:category
 *
 * Get all models in a specific category
 *
 * Returns: Array of models
 */
router.get('/category/:category', async (req, res) => {
  try {
    const { category } = req.params;

    const models = await ModelRegistry.findByCategory(category);

    logger.info(`Retrieved models for category: ${category}`, { count: models.length });

    res.json({
      status: 'success',
      data: {
        category,
        models,
        count: models.length
      }
    });
  } catch (err) {
    logger.error(`Failed to retrieve models for category: ${req.params.category}`, {
      error: err.message
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve models for category',
      error: err.message
    });
  }
});

/**
 * GET /api/models/registry/tag/:tag
 *
 * Get all models with a specific tag
 *
 * Returns: Array of models
 */
router.get('/tag/:tag', async (req, res) => {
  try {
    const { tag } = req.params;

    const models = await ModelRegistry.findByTag(tag);

    logger.info(`Retrieved models for tag: ${tag}`, { count: models.length });

    res.json({
      status: 'success',
      data: {
        tag,
        models,
        count: models.length
      }
    });
  } catch (err) {
    logger.error(`Failed to retrieve models for tag: ${req.params.tag}`, {
      error: err.message
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve models for tag',
      error: err.message
    });
  }
});

/**
 * GET /api/models/registry/:name
 *
 * Get specific model details
 *
 * Returns: Model object
 */
router.get('/:name', async (req, res) => {
  try {
    const { name } = req.params;

    const model = await ModelRegistry.findOne({ modelName: name }).lean();

    if (!model) {
      return res.status(404).json({
        status: 'error',
        message: `Model not found: ${name}`
      });
    }

    logger.info(`Retrieved model details: ${name}`);

    res.json({
      status: 'success',
      data: model
    });
  } catch (err) {
    logger.error(`Failed to retrieve model: ${req.params.name}`, { error: err.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve model',
      error: err.message
    });
  }
});

/**
 * POST /api/models/registry
 *
 * Create/register a new model
 *
 * Body: Model object (see ModelRegistry schema)
 *
 * Returns: Created model object
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const modelData = req.body;

    // Check if model already exists
    const existing = await ModelRegistry.findOne({ modelName: modelData.modelName });
    if (existing) {
      return res.status(409).json({
        status: 'error',
        message: `Model already exists: ${modelData.modelName}`
      });
    }

    const model = await ModelRegistry.create(modelData);

    logger.info(`Created new model in registry: ${model.modelName}`, {
      categories: model.categories,
      tags: model.tags
    });

    res.status(201).json({
      status: 'success',
      data: model
    });
  } catch (err) {
    logger.error('Failed to create model in registry', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to create model',
      error: err.message
    });
  }
});

/**
 * PATCH /api/models/registry/:name
 *
 * Update model metadata
 *
 * Body: Partial model object with fields to update
 *
 * Returns: Updated model object
 */
router.patch('/:name', requireAuth, async (req, res) => {
  try {
    const { name } = req.params;
    const updates = req.body;

    // Prevent updating modelName directly
    delete updates.modelName;

    updates.lastUpdated = new Date();

    const model = await ModelRegistry.findOneAndUpdate(
      { modelName: name },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!model) {
      return res.status(404).json({
        status: 'error',
        message: `Model not found: ${name}`
      });
    }

    logger.info(`Updated model in registry: ${name}`, { updates: Object.keys(updates) });

    res.json({
      status: 'success',
      data: model
    });
  } catch (err) {
    logger.error(`Failed to update model: ${req.params.name}`, { error: err.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to update model',
      error: err.message
    });
  }
});

/**
 * DELETE /api/models/registry/:name
 *
 * Retire a model (soft delete)
 *
 * Query params:
 *   - reason: Reason for retirement
 *
 * Returns: Retired model object
 */
router.delete('/:name', requireAuth, async (req, res) => {
  try {
    const { name } = req.params;
    const { reason = 'No reason provided' } = req.query;

    const model = await ModelRegistry.findOne({ modelName: name });

    if (!model) {
      return res.status(404).json({
        status: 'error',
        message: `Model not found: ${name}`
      });
    }

    await model.retire(reason);

    logger.info(`Retired model: ${name}`, { reason });

    res.json({
      status: 'success',
      message: `Model retired: ${name}`,
      data: model
    });
  } catch (err) {
    logger.error(`Failed to retire model: ${req.params.name}`, { error: err.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retire model',
      error: err.message
    });
  }
});

/**
 * POST /api/models/registry/:name/sync
 *
 * Sync benchmark statistics for a model
 *
 * Fetches latest benchmark results and updates model stats
 *
 * Returns: Updated model object
 */
router.post('/:name/sync', async (req, res) => {
  try {
    const { name } = req.params;

    const model = await ModelRegistry.syncBenchmarkStats(name);

    if (!model) {
      return res.status(404).json({
        status: 'error',
        message: `Model not found or no benchmark data available: ${name}`
      });
    }

    logger.info(`Synced benchmark stats for model: ${name}`, {
      avgComposite: model.benchmarkStats.avgCompositeScore,
      totalTests: model.benchmarkStats.totalTests
    });

    res.json({
      status: 'success',
      message: 'Benchmark stats synced successfully',
      data: model
    });
  } catch (err) {
    logger.error(`Failed to sync benchmark stats: ${req.params.name}`, {
      error: err.message
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to sync benchmark stats',
      error: err.message
    });
  }
});

/**
 * POST /api/models/registry/:name/categories
 *
 * Add category to a model
 *
 * Body: { category: 'coding' }
 *
 * Returns: Updated model object
 */
router.post('/:name/categories', requireAuth, async (req, res) => {
  try {
    const { name } = req.params;
    const { category } = req.body;

    if (!category) {
      return res.status(400).json({
        status: 'error',
        message: 'Category is required'
      });
    }

    const model = await ModelRegistry.findOne({ modelName: name });

    if (!model) {
      return res.status(404).json({
        status: 'error',
        message: `Model not found: ${name}`
      });
    }

    await model.addCategory(category);

    logger.info(`Added category to model: ${name}`, { category });

    res.json({
      status: 'success',
      message: `Category added: ${category}`,
      data: model
    });
  } catch (err) {
    logger.error(`Failed to add category to model: ${req.params.name}`, {
      error: err.message
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to add category',
      error: err.message
    });
  }
});

/**
 * DELETE /api/models/registry/:name/categories/:category
 *
 * Remove category from a model
 *
 * Returns: Updated model object
 */
router.delete('/:name/categories/:category', requireAuth, async (req, res) => {
  try {
    const { name, category } = req.params;

    const model = await ModelRegistry.findOne({ modelName: name });

    if (!model) {
      return res.status(404).json({
        status: 'error',
        message: `Model not found: ${name}`
      });
    }

    await model.removeCategory(category);

    logger.info(`Removed category from model: ${name}`, { category });

    res.json({
      status: 'success',
      message: `Category removed: ${category}`,
      data: model
    });
  } catch (err) {
    logger.error(`Failed to remove category from model: ${req.params.name}`, {
      error: err.message
    });
    res.status(500).json({
      status: 'error',
      message: 'Failed to remove category',
      error: err.message
    });
  }
});

module.exports = router;
