/**
 * Unit Tests for MetricsCleanup Service
 *
 * Tests automated storage management and retention policies
 */

const MetricsSnapshot = require('../../models/MetricsSnapshot');
const metricsCleanup = require('../../src/services/metricsCleanup');

// Mock logger to avoid console noise in tests
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

describe('MetricsCleanup Service', () => {
  beforeEach(async () => {
    // Clear all metrics before each test
    await MetricsSnapshot.deleteMany({});

    // Stop any running cleanup timers
    metricsCleanup.stopScheduledCleanup();
  });

  afterAll(async () => {
    await MetricsSnapshot.deleteMany({});
    metricsCleanup.stopScheduledCleanup();
  });

  describe('Initialization', () => {
    it('should initialize with default retention policies', () => {
      const policies = metricsCleanup.getRetentionPolicies();

      expect(policies.raw).toBe(90);
      expect(policies['1h']).toBe(180);
      expect(policies['1d']).toBe(365);
      expect(policies['30d']).toBeNull(); // Kept indefinitely
    });

    it('should be a singleton instance', () => {
      const MetricsCleanup = require('../../src/services/metricsCleanup');
      expect(MetricsCleanup).toBe(metricsCleanup);
    });
  });

  describe('cleanupMetrics()', () => {
    it('should delete raw metrics older than 90 days', async () => {
      // Create old raw metrics
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000); // 100 days ago
      const recentDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

      await MetricsSnapshot.create([
        {
          componentType: 'agentx',
          componentId: 'test-1',
          metricType: 'performance',
          metricName: 'response_time',
          value: 100,
          granularity: 'raw',
          createdAt: oldDate
        },
        {
          componentType: 'agentx',
          componentId: 'test-2',
          metricType: 'performance',
          metricName: 'response_time',
          value: 150,
          granularity: 'raw',
          createdAt: recentDate
        }
      ]);

      const stats = await metricsCleanup.cleanupMetrics();

      expect(stats.totalDeleted).toBe(1);
      expect(stats.granularityStats.raw.deleted).toBe(1);

      // Verify old metric is deleted and recent one remains
      const remaining = await MetricsSnapshot.find({ granularity: 'raw' });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].componentId).toBe('test-2');
    });

    it('should delete hourly aggregates older than 180 days', async () => {
      const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000); // 200 days ago
      const recentDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000); // 100 days ago

      await MetricsSnapshot.create([
        {
          componentType: 'agentx',
          componentId: 'test-1',
          metricType: 'performance',
          metricName: 'response_time',
          value: 100,
          granularity: '1h',
          createdAt: oldDate
        },
        {
          componentType: 'agentx',
          componentId: 'test-2',
          metricType: 'performance',
          metricName: 'response_time',
          value: 150,
          granularity: '1h',
          createdAt: recentDate
        }
      ]);

      const stats = await metricsCleanup.cleanupMetrics();

      expect(stats.granularityStats['1h'].deleted).toBe(1);

      // Verify only recent metric remains
      const remaining = await MetricsSnapshot.find({ granularity: '1h' });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].componentId).toBe('test-2');
    });

    it('should delete daily aggregates older than 1 year', async () => {
      const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000); // 400 days ago
      const recentDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000); // 200 days ago

      await MetricsSnapshot.create([
        {
          componentType: 'agentx',
          componentId: 'test-1',
          metricType: 'performance',
          metricName: 'response_time',
          value: 100,
          granularity: '1d',
          createdAt: oldDate
        },
        {
          componentType: 'agentx',
          componentId: 'test-2',
          metricType: 'performance',
          metricName: 'response_time',
          value: 150,
          granularity: '1d',
          createdAt: recentDate
        }
      ]);

      const stats = await metricsCleanup.cleanupMetrics();

      expect(stats.granularityStats['1d'].deleted).toBe(1);

      // Verify only recent metric remains
      const remaining = await MetricsSnapshot.find({ granularity: '1d' });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].componentId).toBe('test-2');
    });

    it('should keep monthly aggregates indefinitely', async () => {
      const veryOldDate = new Date(Date.now() - 1000 * 24 * 60 * 60 * 1000); // 1000 days ago

      await MetricsSnapshot.create({
        componentType: 'agentx',
        componentId: 'test-1',
        metricType: 'performance',
        metricName: 'response_time',
        value: 100,
        granularity: '30d',
        createdAt: veryOldDate
      });

      const stats = await metricsCleanup.cleanupMetrics();

      expect(stats.granularityStats['30d'].skipped).toBe(true);

      // Verify metric is still there
      const remaining = await MetricsSnapshot.find({ granularity: '30d' });
      expect(remaining).toHaveLength(1);
    });

    it('should return cleanup statistics', async () => {
      const stats = await metricsCleanup.cleanupMetrics();

      expect(stats).toHaveProperty('startTime');
      expect(stats).toHaveProperty('endTime');
      expect(stats).toHaveProperty('totalDeleted');
      expect(stats).toHaveProperty('granularityStats');
      expect(stats).toHaveProperty('executionTimeMs');
      expect(stats).toHaveProperty('errors');
    });

    it('should not run if already running', async () => {
      // Start a cleanup that we'll make slow
      metricsCleanup.isRunning = true;

      const stats = await metricsCleanup.cleanupMetrics();

      expect(stats.skipped).toBe(true);
      expect(stats.reason).toBe('Already running');

      metricsCleanup.isRunning = false;
    });
  });

  describe('cleanupComponentMetrics()', () => {
    it('should delete metrics for a specific component', async () => {
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);

      await MetricsSnapshot.create([
        {
          componentType: 'agentx',
          componentId: 'component-1',
          metricType: 'performance',
          metricName: 'response_time',
          value: 100,
          createdAt: oldDate
        },
        {
          componentType: 'agentx',
          componentId: 'component-2',
          metricType: 'performance',
          metricName: 'response_time',
          value: 150,
          createdAt: oldDate
        }
      ]);

      const stats = await metricsCleanup.cleanupComponentMetrics('component-1', 50);

      expect(stats.deleted).toBe(1);
      expect(stats.componentId).toBe('component-1');

      // Verify component-2 metrics still exist
      const remaining = await MetricsSnapshot.find({});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].componentId).toBe('component-2');
    });
  });

  describe('cleanupMetricType()', () => {
    it('should delete metrics by type', async () => {
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);

      await MetricsSnapshot.create([
        {
          componentType: 'agentx',
          componentId: 'test-1',
          metricType: 'performance',
          metricName: 'response_time',
          value: 100,
          createdAt: oldDate
        },
        {
          componentType: 'agentx',
          componentId: 'test-2',
          metricType: 'health',
          metricName: 'health_status',
          value: 'healthy',
          createdAt: oldDate
        }
      ]);

      const stats = await metricsCleanup.cleanupMetricType('performance', 50);

      expect(stats.deleted).toBe(1);
      expect(stats.metricType).toBe('performance');

      // Verify health metrics still exist
      const remaining = await MetricsSnapshot.find({});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].metricType).toBe('health');
    });
  });

  describe('getStorageStats()', () => {
    it('should return storage statistics by granularity', async () => {
      await MetricsSnapshot.create([
        {
          componentType: 'agentx',
          componentId: 'test-1',
          metricType: 'performance',
          metricName: 'response_time',
          value: 100,
          granularity: 'raw'
        },
        {
          componentType: 'agentx',
          componentId: 'test-2',
          metricType: 'performance',
          metricName: 'response_time',
          value: 150,
          granularity: 'raw'
        },
        {
          componentType: 'agentx',
          componentId: 'test-3',
          metricType: 'performance',
          metricName: 'response_time',
          value: 200,
          granularity: '1h'
        }
      ]);

      const stats = await metricsCleanup.getStorageStats();

      expect(stats.total).toBe(3);
      expect(stats.byGranularity.raw.count).toBe(2);
      expect(stats.byGranularity['1h'].count).toBe(1);
      expect(stats.byGranularity.raw.percentage).toBe('66.67');
    });
  });

  describe('previewCleanup()', () => {
    it('should preview what will be deleted', async () => {
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);

      await MetricsSnapshot.create([
        {
          componentType: 'agentx',
          componentId: 'test-1',
          metricType: 'performance',
          metricName: 'response_time',
          value: 100,
          granularity: 'raw',
          createdAt: oldDate
        },
        {
          componentType: 'agentx',
          componentId: 'test-2',
          metricType: 'performance',
          metricName: 'response_time',
          value: 150,
          granularity: 'raw',
          createdAt: new Date()
        }
      ]);

      const preview = await metricsCleanup.previewCleanup();

      expect(preview.totalToDelete).toBe(1);
      expect(preview.byGranularity.raw.toDelete).toBe(1);
      expect(preview.byGranularity['30d'].message).toBe('Kept indefinitely');
    });
  });

  describe('updateRetentionPolicy()', () => {
    it('should update retention policy for a granularity', () => {
      metricsCleanup.updateRetentionPolicy('raw', 60);

      const policies = metricsCleanup.getRetentionPolicies();
      expect(policies.raw).toBe(60);
    });

    it('should throw error for invalid granularity', () => {
      expect(() => {
        metricsCleanup.updateRetentionPolicy('invalid', 60);
      }).toThrow('Invalid granularity');
    });

    it('should allow setting retention to indefinite', () => {
      metricsCleanup.updateRetentionPolicy('raw', null);

      const policies = metricsCleanup.getRetentionPolicies();
      expect(policies.raw).toBeNull();

      // Restore default
      metricsCleanup.updateRetentionPolicy('raw', 90);
    });
  });

  describe('Scheduled Cleanup', () => {
    it('should schedule cleanup at configured time', () => {
      metricsCleanup.scheduleCleanup();
      expect(metricsCleanup.cleanupTimer).toBeDefined();
      metricsCleanup.stopScheduledCleanup();
    });

    it('should not schedule if already scheduled', () => {
      metricsCleanup.scheduleCleanup();
      const firstTimer = metricsCleanup.cleanupTimer;

      metricsCleanup.scheduleCleanup(); // Try to schedule again

      expect(metricsCleanup.cleanupTimer).toBe(firstTimer);
      metricsCleanup.stopScheduledCleanup();
    });

    it('should stop scheduled cleanup', () => {
      metricsCleanup.scheduleCleanup();
      expect(metricsCleanup.cleanupTimer).toBeDefined();

      metricsCleanup.stopScheduledCleanup();
      expect(metricsCleanup.cleanupTimer).toBeNull();
    });
  });

  describe('forceCleanup()', () => {
    it('should execute cleanup immediately', async () => {
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);

      await MetricsSnapshot.create({
        componentType: 'agentx',
        componentId: 'test-1',
        metricType: 'performance',
        metricName: 'response_time',
        value: 100,
        granularity: 'raw',
        createdAt: oldDate
      });

      const stats = await metricsCleanup.forceCleanup();

      expect(stats.totalDeleted).toBeGreaterThanOrEqual(1);
      expect(stats).toHaveProperty('executionTimeMs');
    });
  });
});
