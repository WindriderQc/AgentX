/**
 * Integration Tests for Metrics API Routes
 *
 * NOTE: The MetricsSnapshot schema is a simple time-series record:
 * { timestamp, type, componentId, value, metadata }
 *
 * The metrics router supports:
 * - POST /api/metrics/:type  (health|performance|cost|resource|quality|usage)
 * - GET  /api/metrics/query
 * - GET  /api/metrics/latest
 * - Dashboard monitoring endpoints: /system, /cache, /connection, /database
 */

const request = require('supertest');
const MetricsSnapshot = require('../../models/MetricsSnapshot');
require('../../src/services/metricsCollector');

// Mock the optionalAuth middleware before requiring routes
jest.mock('../../src/middleware/auth', () => ({
  attachUser: (_req, res, next) => {
    res.locals.user = { userId: 'test-user-123', name: 'Test User' };
    next();
  },
  requireAuth: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  apiKeyAuth: (_req, _res, next) => next(),
  optionalAuth: (_req, res, next) => {
    res.locals.user = { userId: 'test-user-123', name: 'Test User' };
    next();
  }
}));

const app = require('../../src/app').app;

describe('Metrics API Routes', () => {
  beforeEach(async () => {
    // Clear metrics before each test
    await MetricsSnapshot.deleteMany({});
  });

  afterAll(async () => {
    await MetricsSnapshot.deleteMany({});
  });

  describe('POST /api/metrics/:type', () => {
    it('records a health metric', async () => {
      const payload = {
        componentId: 'claude-3-opus',
        value: 150,
        metadata: { status: 'healthy', unit: 'ms' }
      };

      const response = await request(app)
        .post('/api/metrics/health')
        .send(payload)
        .expect(201);

      expect(response.body.status).toBe('success');
      expect(response.body.data.metricId).toBeDefined();
      expect(response.body.data.type).toBe('health');
      expect(response.body.data.componentId).toBe('claude-3-opus');
      expect(response.body.data.value).toBe(150);

      const metric = await MetricsSnapshot.findById(response.body.data.metricId).lean();
      expect(metric).toBeTruthy();
      expect(metric.type).toBe('health');
      expect(metric.componentId).toBe('claude-3-opus');
      expect(metric.value).toBe(150);
      expect(metric.metadata.status).toBe('healthy');
    });

    it('rejects missing componentId/value', async () => {
      const response = await request(app)
        .post('/api/metrics/performance')
        .send({ componentId: 'x' })
        .expect(400);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('componentId');
    });
  });

  describe('GET /api/metrics/query', () => {
    beforeEach(async () => {
      const now = new Date();
      await MetricsSnapshot.insertMany([
        {
          timestamp: new Date(now.getTime() - 2 * 60000),
          type: 'performance',
          componentId: 'test-model',
          value: 100,
          metadata: { metricName: 'responseTime' }
        },
        {
          timestamp: new Date(now.getTime() - 1 * 60000),
          type: 'performance',
          componentId: 'test-model',
          value: 110,
          metadata: { metricName: 'responseTime' }
        }
      ]);
    });

    it('queries by type/componentId and time range', async () => {
      const from = new Date(Date.now() - 10 * 60000).toISOString();
      const to = new Date().toISOString();

      const response = await request(app)
        .get('/api/metrics/query')
        .query({ type: 'performance', componentId: 'test-model', from, to })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.count).toBeGreaterThan(0);
      expect(Array.isArray(response.body.data.results)).toBe(true);
      expect(response.body.data.results[0].type).toBe('performance');
    });

    it('supports metadata filtering (JSON)', async () => {
      const response = await request(app)
        .get('/api/metrics/query')
        .query({
          type: 'performance',
          componentId: 'test-model',
          metadata: JSON.stringify({ metricName: 'responseTime' })
        })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.count).toBe(2);
    });

    it('rejects invalid metadata JSON', async () => {
      const response = await request(app)
        .get('/api/metrics/query')
        .query({ metadata: '{not-json' })
        .expect(400);

      expect(response.body.status).toBe('error');
    });
  });

  describe('GET /api/metrics/latest', () => {
    beforeEach(async () => {
      await MetricsSnapshot.insertMany([
        {
          timestamp: new Date('2024-01-01T00:00:00Z'),
          type: 'health',
          componentId: 'latest-model',
          value: 150,
          metadata: { unit: 'ms' }
        },
        {
          timestamp: new Date('2024-01-01T00:01:00Z'),
          type: 'health',
          componentId: 'latest-model',
          value: 140,
          metadata: { unit: 'ms' }
        }
      ]);
    });

    it('returns latest metric for component (optionally by type)', async () => {
      const response = await request(app)
        .get('/api/metrics/latest')
        .query({ componentId: 'latest-model', type: 'health' })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.componentId).toBe('latest-model');
      expect(response.body.data.type).toBe('health');
      expect(response.body.data.value).toBe(140);
    });

    it('returns 404 when no metrics found', async () => {
      const response = await request(app)
        .get('/api/metrics/latest')
        .query({ componentId: 'non-existent' })
        .expect(404);

      expect(response.body.status).toBe('error');
    });

    it('rejects without componentId', async () => {
      const response = await request(app)
        .get('/api/metrics/latest')
        .expect(400);

      expect(response.body.status).toBe('error');
    });
  });

  describe('Dashboard monitoring endpoints', () => {
    it('GET /api/metrics/system returns uptime and memory', async () => {
      const response = await request(app).get('/api/metrics/system').expect(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.uptime?.seconds).toBeDefined();
      expect(response.body.data.memory?.rss).toBeDefined();
    });
  });
});
