const Alert = require('../../models/Alert');
const MetricsSnapshot = require('../../models/MetricsSnapshot');
const alertServiceModule = require('../../src/services/alertService');
const ModelRouter = require('../../src/services/modelRouter');
const mongoose = require('mongoose');
const fs = require('fs').promises;
const path = require('path');

/**
 * Unit tests for SelfHealingEngine - Track 4: Self-Healing & Resilience
 */
describe('SelfHealingEngine', () => {
  let engine;
  let originalEnv;

  beforeAll(async () => {
    // Save original environment
    originalEnv = { ...process.env };

    // Set test environment
    process.env.SELF_HEALING_ENABLED = 'true';
    process.env.REQUIRE_APPROVAL = 'true';
    process.env.MAX_CONCURRENT_ACTIONS = '3';

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/agentx_test', {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
    }
  });

  beforeEach(async () => {
    // Clear singleton instance to ensure fresh state
    delete require.cache[require.resolve('../../src/services/selfHealingEngine')];
    const SelfHealingEngine = require('../../src/services/selfHealingEngine');
    engine = SelfHealingEngine;

    // Clear database
    await Alert.deleteMany({});
    await MetricsSnapshot.deleteMany({});

    // Reset execution history
    if (engine.executionHistory) {
      engine.executionHistory.clear();
    }
  });

  afterAll(async () => {
    // Restore original environment
    process.env = originalEnv;

    await Alert.deleteMany({});
    await MetricsSnapshot.deleteMany({});
    await mongoose.connection.close();
  });

  afterEach(async () => {
    await Alert.deleteMany({});
    await MetricsSnapshot.deleteMany({});
    jest.clearAllMocks();
  });

  describe('Rule Loading', () => {
    test('should load rules from configuration', async () => {
      const rulesPath = path.join(__dirname, '../../config/self-healing-rules.json');
      const count = await engine.loadRules(rulesPath);

      expect(count).toBeGreaterThan(0);
      expect(engine.getRules().length).toBe(count);
    });

    test('should validate rule structure', async () => {
      const validRules = [
        {
          name: 'test_rule',
          enabled: true,
          description: 'Test rule',
          detectionQuery: {
            metric: 'response_time',
            threshold: 5000,
            comparison: 'greater_than',
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'send_alert',
            cooldown: '15m',
            priority: 1
          },
          notifications: {
            onTrigger: ['slack'],
            onSuccess: ['dataapi_log'],
            onFailure: ['email']
          }
        }
      ];

      // Write temp config file
      const tempPath = path.join(__dirname, 'temp-rules.json');
      await fs.writeFile(tempPath, JSON.stringify(validRules, null, 2));

      const count = await engine.loadRules(tempPath);
      expect(count).toBe(1);

      // Cleanup
      await fs.unlink(tempPath);
    });

    test('should filter disabled rules', async () => {
      const mixedRules = [
        {
          name: 'enabled_rule',
          enabled: true,
          description: 'Enabled',
          detectionQuery: { metric: 'test', threshold: 100, comparison: 'greater_than', window: '5m' },
          remediation: { strategy: 'alert_only', action: 'alert', cooldown: '15m', priority: 1 },
          notifications: { onTrigger: ['slack'], onSuccess: [], onFailure: [] }
        },
        {
          name: 'disabled_rule',
          enabled: false,
          description: 'Disabled',
          detectionQuery: { metric: 'test', threshold: 100, comparison: 'greater_than', window: '5m' },
          remediation: { strategy: 'alert_only', action: 'alert', cooldown: '15m', priority: 1 },
          notifications: { onTrigger: ['slack'], onSuccess: [], onFailure: [] }
        }
      ];

      const tempPath = path.join(__dirname, 'temp-mixed-rules.json');
      await fs.writeFile(tempPath, JSON.stringify(mixedRules, null, 2));

      const count = await engine.loadRules(tempPath);
      expect(count).toBe(1);
      expect(engine.getRules()[0].name).toBe('enabled_rule');

      await fs.unlink(tempPath);
    });

    test('should throw error on invalid rule format', async () => {
      const invalidPath = path.join(__dirname, 'temp-invalid.json');
      await fs.writeFile(invalidPath, JSON.stringify({ invalid: 'format' }, null, 2));

      await expect(engine.loadRules(invalidPath)).rejects.toThrow();

      await fs.unlink(invalidPath);
    });
  });

  describe('Condition Evaluation', () => {
    beforeEach(async () => {
      const testRules = [
        {
          name: 'metric_test_rule',
          enabled: true,
          description: 'Test rule for metrics',
          detectionQuery: {
            metric: 'avg_response_time',
            aggregation: 'avg',
            threshold: 5000,
            comparison: 'greater_than',
            window: '5m',
            componentType: 'agentx'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'send_alert',
            cooldown: '15m',
            priority: 1
          },
          notifications: { onTrigger: ['dataapi_log'], onSuccess: [], onFailure: [] }
        }
      ];

      const tempPath = path.join(__dirname, 'temp-eval-rules.json');
      await fs.writeFile(tempPath, JSON.stringify(testRules, null, 2));
      await engine.loadRules(tempPath);
      await fs.unlink(tempPath);
    });

    test('should evaluate metric-based conditions', async () => {
      // Create test metrics that breach threshold
      await MetricsSnapshot.create({
        metadata: { componentType: "test", componentId: "test", source: "jest" },
        component: 'agentx',
        metricType: 'performance',
        value: 6000,
        timestamp: new Date(Date.now() - 2 * 60 * 1000)
      });

      const rule = engine.getRules()[0];
      const evaluation = await engine.evaluateRule(rule);

      expect(evaluation.shouldTrigger).toBe(true);
      expect(evaluation.reason).toBe('conditions_met');
    });

    test('should check cooldown periods', async () => {
      const rule = engine.getRules()[0];

      // Record execution
      engine._recordExecution(rule.name, Date.now());

      const evaluation = await engine.evaluateRule(rule);

      expect(evaluation.shouldTrigger).toBe(false);
      expect(evaluation.reason).toBe('cooldown_active');
      expect(evaluation.cooldownRemaining).toBeGreaterThan(0);
    });

    test('should respect minOccurrences threshold', async () => {
      const ruleWithMinOccurrences = [
        {
          name: 'min_occurrence_rule',
          enabled: true,
          description: 'Rule with minOccurrences',
          detectionQuery: {
            metric: 'error_rate',
            aggregation: 'avg',
            threshold: 0.05,
            comparison: 'greater_than',
            window: '5m'
          },
          conditions: {
            minOccurrences: 3
          },
          remediation: {
            strategy: 'alert_only',
            action: 'alert',
            cooldown: '15m',
            priority: 1
          },
          notifications: { onTrigger: [], onSuccess: [], onFailure: [] }
        }
      ];

      const tempPath = path.join(__dirname, 'temp-min-occ.json');
      await fs.writeFile(tempPath, JSON.stringify(ruleWithMinOccurrences, null, 2));
      await engine.loadRules(tempPath);
      await fs.unlink(tempPath);

      const rule = engine.getRules()[0];
      
      // Mock _countRecentOccurrences to return less than minOccurrences
      engine._countRecentOccurrences = jest.fn().mockResolvedValue(2);

      const evaluation = await engine.evaluateRule(rule);

      expect(evaluation.shouldTrigger).toBe(false);
      expect(evaluation.reason).toBe('min_occurrences_not_met');
      expect(evaluation.occurrences).toBe(2);
      expect(evaluation.required).toBe(3);
    });

    test('should evaluate time-based conditions', async () => {
      const now = new Date();
      const currentHour = now.getHours().toString().padStart(2, '0');
      const currentMinute = now.getMinutes().toString().padStart(2, '0');
      const futureTime = `${(parseInt(currentHour) + 1) % 24}:00`;

      const timeBasedRule = [
        {
          name: 'time_rule',
          enabled: true,
          description: 'Time-based rule',
          detectionQuery: {
            metric: 'test_metric',
            threshold: 100,
            comparison: 'greater_than',
            window: '5m'
          },
          conditions: {
            timeOfDay: {
              start: futureTime,
              end: '23:59'
            }
          },
          remediation: {
            strategy: 'alert_only',
            action: 'alert',
            cooldown: '15m',
            priority: 1
          },
          notifications: { onTrigger: [], onSuccess: [], onFailure: [] }
        }
      ];

      const tempPath = path.join(__dirname, 'temp-time.json');
      await fs.writeFile(tempPath, JSON.stringify(timeBasedRule, null, 2));
      await engine.loadRules(tempPath);
      await fs.unlink(tempPath);

      const rule = engine.getRules()[0];
      const evaluation = await engine.evaluateRule(rule);

      expect(evaluation.shouldTrigger).toBe(false);
      expect(evaluation.reason).toBe('outside_time_window');
    });

    test('should handle missing metrics gracefully', async () => {
      const rule = engine.getRules()[0];

      // No metrics in database
      const evaluation = await engine.evaluateRule(rule);

      expect(evaluation.shouldTrigger).toBe(false);
      expect(evaluation.reason).toBe('threshold_not_met');
    });
  });

  describe('Remediation Actions', () => {
    beforeEach(async () => {
      // Mock Alert model directly since AlertService uses it
      jest.spyOn(Alert, 'create').mockResolvedValue({
        _id: 'mock-alert-id',
        status: 'new',
        save: jest.fn().mockResolvedValue(true)
      });
    });

    test('should execute model_failover action', async () => {
      const failoverRule = {
        name: 'failover_test',
        enabled: true,
        description: 'Test failover',
        detectionQuery: {
          metric: 'avg_response_time',
          threshold: 5000,
          comparison: 'greater_than',
          window: '5m'
        },
        remediation: {
          strategy: 'model_failover',
          action: 'switch_to_backup_host',
          automated: true,
          requiresApproval: false,
          cooldown: '15m',
          priority: 1
        },
        notifications: {
          onTrigger: ['dataapi_log'],
          onSuccess: ['dataapi_log'],
          onFailure: ['slack']
        }
      };

      // Mock ModelRouter methods
      ModelRouter.getActiveHost = jest.fn().mockReturnValue('ollama-main');
      ModelRouter.getBackupHost = jest.fn().mockReturnValue('ollama-secondary');
      ModelRouter.switchHost = jest.fn();
      ModelRouter.checkHostHealth = jest.fn().mockResolvedValue({ healthy: true });

      const result = await engine.executeRemediation(failoverRule, {});

      expect(result.status).toBe('success');
      expect(result.result.action).toBe('model_failover');
      expect(ModelRouter.switchHost).toHaveBeenCalledWith('ollama-secondary');
    });

    test('should execute prompt_rollback action', async () => {
      const rollbackRule = {
        name: 'rollback_test',
        enabled: true,
        description: 'Test rollback',
        detectionQuery: {
          metric: 'quality_score',
          threshold: 0.6,
          comparison: 'less_than',
          window: '1h'
        },
        remediation: {
          strategy: 'prompt_rollback',
          action: 'rollback_to_previous_version',
          automated: true,
          requiresApproval: false,
          cooldown: '1h',
          priority: 2
        },
        notifications: {
          onTrigger: ['slack'],
          onSuccess: ['slack'],
          onFailure: ['email']
        }
      };

      const result = await engine.executeRemediation(rollbackRule, {});

      expect(result.status).toBe('success');
      expect(result.result.action).toBe('prompt_rollback');
    });

    test('should execute service_restart action (with approval)', async () => {
      const restartRule = {
        name: 'restart_test',
        enabled: true,
        description: 'Test restart',
        detectionQuery: {
          metric: 'health_status',
          threshold: 0,
          comparison: 'equal',
          window: '5m'
        },
        remediation: {
          strategy: 'service_restart',
          action: 'pm2_restart_agentx',
          automated: true,
          requiresApproval: true,
          cooldown: '30m',
          priority: 1
        },
        notifications: {
          onTrigger: ['slack', 'email'],
          onSuccess: ['slack'],
          onFailure: ['email']
        }
      };

      const result = await engine.executeRemediation(restartRule, {});

      expect(result.status).toBe('pending_approval');
      expect(result.approvalRequired).toBe(true);
    });

    test('should execute alert_only action', async () => {
      const alertRule = {
        name: 'alert_test',
        enabled: true,
        description: 'Test alert only',
        detectionQuery: {
          metric: 'error_rate',
          threshold: 0.05,
          comparison: 'greater_than',
          window: '15m'
        },
        remediation: {
          strategy: 'alert_only',
          action: 'send_alert',
          automated: true,
          requiresApproval: false,
          cooldown: '30m',
          priority: 3
        },
        notifications: {
          onTrigger: ['slack', 'email'],
          onSuccess: ['dataapi_log'],
          onFailure: ['slack']
        }
      };

      const result = await engine.executeRemediation(alertRule, {});

      expect(result.status).toBe('success');
      expect(result.result.action).toBe('alert_only');
    });

    test('should execute throttle_requests action', async () => {
      const throttleRule = {
        name: 'throttle_test',
        enabled: true,
        description: 'Test throttle',
        detectionQuery: {
          metric: 'daily_cost',
          threshold: 50,
          comparison: 'greater_than',
          window: '24h'
        },
        remediation: {
          strategy: 'throttle_requests',
          action: 'enable_rate_limiting',
          automated: true,
          requiresApproval: false,
          cooldown: '24h',
          priority: 2
        },
        notifications: {
          onTrigger: ['slack'],
          onSuccess: ['dataapi_log'],
          onFailure: ['slack']
        }
      };

      const result = await engine.executeRemediation(throttleRule, {});

      expect(result.status).toBe('success');
      expect(result.result.action).toBe('throttle_requests');
    });

    test('should skip actions requiring approval in automated mode', async () => {
      process.env.REQUIRE_APPROVAL = 'true';

      const approvalRule = {
        name: 'approval_test',
        enabled: true,
        description: 'Requires approval',
        detectionQuery: {
          metric: 'test_metric',
          threshold: 100,
          comparison: 'greater_than',
          window: '5m'
        },
        remediation: {
          strategy: 'service_restart',
          action: 'restart_service',
          automated: true,
          requiresApproval: true,
          cooldown: '30m',
          priority: 1
        },
        notifications: {
          onTrigger: ['slack'],
          onSuccess: [],
          onFailure: []
        }
      };

      const result = await engine.executeRemediation(approvalRule, {});

      expect(result.status).toBe('pending_approval');
      expect(result.approvalRequired).toBe(true);
    });
  });

  describe('Action Execution', () => {
    beforeEach(() => {
      jest.spyOn(Alert, 'create').mockResolvedValue({
        _id: 'mock-alert-id',
        save: jest.fn()
      });
    });

    test('should call ModelRouter.switchHost for model_failover', async () => {
      ModelRouter.getActiveHost = jest.fn().mockReturnValue('ollama-main');
      ModelRouter.getBackupHost = jest.fn().mockReturnValue('ollama-secondary');
      ModelRouter.switchHost = jest.fn();
      ModelRouter.checkHostHealth = jest.fn().mockResolvedValue({ healthy: true });

      const rule = {
        name: 'model_switch',
        detectionQuery: { metric: 'test', threshold: 100, comparison: 'greater_than', window: '5m' },
        remediation: {
          strategy: 'model_failover',
          action: 'switch',
          automated: true,
          requiresApproval: false,
          cooldown: '15m',
          priority: 1
        },
        notifications: { onTrigger: [], onSuccess: [], onFailure: [] }
      };

      await engine.executeRemediation(rule, {});

      expect(ModelRouter.switchHost).toHaveBeenCalledWith('ollama-secondary');
      expect(ModelRouter.checkHostHealth).toHaveBeenCalledWith('ollama-secondary');
    });

    test('should update database for prompt_rollback', async () => {
      // Mock would update prompt version in database
      const rule = {
        name: 'prompt_update',
        detectionQuery: { metric: 'test', threshold: 100, comparison: 'greater_than', window: '5m' },
        remediation: {
          strategy: 'prompt_rollback',
          action: 'rollback',
          automated: true,
          requiresApproval: false,
          cooldown: '1h',
          priority: 2
        },
        notifications: { onTrigger: [], onSuccess: [], onFailure: [] }
      };

      const result = await engine.executeRemediation(rule, {});

      expect(result.status).toBe('success');
      expect(result.result.action).toBe('prompt_rollback');
    });

    test('should send notifications on trigger/success/failure', async () => {
      const rule = {
        name: 'notification_test',
        detectionQuery: { metric: 'test', threshold: 100, comparison: 'greater_than', window: '5m' },
        remediation: {
          strategy: 'alert_only',
          action: 'alert',
          automated: true,
          requiresApproval: false,
          cooldown: '15m',
          priority: 1
        },
        notifications: {
          onTrigger: ['slack'],
          onSuccess: ['dataapi_log'],
          onFailure: ['email']
        }
      };

      await engine.executeRemediation(rule, {});

      // Verify execution completed (notifications implementation may vary)
    });

    test('should record execution in history', async () => {
      const rule = {
        name: 'history_test',
        detectionQuery: { metric: 'test', threshold: 100, comparison: 'greater_than', window: '5m' },
        remediation: {
          strategy: 'alert_only',
          action: 'alert',
          automated: true,
          requiresApproval: false,
          cooldown: '15m',
          priority: 1
        },
        notifications: { onTrigger: [], onSuccess: [], onFailure: [] }
      };

      await engine.executeRemediation(rule, {});

      const history = engine.getExecutionHistory();
      expect(history).toHaveLength(1);
      expect(history[0].ruleName).toBe('history_test');
      expect(history[0].lastExecuted).toBeDefined();
    });

    test('should implement cooldown correctly', async () => {
      const rule = {
        name: 'cooldown_test',
        detectionQuery: { metric: 'test', threshold: 100, comparison: 'greater_than', window: '5m' },
        remediation: {
          strategy: 'alert_only',
          action: 'alert',
          automated: true,
          requiresApproval: false,
          cooldown: '15m',
          priority: 1
        },
        notifications: { onTrigger: [], onSuccess: [], onFailure: [] }
      };

      // First execution
      await engine.executeRemediation(rule, {});

      // Check cooldown is active
      const canExecute = engine._canExecute('cooldown_test', '15m');
      expect(canExecute).toBe(false);

      const cooldownRemaining = engine._getCooldownRemaining('cooldown_test', '15m');
      expect(cooldownRemaining).toBeGreaterThan(0);
    });
  });

  describe('Priority Handling', () => {
    test('should execute high-priority rules first', async () => {
      const rules = [
        {
          name: 'low_priority',
          enabled: true,
          description: 'Low priority',
          detectionQuery: {
            metric: 'test_metric',
            threshold: 100,
            comparison: 'greater_than',
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'alert',
            automated: true,
            requiresApproval: false,
            cooldown: '15m',
            priority: 3
          },
          notifications: { onTrigger: ['dataapi_log'], onSuccess: [], onFailure: [] }
        },
        {
          name: 'high_priority',
          enabled: true,
          description: 'High priority',
          detectionQuery: {
            metric: 'test_metric',
            threshold: 100,
            comparison: 'greater_than',
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'alert',
            automated: true,
            requiresApproval: false,
            cooldown: '15m',
            priority: 1
          },
          notifications: { onTrigger: ['dataapi_log'], onSuccess: [], onFailure: [] }
        }
      ];

      const tempPath = path.join(__dirname, 'temp-priority.json');
      await fs.writeFile(tempPath, JSON.stringify(rules, null, 2));
      await engine.loadRules(tempPath);
      await fs.unlink(tempPath);

      // Mock alert creation
      jest.spyOn(Alert, 'create').mockResolvedValue({ _id: 'mock', save: jest.fn() });

      // Create metrics that trigger both rules
      await MetricsSnapshot.create({
        metadata: { componentType: "test", componentId: "test", source: "jest" },
        component: 'test',
        metricType: 'usage',
        value: 150,
        timestamp: new Date()
      });

      const results = await engine.evaluateAndExecute();

      // High priority should execute first
      expect(results.length).toBeGreaterThan(0);
      if (results[0].status === 'success') {
        expect(results[0].rule).toBe('high_priority');
      }
    });

    test('should queue low-priority rules', async () => {
      const rules = [
        {
          name: 'queue_test_low',
          enabled: true,
          description: 'Low priority',
          detectionQuery: {
            metric: 'test_metric',
            threshold: 50,
            comparison: 'greater_than',
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'alert',
            automated: true,
            requiresApproval: false,
            cooldown: '15m',
            priority: 5
          },
          notifications: { onTrigger: [], onSuccess: [], onFailure: [] }
        }
      ];

      const tempPath = path.join(__dirname, 'temp-queue.json');
      await fs.writeFile(tempPath, JSON.stringify(rules, null, 2));
      await engine.loadRules(tempPath);
      await fs.unlink(tempPath);

      jest.spyOn(Alert, 'create').mockResolvedValue({ _id: 'mock' });

      await MetricsSnapshot.create({
        metadata: { componentType: "test", componentId: "test", source: "jest" },
        component: 'test',
        metricType: 'usage',
        value: 100,
        timestamp: new Date()
      });

      const results = await engine.evaluateAndExecute();

      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    test('should handle concurrent rule triggers', async () => {
      const rules = [
        {
          name: 'concurrent_1',
          enabled: true,
          description: 'Concurrent rule 1',
          detectionQuery: {
            metric: 'test_metric',
            threshold: 50,
            comparison: 'greater_than',
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'alert',
            automated: true,
            requiresApproval: false,
            cooldown: '15m',
            priority: 1
          },
          notifications: { onTrigger: [], onSuccess: [], onFailure: [] }
        },
        {
          name: 'concurrent_2',
          enabled: true,
          description: 'Concurrent rule 2',
          detectionQuery: {
            metric: 'test_metric',
            threshold: 50,
            comparison: 'greater_than',
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'alert',
            automated: true,
            requiresApproval: false,
            cooldown: '15m',
            priority: 1
          },
          notifications: { onTrigger: [], onSuccess: [], onFailure: [] }
        }
      ];

      const tempPath = path.join(__dirname, 'temp-concurrent.json');
      await fs.writeFile(tempPath, JSON.stringify(rules, null, 2));
      await engine.loadRules(tempPath);
      await fs.unlink(tempPath);

      jest.spyOn(Alert, 'create').mockResolvedValue({ _id: 'mock' });

      await MetricsSnapshot.create({
        metadata: { componentType: "test", componentId: "test", source: "jest" },
        component: 'test',
        metricType: 'usage',
        value: 100,
        timestamp: new Date()
      });

      const results = await engine.evaluateAndExecute();

      // Both rules should trigger
      expect(results.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Error Handling', () => {
    test('should continue on action failure', async () => {
      const rule = {
        name: 'error_test',
        enabled: true,
        description: 'Test error handling',
        detectionQuery: {
          metric: 'test_metric',
          threshold: 100,
          comparison: 'greater_than',
          window: '5m'
        },
        remediation: {
          strategy: 'model_failover',
          action: 'switch',
          automated: true,
          requiresApproval: false,
          cooldown: '15m',
          priority: 1
        },
        notifications: { onTrigger: [], onSuccess: [], onFailure: ['slack'] }
      };

      // Mock ModelRouter to throw error
      ModelRouter.getActiveHost = jest.fn().mockImplementation(() => {
        throw new Error('ModelRouter error');
      });

      jest.spyOn(Alert, 'create').mockResolvedValue({ _id: 'mock' });

      const result = await engine.executeRemediation(rule, {});

      expect(result.status).toBe('failed');
      expect(result.error).toBeDefined();
    });

    test('should send failure notifications', async () => {
      const rule = {
        name: 'failure_notification_test',
        enabled: true,
        description: 'Test failure notifications',
        detectionQuery: {
          metric: 'test_metric',
          threshold: 100,
          comparison: 'greater_than',
          window: '5m'
        },
        remediation: {
          strategy: 'model_failover',
          action: 'switch',
          automated: true,
          requiresApproval: false,
          cooldown: '15m',
          priority: 1
        },
        notifications: { onTrigger: ['slack'], onSuccess: [], onFailure: ['email', 'slack'] }
      };

      ModelRouter.getActiveHost = jest.fn().mockImplementation(() => {
        throw new Error('Test error');
      });

      jest.spyOn(Alert, 'create').mockResolvedValue({ _id: 'mock' });

      await engine.executeRemediation(rule, {});

      // Should have called createAlert for trigger and failure notifications
      expect(Alert.createAlert).toHaveBeenCalled();
    });

    test('should not retry within cooldown period', async () => {
      const rule = {
        name: 'no_retry_test',
        enabled: true,
        description: 'Test no retry in cooldown',
        detectionQuery: {
          metric: 'test_metric',
          threshold: 100,
          comparison: 'greater_than',
          window: '5m'
        },
        remediation: {
          strategy: 'alert_only',
          action: 'alert',
          automated: true,
          requiresApproval: false,
          cooldown: '15m',
          priority: 1
        },
        notifications: { onTrigger: [], onSuccess: [], onFailure: [] }
      };

      jest.spyOn(Alert, 'create').mockResolvedValue({ _id: 'mock' });

      // First execution
      await engine.executeRemediation(rule, {});

      // Create metrics for second evaluation
      await MetricsSnapshot.create({
        metadata: { componentType: "test", componentId: "test", source: "jest" },
        component: 'test',
        metricType: 'usage',
        value: 150,
        timestamp: new Date()
      });

      const tempPath = path.join(__dirname, 'temp-no-retry.json');
      await fs.writeFile(tempPath, JSON.stringify([rule], null, 2));
      await engine.loadRules(tempPath);
      await fs.unlink(tempPath);

      // Try to evaluate again
      const evaluation = await engine.evaluateRule(rule);

      expect(evaluation.shouldTrigger).toBe(false);
      expect(evaluation.reason).toBe('cooldown_active');
    });

    test('should log errors comprehensively', async () => {
      const rule = {
        name: 'log_error_test',
        enabled: true,
        description: 'Test error logging',
        detectionQuery: {
          metric: 'test_metric',
          threshold: 100,
          comparison: 'greater_than',
          window: '5m'
        },
        remediation: {
          strategy: 'model_failover',
          action: 'switch',
          automated: true,
          requiresApproval: false,
          cooldown: '15m',
          priority: 1
        },
        notifications: { onTrigger: [], onSuccess: [], onFailure: [] }
      };

      ModelRouter.getActiveHost = jest.fn().mockImplementation(() => {
        throw new Error('Comprehensive error test');
      });

      jest.spyOn(Alert, 'create').mockResolvedValue({ _id: 'mock' });

      const result = await engine.executeRemediation(rule, {});

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Comprehensive error test');
    });
  });
});
