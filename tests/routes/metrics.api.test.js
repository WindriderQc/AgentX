/**
 * Integration Tests for Metrics API Routes
 * Track 2: Historical Metrics & Analytics - T2.5
 * 
 * Tests the REST API endpoints for time-series metrics
 */

const request = require('supertest');
const express = require('express');
const MetricsSnapshot = require('../../models/MetricsSnapshot');
const metricsCollector = require('../../src/services/metricsCollector');

// Mock the optionalAuth middleware before requiring routes
jest.mock('../../src/middleware/auth', () => ({
  optionalAuth: (req, res, next) => {
    res.locals.user = { userId: 'test-user-123', name: 'Test User' };
    next();
  }
}));

// Create test app
const app = express();
app.use(express.json());

// Mount metrics routes
const metricsRoutes = require('../../routes/metrics');
app.use('/api/metrics', metricsRoutes);

describe('Metrics API Routes', () => {
  beforeEach(async () => {
    // Clear metrics before each test
    await MetricsSnapshot.deleteMany({});
  });

  afterAll(async () => {
    await MetricsSnapshot.deleteMany({});
  });

  describe('POST /api/metrics/health', () => {
    it('should record a health metric', async () => {
      const healthData = {
        componentType: 'model',
        componentId: 'claude-3-opus',
        healthData: {
          status: 'healthy',
          responseTime: 150,
          errorRate: 0.01,
          availability: 99.9
        }
      };

      const response = await request(app)
        .post('/api/metrics/health')
        .send(healthData)
        .expect(201);

      expect(response.body.status).toBe('success');
      expect(response.body.data.metricId).toBeDefined();
      expect(response.body.data.timestamp).toBeDefined();

      // Verify in database
      const metric = await MetricsSnapshot.findById(response.body.data.metricId);
      expect(metric).toBeDefined();
      expect(metric.componentType).toBe('model');
      expect(metric.componentId).toBe('claude-3-opus');
      expect(metric.metricType).toBe('health');
    });

    it('should reject health metric with missing fields', async () => {
      const response = await request(app)
        .post('/api/metrics/health')
        .send({ componentType: 'model' })
        .expect(400);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('required fields');
    });
  });

  describe('POST /api/metrics/performance', () => {
    it('should record a performance metric', async () => {
      const perfData = {
        componentType: 'workflow',
        componentId: 'N1.1-health-check',
        perfData: {
          executionTime: 250,
          throughput: 100,
          latency: 50,
          queueDepth: 5
        }
      };

      const response = await request(app)
        .post('/api/metrics/performance')
        .send(perfData)
        .expect(201);

      expect(response.body.status).toBe('success');
      expect(response.body.data.metricId).toBeDefined();

      // Verify in database
      const metric = await MetricsSnapshot.findById(response.body.data.metricId);
      expect(metric.metricType).toBe('performance');
      expect(metric.data.executionTime).toBe(250);
    });
  });

  describe('POST /api/metrics/cost', () => {
    it('should record a cost metric', async () => {
      const costData = {
        model: 'gpt-4',
        costData: {
          inputTokens: 1000,
          outputTokens: 500,
          totalCost: 0.035,
          costPerToken: 0.00002333
        }
      };

      const response = await request(app)
        .post('/api/metrics/cost')
        .send(costData)
        .expect(201);

      expect(response.body.status).toBe('success');

      // Verify in database
      const metric = await MetricsSnapshot.findById(response.body.data.metricId);
      expect(metric.metricType).toBe('cost');
      expect(metric.componentId).toBe('gpt-4');
      expect(metric.data.totalCost).toBe(0.035);
    });
  });

  describe('POST /api/metrics/resource', () => {
    it('should record a resource metric', async () => {
      const resourceData = {
        componentId: 'agentx-server',
        resourceData: {
          cpuUsage: 45.2,
          memoryUsage: 512,
          diskUsage: 1024,
          networkIn: 100,
          networkOut: 50
        }
      };

      const response = await request(app)
        .post('/api/metrics/resource')
        .send(resourceData)
        .expect(201);

      expect(response.body.status).toBe('success');

      // Verify in database
      const metric = await MetricsSnapshot.findById(response.body.data.metricId);
      expect(metric.metricType).toBe('resource');
      expect(metric.data.cpuUsage).toBe(45.2);
    });
  });

  describe('POST /api/metrics/quality', () => {
    it('should record a quality metric', async () => {
      const qualityData = {
        componentId: 'prompt-v2',
        qualityData: {
          accuracyScore: 0.92,
          coherenceScore: 0.88,
          relevanceScore: 0.95,
          userSatisfaction: 4.5
        }
      };

      const response = await request(app)
        .post('/api/metrics/quality')
        .send(qualityData)
        .expect(201);

      expect(response.body.status).toBe('success');

      // Verify in database
      const metric = await MetricsSnapshot.findById(response.body.data.metricId);
      expect(metric.metricType).toBe('quality');
      expect(metric.data.accuracyScore).toBe(0.92);
    });
  });

  describe('POST /api/metrics/usage', () => {
    it('should record a usage metric', async () => {
      const usageData = {
        componentId: 'api-endpoint-chat',
        usageData: {
          requestCount: 150,
          activeUsers: 25,
          dataTransferred: 5000,
          cachehitRate: 0.75
        }
      };

      const response = await request(app)
        .post('/api/metrics/usage')
        .send(usageData)
        .expect(201);

      expect(response.body.status).toBe('success');

      // Verify in database
      const metric = await MetricsSnapshot.findById(response.body.data.metricId);
      expect(metric.metricType).toBe('usage');
      expect(metric.data.requestCount).toBe(150);
    });
  });

  describe('GET /api/metrics/timeseries', () => {
    beforeEach(async () => {
      // Create test time-series data
      const now = new Date();
      const metrics = [];
      
      for (let i = 0; i < 5; i++) {
        const timestamp = new Date(now.getTime() - i * 60000); // Every minute
        metrics.push({
          componentType: 'model',
          componentId: 'test-model',
          metricType: 'performance',
          data: {
            responseTime: 100 + i * 10
          },
          createdAt: timestamp
        });
      }
      
      await MetricsSnapshot.insertMany(metrics);
    });

    it('should query time-series data', async () => {
      const from = new Date(Date.now() - 10 * 60000).toISOString(); // 10 minutes ago
      const to = new Date().toISOString();

      const response = await request(app)
        .get('/api/metrics/timeseries')
        .query({
          componentId: 'test-model',
          metricName: 'responseTime',
          from: from,
          to: to
        })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.series).toBeDefined();
      expect(Array.isArray(response.body.data.series)).toBe(true);
      expect(response.body.data.dataPoints).toBeGreaterThan(0);
    });

    it('should reject query without required parameters', async () => {
      const response = await request(app)
        .get('/api/metrics/timeseries')
        .query({ componentId: 'test-model' })
        .expect(400);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('required parameters');
    });

    it('should support granularity parameter', async () => {
      const from = new Date(Date.now() - 60 * 60000).toISOString(); // 1 hour ago

      const response = await request(app)
        .get('/api/metrics/timeseries')
        .query({
          componentId: 'test-model',
          metricName: 'responseTime',
          from: from,
          granularity: '5m'
        })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.granularity).toBe('5m');
    });
  });

  describe('GET /api/metrics/trends', () => {
    beforeEach(async () => {
      // Create trend data
      const now = new Date();
      const metrics = [];
      
      // Current period
      for (let i = 0; i < 24; i++) {
        metrics.push({
          componentType: 'model',
          componentId: 'trend-model',
          metricType: 'performance',
          data: { responseTime: 100 + Math.random() * 20 },
          createdAt: new Date(now.getTime() - i * 3600000) // Hourly
        });
      }
      
      // Previous period
      for (let i = 24; i < 48; i++) {
        metrics.push({
          componentType: 'model',
          componentId: 'trend-model',
          metricType: 'performance',
          data: { responseTime: 120 + Math.random() * 20 },
          createdAt: new Date(now.getTime() - i * 3600000)
        });
      }
      
      await MetricsSnapshot.insertMany(metrics);
    });

    it('should get trend analysis', async () => {
      const response = await request(app)
        .get('/api/metrics/trends')
        .query({
          componentId: 'trend-model',
          metricName: 'responseTime',
          period: '24h'
        })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.trends).toBeDefined();
      expect(response.body.data.period).toBe('24h');
    });

    it('should reject trends without required parameters', async () => {
      const response = await request(app)
        .get('/api/metrics/trends')
        .query({ period: '24h' })
        .expect(400);

      expect(response.body.status).toBe('error');
    });
  });

  describe('POST /api/metrics/aggregate', () => {
    beforeEach(async () => {
      // Create raw metrics for aggregation
      const now = new Date();
      const metrics = [];
      
      for (let i = 0; i < 100; i++) {
        metrics.push({
          componentType: 'model',
          componentId: 'agg-model',
          metricType: 'performance',
          data: { responseTime: 100 + Math.random() * 50 },
          granularity: 'raw',
          createdAt: new Date(now.getTime() - i * 60000) // Every minute
        });
      }
      
      await MetricsSnapshot.insertMany(metrics);
    });

    it('should trigger manual aggregation', async () => {
      const response = await request(app)
        .post('/api/metrics/aggregate')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data).toBeDefined();
    });
  });

  describe('GET /api/metrics/latest', () => {
    beforeEach(async () => {
      await MetricsSnapshot.create({
        componentType: 'model',
        componentId: 'latest-model',
        metricType: 'health',
        data: { responseTime: 150 },
        createdAt: new Date()
      });
    });

    it('should get latest metric value', async () => {
      const response = await request(app)
        .get('/api/metrics/latest')
        .query({
          componentId: 'latest-model',
          metricName: 'responseTime'
        })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.metric).toBeDefined();
      expect(response.body.data.metric.data.responseTime).toBe(150);
    });

    it('should return 404 when no metrics found', async () => {
      const response = await request(app)
        .get('/api/metrics/latest')
        .query({
          componentId: 'non-existent',
          metricName: 'responseTime'
        })
        .expect(404);

      expect(response.body.status).toBe('error');
    });

    it('should reject without required parameters', async () => {
      const response = await request(app)
        .get('/api/metrics/latest')
        .query({ componentId: 'test' })
        .expect(400);

      expect(response.body.status).toBe('error');
    });
  });

  describe('GET /api/metrics/statistics', () => {
    beforeEach(async () => {
      await MetricsSnapshot.insertMany([
        {
          componentType: 'model',
          componentId: 'stats-model-1',
          metricType: 'performance',
          data: { value: 100 },
          createdAt: new Date()
        },
        {
          componentType: 'model',
          componentId: 'stats-model-2',
          metricType: 'performance',
          data: { value: 200 },
          createdAt: new Date()
        },
        {
          componentType: 'workflow',
          componentId: 'stats-workflow-1',
          metricType: 'cost',
          data: { value: 50 },
          createdAt: new Date()
        }
      ]);
    });

    it('should get metrics statistics', async () => {
      const response = await request(app)
        .get('/api/metrics/statistics')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.statistics).toBeDefined();
    });

    it('should filter statistics by component type', async () => {
      const response = await request(app)
        .get('/api/metrics/statistics')
        .query({ componentType: 'model' })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.statistics).toBeDefined();
    });

    it('should filter statistics by metric type', async () => {
      const response = await request(app)
        .get('/api/metrics/statistics')
        .query({ metricType: 'performance' })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.statistics).toBeDefined();
    });

    it('should support date range filtering', async () => {
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const to = new Date().toISOString();

      const response = await request(app)
        .get('/api/metrics/statistics')
        .query({ from, to })
        .expect(200);

      expect(response.body.status).toBe('success');
    });
  });

  describe('DELETE /api/metrics/purge', () => {
    beforeEach(async () => {
      const now = new Date();
      const metrics = [];
      
      // Old metrics (should be purged)
      for (let i = 0; i < 10; i++) {
        metrics.push({
          componentType: 'model',
          componentId: 'purge-model',
          metricType: 'health',
          data: { value: i },
          createdAt: new Date(now.getTime() - (100 + i) * 24 * 60 * 60 * 1000)
        });
      }
      
      // Recent metrics (should be kept)
      for (let i = 0; i < 5; i++) {
        metrics.push({
          componentType: 'model',
          componentId: 'purge-model',
          metricType: 'health',
          data: { value: i },
          createdAt: new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
        });
      }
      
      await MetricsSnapshot.insertMany(metrics);
    });

    it('should purge old metrics', async () => {
      const response = await request(app)
        .delete('/api/metrics/purge')
        .query({ retentionDays: 90 })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.deletedCount).toBeGreaterThan(0);
    });

    it('should use default retention when not specified', async () => {
      const response = await request(app)
        .delete('/api/metrics/purge')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data).toBeDefined();
    });
  });
});
