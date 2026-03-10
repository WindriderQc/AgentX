const express = require('express');
const request = require('supertest');
const ModelRegistry = require('../../models/ModelRegistry');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('../helpers/testDb');

jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next()
}));

jest.mock('../../src/middleware/rateLimiter', () => ({
  hostTestLimiter: (req, res, next) => next()
}));

jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: jest.fn(() => ([
    { id: 'primary', name: 'Primary', url: 'http://primary:11434' },
    { id: 'secondary', name: 'Secondary', url: 'http://secondary:11434' }
  ]))
}));

jest.mock('../../src/services/hostTest/hostTestService', () => ({
  testModelOnHost: jest.fn(),
  testAllModelsOnHost: jest.fn(),
  testModelAcrossHosts: jest.fn(),
  checkHost: jest.fn()
}));

const hostTestService = require('../../src/services/hostTest/hostTestService');
const hostTestRoutes = require('../../routes/host-test');

describe('Host Test API Routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/host-test', hostTestRoutes);

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    await connectTestDb();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('runs a single host test', async () => {
    hostTestService.testModelOnHost.mockResolvedValue({
      hostUrl: 'http://primary:11434',
      hostId: 'primary',
      tokensPerSec: 18.4,
      latencyMs: 2400,
      status: 'pass',
      testedAt: new Date('2026-03-10T12:00:00Z')
    });

    const response = await request(app)
      .post('/api/host-test/run')
      .send({ modelName: 'qwen2.5:7b', hostUrl: 'http://primary:11434', hostId: 'primary' })
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.tokensPerSec).toBe(18.4);
    expect(hostTestService.testModelOnHost).toHaveBeenCalledWith('qwen2.5:7b', 'http://primary:11434', { hostId: 'primary' });
  });

  it('starts a run-all batch and exposes progress', async () => {
    hostTestService.checkHost.mockResolvedValue({
      available: true,
      latency: 10,
      models: ['qwen2.5:7b', 'llama3:8b']
    });

    hostTestService.testAllModelsOnHost.mockImplementation(async (_hostUrl, options) => {
      options.onProgress('qwen2.5:7b', {
        hostUrl: 'http://primary:11434',
        hostId: 'primary',
        tokensPerSec: 16.2,
        latencyMs: 2100,
        status: 'pass',
        testedAt: new Date('2026-03-10T12:01:00Z')
      }, 0, 2);

      options.onProgress('llama3:8b', {
        hostUrl: 'http://primary:11434',
        hostId: 'primary',
        tokensPerSec: 0,
        latencyMs: 60000,
        status: 'timeout',
        testedAt: new Date('2026-03-10T12:02:00Z')
      }, 1, 2);

      return {
        summary: {
          total: 2,
          passed: 1,
          failed: 1,
          avgTps: 16.2
        }
      };
    });

    const startResponse = await request(app)
      .post('/api/host-test/run-all')
      .send({ hostUrl: 'http://primary:11434', hostId: 'primary' })
      .expect(200);

    expect(startResponse.body.status).toBe('success');
    expect(startResponse.body.data.totalModels).toBe(2);

    const progressResponse = await request(app)
      .get(`/api/host-test/run-all/${startResponse.body.data.testId}/progress`)
      .expect(200);

    expect(progressResponse.body.data.results).toHaveLength(2);
    expect(progressResponse.body.data.failed).toBe(1);
  });

  it('compares a model across hosts', async () => {
    hostTestService.testModelAcrossHosts.mockResolvedValue({
      modelName: 'qwen2.5:7b',
      hostResults: [
        { hostUrl: 'http://primary:11434', hostId: 'primary', tokensPerSec: 17.1, status: 'pass' },
        { hostUrl: 'http://secondary:11434', hostId: 'secondary', tokensPerSec: 14.8, status: 'pass' }
      ]
    });

    const response = await request(app)
      .post('/api/host-test/compare')
      .send({ modelName: 'qwen2.5:7b' })
      .expect(200);

    expect(response.body.data.hostResults).toHaveLength(2);
    expect(hostTestService.testModelAcrossHosts).toHaveBeenCalledWith('qwen2.5:7b');
  });

  it('returns stored host-performance snapshots with summary', async () => {
    await ModelRegistry.create({
      modelName: 'qwen2.5:7b',
      displayName: 'Qwen 2.5 7B',
      hostPerformance: [
        {
          hostUrl: 'http://primary:11434',
          hostId: 'primary',
          tokensPerSec: 18.4,
          latencyMs: 2400,
          timeToFirstTokenMs: 410,
          testedAt: new Date('2026-03-10T12:00:00Z'),
          status: 'pass'
        }
      ]
    });

    const response = await request(app)
      .get('/api/host-test/results')
      .expect(200);

    expect(response.body.data.results).toHaveLength(1);
    expect(response.body.data.summary.avgTps).toBe(18.4);
    expect(response.body.data.summary.modelsTested).toBe(1);
  });

  it('returns 404 for unknown progress tracker ids', async () => {
    const response = await request(app)
      .get('/api/host-test/run-all/missing/progress')
      .expect(404);

    expect(response.body.status).toBe('error');
  });
});