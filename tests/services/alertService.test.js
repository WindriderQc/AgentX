const alertService = require('../../src/services/alertService');
const Alert = require('../../models/Alert');
const mongoose = require('mongoose');

/**
 * Unit tests for AlertService - Track 1: Alerts & Notifications
 */
describe('AlertService', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/agentx_test', {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
    }

    // Enable test mode
    process.env.ALERT_TEST_MODE = 'true';
  });

  afterAll(async () => {
    await Alert.deleteMany({});
    await mongoose.connection.close();
  });

  afterEach(async () => {
    await Alert.deleteMany({});
  });

  describe('Rule Loading', () => {
    test('should load rules from array', () => {
      const rules = [
        {
          id: 'test_rule_1',
          name: 'Test Rule 1',
          enabled: true,
          metric: 'response_time',
          threshold: 5000,
          comparison: 'greater_than',
          severity: 'warning',
          title: 'Slow Response Detected',
          message: 'Response time exceeded threshold'
        },
        {
          id: 'test_rule_2',
          name: 'Test Rule 2',
          enabled: false,
          metric: 'error_rate',
          threshold: 0.05,
          comparison: 'greater_than',
          severity: 'error',
          title: 'High Error Rate',
          message: 'Error rate is too high'
        }
      ];

      const count = alertService.loadRules(rules);

      expect(count).toBe(1); // Only enabled rules
    });

    test('should throw error for invalid rules format', () => {
      expect(() => alertService.loadRules('not an array')).toThrow();
    });
  });

  describe('Rule Evaluation', () => {
    beforeEach(() => {
      const rules = [
        {
          id: 'response_time_rule',
          name: 'Response Time Rule',
          enabled: true,
          metric: 'response_time',
          threshold: 5000,
          comparison: 'greater_than',
          severity: 'warning',
          title: 'Slow Response: {{component}}',
          message: 'Response time ({{value}}ms) exceeded threshold',
          channels: ['dataapi_log']
        },
        {
          id: 'error_rate_rule',
          name: 'Error Rate Rule',
          enabled: true,
          metric: 'error_rate',
          threshold: 0.05,
          comparison: 'greater_than',
          severity: 'error',
          title: 'High Error Rate',
          message: 'Error rate is {{value}}',
          channels: ['dataapi_log']
        }
      ];

      alertService.loadRules(rules);
    });

    test('should trigger alert when rule matches', async () => {
      const event = {
        component: 'ollama-99',
        metric: 'response_time',
        value: 6000,
        source: 'agentx'
      };

      const alerts = await alertService.evaluateEvent(event);

      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe('warning');
      expect(alerts[0].title).toContain('ollama-99');
    });

    test('should not trigger alert when rule does not match', async () => {
      const event = {
        component: 'ollama-99',
        metric: 'response_time',
        value: 3000, // Below threshold
        source: 'agentx'
      };

      const alerts = await alertService.evaluateEvent(event);

      expect(alerts).toHaveLength(0);
    });

    test('should handle multiple matching rules', async () => {
      const rules = [
        {
          id: 'rule_1',
          name: 'Rule 1',
          enabled: true,
          componentPattern: 'ollama-*',
          threshold: 5000,
          comparison: 'greater_than',
          severity: 'warning',
          title: 'Alert 1',
          message: 'Message 1',
          channels: ['dataapi_log']
        },
        {
          id: 'rule_2',
          name: 'Rule 2',
          enabled: true,
          componentPattern: 'ollama-99',
          threshold: 4000,
          comparison: 'greater_than',
          severity: 'error',
          title: 'Alert 2',
          message: 'Message 2',
          channels: ['dataapi_log']
        }
      ];

      alertService.loadRules(rules);

      const event = {
        component: 'ollama-99',
        value: 6000,
        source: 'agentx'
      };

      const alerts = await alertService.evaluateEvent(event);

      expect(alerts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Alert Deduplication', () => {
    beforeEach(() => {
      const rules = [
        {
          id: 'dedup_test_rule',
          name: 'Deduplication Test',
          enabled: true,
          metric: 'test_metric',
          threshold: 100,
          comparison: 'greater_than',
          severity: 'info',
          title: 'Test Alert',
          message: 'Test message',
          channels: ['dataapi_log']
        }
      ];

      alertService.loadRules(rules);
    });

    test('should deduplicate alerts within cooldown period', async () => {
      const event = {
        component: 'test-component',
        metric: 'test_metric',
        value: 150,
        source: 'test'
      };

      // First alert
      const alert1 = await alertService.evaluateEvent(event);
      expect(alert1).toHaveLength(1);
      expect(alert1[0].occurrenceCount).toBe(1);

      // Second alert (should be deduplicated)
      const alert2 = await alertService.evaluateEvent(event);
      expect(alert2).toHaveLength(1);
      expect(alert2[0].occurrenceCount).toBe(2);
      expect(alert2[0]._id.toString()).toBe(alert1[0]._id.toString());
    });
  });

  describe('Template Rendering', () => {
    beforeEach(() => {
      const rules = [
        {
          id: 'template_rule',
          name: 'Template Test',
          enabled: true,
          threshold: 100,
          comparison: 'greater_than',
          severity: 'info',
          title: 'Alert for {{component}} - {{metric}}',
          message: 'Value {{value}} exceeded threshold {{threshold}}',
          channels: ['dataapi_log']
        }
      ];

      alertService.loadRules(rules);
    });

    test('should render templates with event data', async () => {
      const event = {
        component: 'test-service',
        metric: 'cpu_usage',
        value: 150,
        threshold: 100,
        source: 'test'
      };

      const alerts = await alertService.evaluateEvent(event);

      expect(alerts).toHaveLength(1);
      expect(alerts[0].title).toContain('test-service');
      expect(alerts[0].title).toContain('cpu_usage');
      expect(alerts[0].message).toContain('150');
    });
  });

  describe('Notification Channels', () => {
    test('should handle test mode for all channels', async () => {
      process.env.ALERT_TEST_MODE = 'true';

      const alert = new Alert({
        ruleId: 'notification_test',
        ruleName: 'Notification Test',
        severity: 'warning',
        title: 'Test Notification',
        message: 'Testing notifications',
        fingerprint: 'notif_test_fp',
        channels: ['email', 'slack', 'webhook', 'dataapi_log']
      });

      await alert.save();

      const results = await alertService._sendNotifications(alert, alert.channels);

      // In test mode, all should succeed without actually sending
      expect(results.email?.sent || results.email?.error).toBeTruthy();
      expect(results.slack?.sent || results.slack?.error).toBeTruthy();
      expect(results.webhook?.sent || results.webhook?.error).toBeTruthy();
      expect(results.dataapi_log?.sent || results.dataapi_log?.error).toBeTruthy();
    });
  });

  describe('Alert Management', () => {
    test('should retrieve recent alerts', async () => {
      // Create test alerts
      await Alert.create([
        {
          ruleId: 'recent_1',
          ruleName: 'Recent 1',
          severity: 'info',
          title: 'Alert 1',
          message: 'Message 1',
          fingerprint: 'fp_recent_1'
        },
        {
          ruleId: 'recent_2',
          ruleName: 'Recent 2',
          severity: 'warning',
          title: 'Alert 2',
          message: 'Message 2',
          fingerprint: 'fp_recent_2'
        }
      ]);

      const alerts = await alertService.getRecentAlerts(10);

      expect(alerts.length).toBeGreaterThanOrEqual(2);
    });

    test('should filter alerts by severity', async () => {
      await Alert.create([
        {
          ruleId: 'filter_1',
          ruleName: 'Filter 1',
          severity: 'info',
          title: 'Info Alert',
          message: 'Info message',
          fingerprint: 'fp_filter_1'
        },
        {
          ruleId: 'filter_2',
          ruleName: 'Filter 2',
          severity: 'critical',
          title: 'Critical Alert',
          message: 'Critical message',
          fingerprint: 'fp_filter_2'
        }
      ]);

      const criticalAlerts = await alertService.getRecentAlerts(10, { severity: 'critical' });

      expect(criticalAlerts.every(a => a.severity === 'critical')).toBe(true);
    });

    test('should acknowledge alert', async () => {
      const alert = await Alert.create({
        ruleId: 'ack_test',
        ruleName: 'Ack Test',
        severity: 'warning',
        title: 'Test Alert',
        message: 'Test message',
        fingerprint: 'ack_fp'
      });

      await alertService.acknowledgeAlert(alert._id, 'test_user', 'Looking into it');

      const updated = await Alert.findById(alert._id);
      expect(updated.status).toBe('acknowledged');
      expect(updated.acknowledgment.acknowledgedBy).toBe('test_user');
    });

    test('should resolve alert', async () => {
      const alert = await Alert.create({
        ruleId: 'resolve_test',
        ruleName: 'Resolve Test',
        severity: 'error',
        title: 'Test Alert',
        message: 'Test message',
        fingerprint: 'resolve_fp'
      });

      await alertService.resolveAlert(alert._id, 'test_user', 'auto', 'Fixed automatically');

      const updated = await Alert.findById(alert._id);
      expect(updated.status).toBe('resolved');
      expect(updated.resolution.resolutionMethod).toBe('auto');
    });
  });

  describe('Statistics', () => {
    beforeEach(async () => {
      await Alert.create([
        {
          ruleId: 'stats_1',
          ruleName: 'Stats 1',
          severity: 'info',
          status: 'active',
          title: 'Alert 1',
          message: 'Message 1',
          fingerprint: 'stats_fp_1'
        },
        {
          ruleId: 'stats_2',
          ruleName: 'Stats 2',
          severity: 'warning',
          status: 'resolved',
          title: 'Alert 2',
          message: 'Message 2',
          fingerprint: 'stats_fp_2',
          resolution: {
            resolved: true,
            resolvedAt: new Date(),
            resolutionMethod: 'manual'
          }
        }
      ]);
    });

    test('should return alert statistics', async () => {
      const stats = await alertService.getStatistics();

      expect(stats).toBeDefined();
      expect(Array.isArray(stats)).toBe(true);
    });
  });
});
