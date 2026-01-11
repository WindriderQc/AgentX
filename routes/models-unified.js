/**
 * Unified Models API Routes
 *
 * Provides endpoints for unified model catalog (Ollama + n8n + custom + registry)
 */

const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const modelAggregator = require('../src/services/modelAggregator');
const N8nLLMSource = require('../models/N8nLLMSource');
const { requireAuth } = require('../src/middleware/auth');
const logger = require('../config/logger');
const { validateObjectId } = require('../src/helpers/objectIdValidator');
const { getFetchOptions } = require('../src/helpers/httpAgent');

/**
 * GET /api/models/all
 * Get all models from all sources
 * Query params: ?provider=ollama&category=coding&tag=production&search=qwen&status=available
 */
router.get('/all', async (req, res) => {
  try {
    const { provider, category, tag, search, status } = req.query;

    const models = await modelAggregator.getAllModels({
      includeOllama: true,
      includeN8n: true,
      includeCustom: true,
      includeRegistry: true,
      filters: { provider, category, tag, search, status },
      useCache: true
    });

    const sources = await modelAggregator.getModelSources();

    res.json({
      status: 'success',
      data: {
        models,
        sources,
        total: models.length,
        filters: { provider, category, tag, search, status }
      }
    });

  } catch (error) {
    logger.error('Failed to get all models', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch models',
      error: error.message
    });
  }
});

/**
 * GET /api/models/sources
 * List all model sources (Ollama hosts, n8n webhooks, custom count, registry count)
 */
router.get('/sources', async (req, res) => {
  try {
    const sources = await modelAggregator.getModelSources();

    res.json({
      status: 'success',
      data: sources
    });

  } catch (error) {
    logger.error('Failed to get model sources', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch model sources',
      error: error.message
    });
  }
});

/**
 * GET /api/models/:name/detail
 * Get unified model detail
 * Query params: ?provider=ollama (optional)
 */
router.get('/:name/detail', async (req, res) => {
  try {
    const { name } = req.params;
    const { provider } = req.query;

    const model = await modelAggregator.getModelByName(name, provider);

    if (!model) {
      return res.status(404).json({
        status: 'error',
        message: 'Model not found',
        name,
        provider
      });
    }

    res.json({
      status: 'success',
      data: model
    });

  } catch (error) {
    logger.error('Failed to get model detail', { error: error.message, name: req.params.name });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch model detail',
      error: error.message
    });
  }
});

/**
 * POST /api/models/refresh-cache
 * Force cache refresh (admin action)
 */
router.post('/refresh-cache', requireAuth, async (req, res) => {
  try {
    const result = await modelAggregator.refreshModelCache();

    logger.info('Model cache refreshed', { user: req.user?.username, result });

    res.json({
      status: 'success',
      data: result,
      message: `Found ${result.modelsFound} models across all sources`
    });

  } catch (error) {
    logger.error('Failed to refresh model cache', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to refresh cache',
      error: error.message
    });
  }
});

// ========================================
// n8n Webhook LLM Source Management
// ========================================

/**
 * POST /api/models/sources/n8n
 * Register new n8n webhook LLM (auth required)
 * Body: { name, provider, webhookUrl, authentication, capabilities, requestFormat }
 */
router.post('/sources/n8n', requireAuth, async (req, res) => {
  try {
    const {
      name,
      provider,
      webhookUrl,
      authentication,
      capabilities,
      requestFormat,
      metadata
    } = req.body;

    // Validation
    if (!name || !provider || !webhookUrl) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: name, provider, webhookUrl'
      });
    }

    // Check for duplicate name
    const existing = await N8nLLMSource.findOne({ name });
    if (existing) {
      return res.status(409).json({
        status: 'error',
        message: 'An n8n LLM source with this name already exists',
        name
      });
    }

    // Create new source
    const source = new N8nLLMSource({
      name,
      provider,
      webhookUrl,
      authentication,
      capabilities,
      requestFormat,
      metadata,
      createdBy: req.user._id
    });

    await source.save();

    // Clear cache to include new source
    modelAggregator.clearCache();

    logger.info('n8n LLM source registered', {
      name,
      provider,
      user: req.user.username
    });

    res.status(201).json({
      status: 'success',
      data: {
        id: source._id,
        name: source.name,
        provider: source.provider,
        webhookUrl: source.webhookUrl,
        isActive: source.isActive
      },
      message: `n8n LLM source "${name}" registered successfully`
    });

  } catch (error) {
    logger.error('Failed to register n8n LLM source', { error: error.message, body: req.body });
    res.status(500).json({
      status: 'error',
      message: 'Failed to register n8n LLM source',
      error: error.message
    });
  }
});

/**
 * GET /api/models/sources/n8n
 * List all n8n webhook LLM sources
 * Query params: ?activeOnly=true
 */
router.get('/sources/n8n', async (req, res) => {
  try {
    const { activeOnly } = req.query;

    const query = {};
    if (activeOnly === 'true') {
      query.isActive = true;
    }

    const sources = await N8nLLMSource.find(query).sort({ createdAt: -1 });

    res.json({
      status: 'success',
      data: sources,
      total: sources.length
    });

  } catch (error) {
    logger.error('Failed to list n8n LLM sources', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch n8n LLM sources',
      error: error.message
    });
  }
});

/**
 * GET /api/models/sources/n8n/:id
 * Get specific n8n webhook LLM source
 */
router.get('/sources/n8n/:id', async (req, res) => {
  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Source ID')) return;

    const source = await N8nLLMSource.findById(req.params.id);

    if (!source) {
      return res.status(404).json({
        status: 'error',
        message: 'n8n LLM source not found',
        id: req.params.id
      });
    }

    res.json({
      status: 'success',
      data: source
    });

  } catch (error) {
    logger.error('Failed to get n8n LLM source', { error: error.message, id: req.params.id });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch n8n LLM source',
      error: error.message
    });
  }
});

/**
 * PUT /api/models/sources/n8n/:id
 * Update n8n webhook LLM source (auth required)
 */
router.put('/sources/n8n/:id', requireAuth, async (req, res) => {
  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Source ID')) return;

    const source = await N8nLLMSource.findById(req.params.id);

    if (!source) {
      return res.status(404).json({
        status: 'error',
        message: 'n8n LLM source not found',
        id: req.params.id
      });
    }

    // Update allowed fields
    const allowedUpdates = ['webhookUrl', 'authentication', 'capabilities', 'requestFormat', 'isActive', 'metadata'];

    allowedUpdates.forEach(field => {
      if (req.body[field] !== undefined) {
        source[field] = req.body[field];
      }
    });

    await source.save();

    // Clear cache to reflect updates
    modelAggregator.clearCache();

    logger.info('n8n LLM source updated', {
      id: source._id,
      name: source.name,
      user: req.user.username
    });

    res.json({
      status: 'success',
      data: source,
      message: `n8n LLM source "${source.name}" updated successfully`
    });

  } catch (error) {
    logger.error('Failed to update n8n LLM source', { error: error.message, id: req.params.id });
    res.status(500).json({
      status: 'error',
      message: 'Failed to update n8n LLM source',
      error: error.message
    });
  }
});

/**
 * DELETE /api/models/sources/n8n/:id
 * Remove n8n webhook LLM source (auth required)
 */
router.delete('/sources/n8n/:id', requireAuth, async (req, res) => {
  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Source ID')) return;

    const source = await N8nLLMSource.findById(req.params.id);

    if (!source) {
      return res.status(404).json({
        status: 'error',
        message: 'n8n LLM source not found',
        id: req.params.id
      });
    }

    const sourceName = source.name;
    await source.deleteOne();

    // Clear cache to remove deleted source
    modelAggregator.clearCache();

    logger.info('n8n LLM source deleted', {
      id: req.params.id,
      name: sourceName,
      user: req.user.username
    });

    res.json({
      status: 'success',
      message: `n8n LLM source "${sourceName}" deleted successfully`
    });

  } catch (error) {
    logger.error('Failed to delete n8n LLM source', { error: error.message, id: req.params.id });
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete n8n LLM source',
      error: error.message
    });
  }
});

/**
 * POST /api/models/sources/n8n/:id/test
 * Test n8n LLM connection
 */
router.post('/sources/n8n/:id/test', async (req, res) => {
  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Source ID')) return;

    const source = await N8nLLMSource.findById(req.params.id);

    if (!source) {
      return res.status(404).json({
        status: 'error',
        message: 'n8n LLM source not found',
        id: req.params.id
      });
    }

    const testPrompt = req.body.prompt || 'Test connection: What is 2+2?';

    const result = await source.testConnection(testPrompt);

    logger.info('n8n LLM source tested', {
      id: source._id,
      name: source.name,
      success: result.success,
      latency: result.latencyMs
    });

    if (result.success) {
      res.json({
        status: 'success',
        data: result,
        message: `Connection successful (${result.latencyMs}ms)`
      });
    } else {
      res.status(500).json({
        status: 'error',
        data: result,
        message: `Connection failed: ${result.error}`
      });
    }

  } catch (error) {
    logger.error('Failed to test n8n LLM source', { error: error.message, id: req.params.id });
    res.status(500).json({
      status: 'error',
      message: 'Failed to test n8n LLM source',
      error: error.message
    });
  }
});

// ========================================
// Ollama Management
// ========================================

/**
 * POST /api/models/ollama/pull
 * Pull a model from Ollama library
 */
router.post('/ollama/pull', requireAuth, async (req, res) => {
  try {
    const { name, host } = req.body;
    
    if (!name) {
      return res.status(400).json({ status: 'error', message: 'Model name required' });
    }

    const targetHost = host || process.env.OLLAMA_HOST || 'http://localhost:11434';
    
    // Start pull (async)
    // Note: This endpoint triggers the pull but doesn't wait for completion in this basic version
    // A production version might stream the response.
    fetch(`${targetHost}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: false })
    }).then(async (pullRes) => {
        const data = await pullRes.json();
        if(data.error) {
           logger.error('Ollama pull failed', { error: data.error, name, host: targetHost });
        } else {
           logger.info('Ollama pull complete', { name, host: targetHost });
           modelAggregator.clearCache();
        }
    }).catch(err => {
        logger.error('Ollama pull request failed', { error: err.message });
    });

    res.json({
      status: 'success',
      message: `Pulling ${name} started. It may take a while to appear.`
    });

  } catch (error) {
    logger.error('Failed to init pull', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/models/ollama/stop
 * Unload a model from memory
 */
router.post('/ollama/stop', requireAuth, async (req, res) => {
  try {
    const { name, host } = req.body;
    if (!name) return res.status(400).json({ status: 'error', message: 'Name required' });
    
    const targetHost = host || process.env.OLLAMA_HOST || 'http://localhost:11434';

    // To unload: generate with empty prompt and keep_alive: 0
    const url = `${targetHost}/api/generate`;
    const fetchOptions = getFetchOptions(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, prompt: '', keep_alive: 0 })
    });
    const response = await fetch(url, fetchOptions);
    
    if (response.ok) {
        res.json({ status: 'success', message: `Model ${name} unloaded.` });
    } else {
        throw new Error(`Ollama API error: ${response.statusText}`);
    }
  } catch(error) {
     res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * DELETE /api/models/ollama/:name
 * Delete a model
 */
router.delete('/ollama/:name', requireAuth, async (req, res) => {
  try {
    const { name } = req.params;
    const { host } = req.query;
    
    const targetHost = host || process.env.OLLAMA_HOST || 'http://localhost:11434';
    
    const response = await fetch(`${targetHost}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });

    if(response.ok) {
        modelAggregator.clearCache();
        res.json({ status: 'success', message: `Model ${name} deleted` });
    } else {
         const err = await response.text();
         throw new Error(err);
    }
  } catch(error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

module.exports = router;
