/**
 * Model Aggregator Service
 *
 * Aggregates models from multiple sources into unified catalog:
 * 1. Live Ollama models (from primary/secondary hosts)
 * 2. Custom models (from CustomModel DB)
 * 3. n8n webhook LLMs (from N8nLLMSource DB)
 * 4. Model Registry metadata (from ModelRegistry DB)
 *
 * Provides single source of truth for "what models can I use right now?"
 */

const CustomModel = require('../../models/CustomModel');
const ModelRegistry = require('../../models/ModelRegistry');
const N8nLLMSource = require('../../models/N8nLLMSource');
const BenchmarkResult = require('../../models/BenchmarkResult');
const logger = require('../../config/logger');

// Cache for aggregated models (5 min TTL)
let modelCache = null;
let cacheTimestamp = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get all models from all sources
 * @param {Object} options - Filter options
 * @param {Boolean} options.includeOllama - Include Ollama models (default: true)
 * @param {Boolean} options.includeN8n - Include n8n webhook LLMs (default: true)
 * @param {Boolean} options.includeCustom - Include custom models (default: true)
 * @param {Boolean} options.includeRegistry - Include registry metadata (default: true)
 * @param {Object} options.filters - Additional filters (provider, category, tag, search)
 * @param {Boolean} options.useCache - Use cached results (default: true)
 * @returns {Promise<Array>} Array of unified model objects
 */
async function getAllModels(options = {}) {
  const {
    includeOllama = true,
    includeN8n = true,
    includeCustom = true,
    includeRegistry = true,
    filters = {},
    useCache = true
  } = options;

  // Check cache
  if (useCache && modelCache && cacheTimestamp && (Date.now() - cacheTimestamp < CACHE_TTL_MS)) {
    logger.debug('Returning cached models', { count: modelCache.length, age: Date.now() - cacheTimestamp });
    return applyFilters(modelCache, filters);
  }

  logger.info('Aggregating models from all sources', { includeOllama, includeN8n, includeCustom, includeRegistry });

  const models = [];

  // Fetch from all sources in parallel
  const [ollamaModels, n8nModels, customModels, registryData, benchmarkData] = await Promise.all([
    includeOllama ? fetchOllamaModels() : Promise.resolve([]),
    includeN8n ? fetchN8nModels() : Promise.resolve([]),
    includeCustom ? fetchCustomModels() : Promise.resolve([]),
    includeRegistry ? fetchRegistryMetadata() : Promise.resolve([]),
    fetchBenchmarkData()
  ]);

  // Merge Ollama models
  for (const ollamaModel of ollamaModels) {
    const unified = {
      id: `ollama:${ollamaModel.host}:${ollamaModel.name}`,
      name: ollamaModel.name,
      displayName: ollamaModel.name,
      provider: 'ollama',
      source: {
        type: 'ollama-host',
        url: ollamaModel.host,
        metadata: {
          size: ollamaModel.size,
          digest: ollamaModel.digest,
          modified: ollamaModel.modified_at
        }
      },
      capabilities: {
        maxContext: ollamaModel.details?.context_length || 4096,
        supportsStreaming: true,
        supportsThinking: ollamaModel.name.includes('qwen') || ollamaModel.name.includes('deepseek'),
        avgLatencyMs: null // Will be enriched from benchmarks
      },
      deployment: {
        status: 'available',
        deployedAt: ollamaModel.modified_at,
        ollamaHost: ollamaModel.host
      },
      categories: [],
      tags: [],
      benchmarkStats: null,
      cost: { promptCostPer1M: 0, completionCostPer1M: 0, currency: 'USD' } // Local = free
    };

    // Enrich with registry metadata
    const registryMatch = registryData.find(r => r.modelName === ollamaModel.name);
    if (registryMatch) {
      unified.categories = registryMatch.categories || [];
      unified.tags = registryMatch.tags || [];
      unified.capabilities.maxContext = registryMatch.capabilities?.maxContext || unified.capabilities.maxContext;
      unified.capabilities.supportsThinking = registryMatch.capabilities?.supportsThinking ?? unified.capabilities.supportsThinking;
      unified.benchmarkStats = registryMatch.benchmarkStats;
    }

    // Enrich with benchmark data
    const benchmarkMatch = benchmarkData.find(b => b.model === ollamaModel.name);
    if (benchmarkMatch) {
      unified.capabilities.avgLatencyMs = benchmarkMatch.avgLatency;
      if (!unified.benchmarkStats) {
        unified.benchmarkStats = {
          avgCompositeScore: benchmarkMatch.avgScore,
          totalTests: benchmarkMatch.testCount
        };
      }
    }

    models.push(unified);
  }

  // Merge n8n webhook LLMs
  for (const n8nModel of n8nModels) {
    const unified = {
      id: `n8n:${n8nModel._id}`,
      name: n8nModel.name,
      displayName: `${n8nModel.name} (via n8n)`,
      provider: 'n8n-webhook',
      source: {
        type: 'n8n-webhook',
        url: n8nModel.webhookUrl,
        metadata: {
          n8nProvider: n8nModel.provider,
          authType: n8nModel.authentication?.type,
          lastTested: n8nModel.lastTestResult?.testedAt,
          testSuccess: n8nModel.lastTestResult?.success
        }
      },
      capabilities: {
        maxContext: n8nModel.capabilities?.maxContext || 4096,
        supportsStreaming: n8nModel.capabilities?.supportsStreaming || false,
        supportsThinking: n8nModel.capabilities?.supportsThinking || false,
        avgLatencyMs: n8nModel.capabilities?.estimatedLatencyMs || n8nModel.lastTestResult?.latencyMs
      },
      deployment: {
        status: n8nModel.isActive ? 'available' : 'inactive',
        deployedAt: n8nModel.createdAt,
        ollamaHost: null
      },
      categories: ['external', n8nModel.provider], // Tag as external + provider type
      tags: n8nModel.metadata?.tags || ['n8n', 'webhook', 'cloud'],
      benchmarkStats: null,
      cost: null, // Cloud models have costs, but tracked externally
      usageCount: n8nModel.usageCount || 0,
      lastUsed: n8nModel.lastUsed
    };

    models.push(unified);
  }

  // Merge custom models
  for (const customModel of customModels) {
    const unified = {
      id: `custom:${customModel._id}`,
      name: customModel.modelName || customModel.modelId,
      displayName: `${customModel.displayName || customModel.modelName || customModel.modelId} (custom)`,
      provider: 'custom',
      source: {
        type: 'custom-modelfile',
        url: null,
        metadata: {
          baseModel: customModel.baseModel,
          customizations: customModel.customizations,
          modelfile: customModel.generatedModelfile
        }
      },
      capabilities: {
        maxContext: customModel.advancedConfig?.num_ctx || 4096,
        supportsStreaming: true,
        supportsThinking: customModel.baseModel?.includes('qwen') || customModel.baseModel?.includes('deepseek'),
        avgLatencyMs: null
      },
      deployment: {
        status: customModel.status,
        deployedAt: customModel.lastDeployedAt,
        ollamaHost: customModel.deployedHost
      },
      categories: customModel.categories || [],
      tags: customModel.tags || ['custom'],
      benchmarkStats: customModel.performance,
      cost: { promptCostPer1M: 0, completionCostPer1M: 0, currency: 'USD' }
    };

    models.push(unified);
  }

  // Update cache
  modelCache = models;
  cacheTimestamp = Date.now();

  logger.info('Model aggregation complete', {
    total: models.length,
    ollama: ollamaModels.length,
    n8n: n8nModels.length,
    custom: customModels.length
  });

  return applyFilters(models, filters);
}

/**
 * Fetch models from Ollama hosts
 */
async function fetchOllamaModels() {
  const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
  const models = [];

  const hosts = [
    process.env.OLLAMA_HOST,
    process.env.OLLAMA_HOST_SECONDARY
  ].filter(Boolean);

  logger.debug('Fetching models from Ollama hosts', { hosts });

  for (const host of hosts) {
    try {
      const response = await fetch(`${host}/api/tags`, { timeout: 5000 });

      if (!response.ok) {
        logger.warn('Ollama host unreachable', { host, status: response.status });
        continue;
      }

      const data = await response.json();

      if (data.models && Array.isArray(data.models)) {
        for (const model of data.models) {
          models.push({
            ...model,
            host
          });
        }
      }
    } catch (error) {
      logger.error('Failed to fetch from Ollama host', { host, error: error.message });
    }
  }

  return models;
}

/**
 * Fetch n8n webhook LLMs from database
 */
async function fetchN8nModels() {
  try {
    return await N8nLLMSource.find({ isActive: true }).lean();
  } catch (error) {
    logger.error('Failed to fetch n8n models', { error: error.message });
    return [];
  }
}

/**
 * Fetch custom models from database
 */
async function fetchCustomModels() {
  try {
    return await CustomModel.find({}).lean();
  } catch (error) {
    logger.error('Failed to fetch custom models', { error: error.message });
    return [];
  }
}

/**
 * Fetch registry metadata from database
 */
async function fetchRegistryMetadata() {
  try {
    return await ModelRegistry.find({}).lean();
  } catch (error) {
    logger.error('Failed to fetch registry metadata', { error: error.message });
    return [];
  }
}

/**
 * Fetch benchmark data for enrichment
 */
async function fetchBenchmarkData() {
  try {
    const results = await BenchmarkResult.aggregate([
      { $match: { status: 'completed' } },
      {
        $group: {
          _id: '$model',
          avgLatency: { $avg: '$result.latency' },
          avgScore: { $avg: '$result.score' },
          testCount: { $sum: 1 }
        }
      },
      { $project: { _id: 0, model: '$_id', avgLatency: 1, avgScore: 1, testCount: 1 } }
    ]);

    return results;
  } catch (error) {
    logger.error('Failed to fetch benchmark data', { error: error.message });
    return [];
  }
}

/**
 * Apply filters to model list
 */
function applyFilters(models, filters) {
  let filtered = [...models];

  if (filters.provider) {
    filtered = filtered.filter(m => m.provider === filters.provider);
  }

  if (filters.category) {
    filtered = filtered.filter(m => m.categories?.includes(filters.category));
  }

  if (filters.tag) {
    filtered = filtered.filter(m => m.tags?.includes(filters.tag));
  }

  if (filters.search) {
    const search = filters.search.toLowerCase();
    filtered = filtered.filter(m =>
      m.name.toLowerCase().includes(search) ||
      m.displayName.toLowerCase().includes(search)
    );
  }

  if (filters.status) {
    filtered = filtered.filter(m => m.deployment?.status === filters.status);
  }

  return filtered;
}

/**
 * Get model sources summary
 */
async function getModelSources() {
  const models = await getAllModels({ useCache: false });

  const sources = {
    ollama: {
      hosts: [],
      count: 0
    },
    n8n: {
      webhooks: [],
      count: 0
    },
    custom: {
      count: 0
    },
    registry: {
      count: 0
    }
  };

  // Extract unique Ollama hosts
  const ollamaHosts = [...new Set(models.filter(m => m.provider === 'ollama').map(m => m.source.url))];
  sources.ollama.hosts = ollamaHosts;
  sources.ollama.count = models.filter(m => m.provider === 'ollama').length;

  // Extract n8n webhooks
  const n8nWebhooks = models.filter(m => m.provider === 'n8n-webhook').map(m => ({
    id: m.id,
    name: m.name,
    provider: m.source.metadata.n8nProvider,
    url: m.source.url
  }));
  sources.n8n.webhooks = n8nWebhooks;
  sources.n8n.count = n8nWebhooks.length;

  sources.custom.count = models.filter(m => m.provider === 'custom').length;

  // Registry count (models with registry metadata)
  sources.registry.count = models.filter(m => m.categories && m.categories.length > 0).length;

  return sources;
}

/**
 * Get model by name (fuzzy match across all sources)
 */
async function getModelByName(name, provider = null) {
  const models = await getAllModels({ useCache: true });

  let matches = models.filter(m => m.name === name || m.displayName === name);

  if (provider) {
    matches = matches.filter(m => m.provider === provider);
  }

  if (matches.length === 0) {
    // Fuzzy search
    matches = models.filter(m =>
      m.name.includes(name) || m.displayName.includes(name)
    );
  }

  return matches[0] || null;
}

/**
 * Refresh model cache (force re-fetch)
 */
async function refreshModelCache() {
  logger.info('Refreshing model cache (forced)');
  modelCache = null;
  cacheTimestamp = null;

  const models = await getAllModels({ useCache: false });

  return {
    modelsFound: models.length,
    sources: await getModelSources(),
    timestamp: new Date()
  };
}

/**
 * Clear model cache
 */
function clearCache() {
  modelCache = null;
  cacheTimestamp = null;
  logger.debug('Model cache cleared');
}

module.exports = {
  getAllModels,
  getModelSources,
  getModelByName,
  refreshModelCache,
  clearCache
};
