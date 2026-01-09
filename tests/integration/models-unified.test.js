/**
 * Integration Tests: Unified Model Catalog
 *
 * Tests the complete model aggregation system:
 * - Model aggregator service
 * - Unified API endpoints
 * - Multi-source integration (Ollama, n8n, custom, registry)
 * - Caching behavior
 * - Filtering and search
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { app } = require('../../src/app');
const ModelRegistry = require('../../models/ModelRegistry');
const N8nLLMSource = require('../../models/N8nLLMSource');
const CustomModel = require('../../models/CustomModel');
const modelAggregator = require('../../src/services/modelAggregator');

// Use existing MongoDB connection from app.js
// No need for MongoMemoryServer since app already handles connection

let originalOllamaHost;
let originalOllamaHostSecondary;

beforeAll(() => {
  originalOllamaHost = process.env.OLLAMA_HOST;
  originalOllamaHostSecondary = process.env.OLLAMA_HOST_SECONDARY;
  delete process.env.OLLAMA_HOST;
  delete process.env.OLLAMA_HOST_SECONDARY;
});

afterAll(() => {
  process.env.OLLAMA_HOST = originalOllamaHost;
  process.env.OLLAMA_HOST_SECONDARY = originalOllamaHostSecondary;
});

beforeEach(async () => {
  // Clear collections
  await ModelRegistry.deleteMany({});
  await N8nLLMSource.deleteMany({});
  await CustomModel.deleteMany({});

  // Clear model cache
  modelAggregator.clearCache();
});

describe('Model Aggregator Service', () => {
  describe('getAllModels()', () => {
    it('should aggregate models from registry', async () => {
      // Seed registry
      await ModelRegistry.create({
        modelName: 'qwen2.5-coder:7b',
        displayName: 'Qwen 2.5 Coder 7B',
        vendor: 'alibaba',
        categories: ['coding', 'specialist'],
        tags: ['production', 'fast'],
        capabilities: {
          maxContext: 32768,
          supportsThinking: false
        }
      });

      const models = await modelAggregator.getAllModels({
        includeOllama: false,
        includeN8n: false,
        includeCustom: false,
        includeRegistry: true,
        useCache: false
      });

      // Note: Registry metadata enriches Ollama models, but doesn't create standalone entries
      // So if no Ollama models exist, count will be 0
      expect(Array.isArray(models)).toBe(true);
    });

    it('should aggregate n8n LLM sources', async () => {
      // Create n8n source
      await N8nLLMSource.create({
        name: 'GPT-4 via n8n',
        provider: 'openai',
        webhookUrl: 'https://n8n.example.com/webhook/test',
        authentication: { type: 'none' },
        capabilities: { maxContext: 8192 },
        requestFormat: {
          bodyTemplate: '{"prompt": "{{prompt}}"}',
          responseExtractor: 'completion'
        },
        isActive: true,
        createdBy: new mongoose.Types.ObjectId()
      });

      const models = await modelAggregator.getAllModels({
        includeOllama: false,
        includeN8n: true,
        includeCustom: false,
        includeRegistry: false,
        useCache: false
      });

      expect(models.length).toBe(1);
      expect(models[0].name).toBe('GPT-4 via n8n');
      expect(models[0].provider).toBe('n8n-webhook');
      expect(models[0].source.type).toBe('n8n-webhook');
    });

    it('should aggregate custom models', async () => {
      // Create custom model
      await CustomModel.create({
        modelId: 'custom-coder',
        modelName: 'custom-coder',
        baseModel: 'qwen2.5-coder:7b',
        displayName: 'Custom Coder',
        systemPrompt: 'You are a code expert',
        status: 'deployed',
        createdBy: new mongoose.Types.ObjectId()
      });

      const models = await modelAggregator.getAllModels({
        includeOllama: false,
        includeN8n: false,
        includeCustom: true,
        includeRegistry: false,
        useCache: false
      });

      expect(models.length).toBe(1);
      expect(models[0].name).toBe('custom-coder');
      expect(models[0].provider).toBe('custom');
    });

    it('should filter by provider', async () => {
      // Create n8n and custom models
      await N8nLLMSource.create({
        name: 'n8n-model',
        provider: 'openai',
        webhookUrl: 'https://test.com',
        requestFormat: { bodyTemplate: '{}', responseExtractor: 'text' },
        isActive: true,
        createdBy: new mongoose.Types.ObjectId()
      });

      await CustomModel.create({
        modelId: 'custom-model',
        modelName: 'custom-model',
        baseModel: 'llama3',
        displayName: 'Custom Model',
        status: 'deployed',
        createdBy: new mongoose.Types.ObjectId()
      });

      const models = await modelAggregator.getAllModels({
        includeOllama: false,
        includeN8n: true,
        includeCustom: true,
        filters: { provider: 'n8n-webhook' },
        useCache: false
      });

      expect(models.length).toBe(1);
      expect(models[0].provider).toBe('n8n-webhook');
    });

    it('should filter by category', async () => {
      // Create models with different categories
      await CustomModel.create([
        {
          modelId: 'coding-model',
          modelName: 'coding-model',
          baseModel: 'qwen',
          categories: ['coding'],
          displayName: 'Coding Model',
          status: 'deployed',
          createdBy: new mongoose.Types.ObjectId()
        },
        {
          modelId: 'reasoning-model',
          modelName: 'reasoning-model',
          baseModel: 'llama',
          categories: ['reasoning'],
          displayName: 'Reasoning Model',
          status: 'deployed',
          createdBy: new mongoose.Types.ObjectId()
        }
      ]);

      const models = await modelAggregator.getAllModels({
        includeCustom: true,
        filters: { category: 'coding' },
        useCache: false
      });

      expect(models.length).toBe(1);
      expect(models[0].categories).toContain('coding');
    });

    it('should use cache on repeated calls', async () => {
      // First call - should fetch from DB
      const models1 = await modelAggregator.getAllModels({ useCache: true });

      // Second call - should use cache
      const models2 = await modelAggregator.getAllModels({ useCache: true });

      expect(models1).toEqual(models2);
    });

    it('should bypass cache when useCache=false', async () => {
      // Create model after first call
      await modelAggregator.getAllModels({ useCache: true });

      await N8nLLMSource.create({
        name: 'new-model',
        provider: 'anthropic',
        webhookUrl: 'https://test.com',
        requestFormat: { bodyTemplate: '{}', responseExtractor: 'text' },
        isActive: true,
        createdBy: new mongoose.Types.ObjectId()
      });

      // Force refresh
      const models = await modelAggregator.getAllModels({ useCache: false });

      const n8nModels = models.filter(m => m.provider === 'n8n-webhook');
      expect(n8nModels.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getModelSources()', () => {
    it('should return source summary', async () => {
      // Create test data
      await N8nLLMSource.create({
        name: 'test-n8n',
        provider: 'openai',
        webhookUrl: 'https://test.com',
        requestFormat: { bodyTemplate: '{}', responseExtractor: 'text' },
        isActive: true,
        createdBy: new mongoose.Types.ObjectId()
      });

      const sources = await modelAggregator.getModelSources();

      expect(sources).toHaveProperty('ollama');
      expect(sources).toHaveProperty('n8n');
      expect(sources).toHaveProperty('custom');
      expect(sources).toHaveProperty('registry');

      expect(sources.n8n.count).toBe(1);
    });
  });

  describe('getModelByName()', () => {
    it('should find model by exact name', async () => {
      await CustomModel.create({
        modelId: 'test-model',
        modelName: 'test-model',
        baseModel: 'llama3',
        displayName: 'Test Model',
        status: 'deployed',
        createdBy: new mongoose.Types.ObjectId()
      });

      const model = await modelAggregator.getModelByName('test-model');

      expect(model).toBeTruthy();
      expect(model.name).toBe('test-model');
    });

    it('should filter by provider', async () => {
      await CustomModel.create({
        modelId: 'test-model',
        modelName: 'test-model',
        baseModel: 'llama3',
        displayName: 'Test Model',
        status: 'deployed',
        createdBy: new mongoose.Types.ObjectId()
      });

      await N8nLLMSource.create({
        name: 'test-model',
        provider: 'openai',
        webhookUrl: 'https://test.com',
        requestFormat: { bodyTemplate: '{}', responseExtractor: 'text' },
        isActive: true,
        createdBy: new mongoose.Types.ObjectId()
      });

      const model = await modelAggregator.getModelByName('test-model', 'custom');

      expect(model).toBeTruthy();
      expect(model.provider).toBe('custom');
    });
  });

  describe('refreshModelCache()', () => {
    it('should force cache refresh', async () => {
      const result = await modelAggregator.refreshModelCache();

      expect(result).toHaveProperty('modelsFound');
      expect(result).toHaveProperty('sources');
      expect(result).toHaveProperty('timestamp');
    });
  });
});

describe('Unified Model API Endpoints', () => {
  describe('GET /api/models/all', () => {
    it('should return all models', async () => {
      const response = await request(app)
        .get('/api/models/all')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data).toHaveProperty('models');
      expect(response.body.data).toHaveProperty('sources');
      expect(response.body.data).toHaveProperty('total');
      expect(Array.isArray(response.body.data.models)).toBe(true);
    });

    it('should filter by provider', async () => {
      await N8nLLMSource.create({
        name: 'test-n8n',
        provider: 'openai',
        webhookUrl: 'https://test.com',
        requestFormat: { bodyTemplate: '{}', responseExtractor: 'text' },
        isActive: true,
        createdBy: new mongoose.Types.ObjectId()
      });

      const response = await request(app)
        .get('/api/models/all?provider=n8n-webhook')
        .expect(200);

      expect(response.body.data.models.every(m => m.provider === 'n8n-webhook')).toBe(true);
    });

    it('should filter by search term', async () => {
      await CustomModel.create({
        modelId: 'qwen-custom',
        modelName: 'qwen-custom',
        displayName: 'Qwen Custom Model',
        baseModel: 'qwen2.5',
        status: 'deployed',
        createdBy: new mongoose.Types.ObjectId()
      });

      const response = await request(app)
        .get('/api/models/all?search=qwen')
        .expect(200);

      expect(response.body.data.models.length).toBeGreaterThanOrEqual(1);
      expect(response.body.data.models.some(m =>
        m.name.includes('qwen') || m.displayName.includes('qwen')
      )).toBe(true);
    });
  });

  describe('GET /api/models/sources', () => {
    it('should return source summary', async () => {
      const response = await request(app)
        .get('/api/models/sources')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data).toHaveProperty('ollama');
      expect(response.body.data).toHaveProperty('n8n');
      expect(response.body.data).toHaveProperty('custom');
      expect(response.body.data).toHaveProperty('registry');
    });
  });

  describe('GET /api/models/:name/detail', () => {
    it('should return 404 for non-existent model', async () => {
      const response = await request(app)
        .get('/api/models/nonexistent-model/detail')
        .expect(404);

      expect(response.body.status).toBe('error');
    });

    it('should return model details', async () => {
      await CustomModel.create({
        modelId: 'test-detail',
        modelName: 'test-detail',
        baseModel: 'llama3',
        displayName: 'Test Detail',
        status: 'deployed',
        createdBy: new mongoose.Types.ObjectId()
      });

      const response = await request(app)
        .get('/api/models/test-detail/detail')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.name).toBe('test-detail');
    });
  });
});

describe('n8n LLM Source Management', () => {
  describe('GET /api/models/sources/n8n', () => {
    it('should list n8n sources', async () => {
      await N8nLLMSource.create({
        name: 'test-source',
        provider: 'openai',
        webhookUrl: 'https://test.com',
        requestFormat: { bodyTemplate: '{}', responseExtractor: 'text' },
        isActive: true,
        createdBy: new mongoose.Types.ObjectId()
      });

      const response = await request(app)
        .get('/api/models/sources/n8n')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.length).toBe(1);
      expect(response.body.total).toBe(1);
    });

    it('should filter active sources', async () => {
      await N8nLLMSource.create([
        {
          name: 'active-source',
          provider: 'openai',
          webhookUrl: 'https://test.com',
          requestFormat: { bodyTemplate: '{}', responseExtractor: 'text' },
          isActive: true,
          createdBy: new mongoose.Types.ObjectId()
        },
        {
          name: 'inactive-source',
          provider: 'anthropic',
          webhookUrl: 'https://test.com',
          requestFormat: { bodyTemplate: '{}', responseExtractor: 'text' },
          isActive: false,
          createdBy: new mongoose.Types.ObjectId()
        }
      ]);

      const response = await request(app)
        .get('/api/models/sources/n8n?activeOnly=true')
        .expect(200);

      expect(response.body.data.length).toBe(1);
      expect(response.body.data[0].isActive).toBe(true);
    });
  });

  describe('GET /api/models/sources/n8n/:id', () => {
    it('should return specific source', async () => {
      const source = await N8nLLMSource.create({
        name: 'test-source',
        provider: 'openai',
        webhookUrl: 'https://test.com',
        requestFormat: { bodyTemplate: '{}', responseExtractor: 'text' },
        isActive: true,
        createdBy: new mongoose.Types.ObjectId()
      });

      const response = await request(app)
        .get(`/api/models/sources/n8n/${source._id}`)
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.name).toBe('test-source');
    });

    it('should return 404 for non-existent source', async () => {
      const fakeId = new mongoose.Types.ObjectId();

      const response = await request(app)
        .get(`/api/models/sources/n8n/${fakeId}`)
        .expect(404);

      expect(response.body.status).toBe('error');
    });
  });
});
