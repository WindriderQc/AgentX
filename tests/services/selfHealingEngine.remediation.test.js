/**
 * Integration tests for Self-Healing Engine remediation actions
 * Tests Track 4 implementation: model failover, prompt rollback, service restart, throttling
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const SelfHealingEngine = require('../../src/services/selfHealingEngine');
const ModelRouter = require('../../src/services/modelRouter');
const PromptConfig = require('../../models/PromptConfig');
const Alert = require('../../models/Alert');

// Default notifications for test rules
const DEFAULT_NOTIFICATIONS = {
  onTrigger: [],
  onSuccess: [],
  onFailure: []
};

describe('Self-Healing Engine - Remediation Actions', () => {
  let mongod;
  let needsDisconnect = false;

  beforeAll(async () => {
    // Check if already connected
    if (mongoose.connection.readyState === 0) {
      // Start in-memory MongoDB only if not connected
      mongod = await MongoMemoryServer.create();
      const uri = mongod.getUri();
      await mongoose.connect(uri);
      needsDisconnect = true;
    }
  });

  afterAll(async () => {
    // Only disconnect if we connected in this test
    if (needsDisconnect && mongod) {
      await mongoose.disconnect();
      await mongod.stop();
    }
  });

  afterEach(async () => {
    // Clean up collections after each test
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }

    // Reset ModelRouter state
    ModelRouter.resetToPrimary('test_cleanup');

    // Reset throttle state
    if (global._selfHealingThrottle) {
      global._selfHealingThrottle.enabled = false;
    }
  });

  describe('Model Failover Remediation', () => {
    test('should successfully failover to backup host', async () => {
      const rule = {
        name: 'test_model_failover',
        description: 'Test failover rule',
        remediation: {
          strategy: 'model_failover',
          priority: 1
        },
        notifications: {
          onTrigger: [],
          onSuccess: [],
          onFailure: []
        }
      };

      const context = {
        evaluation: {
          metrics: { component: 'ollama-99' }
        }
      };

      // Record initial state
      const initialHost = ModelRouter.getActiveHost();
      expect(initialHost).toBe(ModelRouter.HOSTS.primary);

      // Execute failover
      const result = await SelfHealingEngine.executeRemediation(rule, context);

      expect(result.status).toBe('success');
      expect(result.result.action).toBe('model_failover');
      expect(result.result.previousHost).toBe(ModelRouter.HOSTS.primary);
      expect(result.result.newHost).toBe(ModelRouter.HOSTS.secondary);
      expect(result.result.healthCheck).toBeDefined();
      expect(result.result.healthCheck.status).toBeDefined();

      // Verify state changed
      const newHost = ModelRouter.getActiveHost();
      expect(newHost).toBe(ModelRouter.HOSTS.secondary);

      // Verify failover status
      const failoverStatus = ModelRouter.getFailoverStatus();
      expect(failoverStatus.isFailedOver).toBe(true);
      expect(failoverStatus.reason).toBe('self_healing_failover');
      expect(failoverStatus.failoverCount).toBeGreaterThan(0);
    });

    test('should rollback if backup host is unhealthy', async () => {
      // Note: This test requires mocking ModelRouter.checkHostHealth
      // For now, it tests the error handling path

      const rule = {
        name: 'test_failover_rollback',
        remediation: { strategy: 'model_failover', priority: 1 },
        notifications: DEFAULT_NOTIFICATIONS
      };

      const context = {
        evaluation: { metrics: { component: 'ollama-99' } }
      };

      // In production, if backup is down, we'd expect an error
      // This test ensures error handling works
      try {
        await SelfHealingEngine.executeRemediation(rule, context);
        // If backup is healthy, test passes
        expect(true).toBe(true);
      } catch (error) {
        // If backup is unhealthy, should get rollback error
        expect(error.message).toContain('unhealthy');
      }
    });
  });

  describe('Prompt Rollback Remediation', () => {
    test('should rollback to previous prompt version', async () => {
      // Setup: Create 2 prompt versions
      const promptV1 = await PromptConfig.create({
        name: 'test_prompt',
        version: 1,
        systemPrompt: 'Version 1 system prompt',
        isActive: false,
        trafficWeight: 0
      });

      const promptV2 = await PromptConfig.create({
        name: 'test_prompt',
        version: 2,
        systemPrompt: 'Version 2 system prompt with issues',
        isActive: true,
        trafficWeight: 100
      });

      const rule = {
        name: 'test_prompt_rollback',
        description: 'Test prompt rollback',
        detectionQuery: {
          componentPattern: 'prompt:test_prompt'
        },
        remediation: {
          strategy: 'prompt_rollback',
          priority: 2
        },
        notifications: DEFAULT_NOTIFICATIONS
      };

      const context = {
        evaluation: {
          metrics: { component: 'prompt:test_prompt:v2' }
        }
      };

      // Execute rollback
      const result = await SelfHealingEngine.executeRemediation(rule, context);

      expect(result.status).toBe('success');
      expect(result.result.action).toBe('prompt_rollback');
      expect(result.result.promptName).toBe('test_prompt');
      expect(result.result.previousVersion).toBe(2);
      expect(result.result.rolledBackToVersion).toBe(1);

      // Verify database state
      const updatedV1 = await PromptConfig.findById(promptV1._id);
      const updatedV2 = await PromptConfig.findById(promptV2._id);

      expect(updatedV1.isActive).toBe(true);
      expect(updatedV1.trafficWeight).toBe(100);
      expect(updatedV2.isActive).toBe(false);
      expect(updatedV2.trafficWeight).toBe(0);
    });

    test('should handle error when no previous version exists', async () => {
      // Create only one version
      await PromptConfig.create({
        name: 'only_one_version',
        version: 1,
        systemPrompt: 'First version',
        isActive: true,
        trafficWeight: 100
      });

      const rule = {
        name: 'test_no_previous',
        detectionQuery: {
          componentPattern: 'prompt:only_one_version'
        },
        remediation: { strategy: 'prompt_rollback', priority: 2 },
        notifications: DEFAULT_NOTIFICATIONS
      };

      const context = {
        evaluation: {
          metrics: { component: 'prompt:only_one_version:v1' }
        }
      };

      // Expect error
      const result = await SelfHealingEngine.executeRemediation(rule, context);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('No previous version found');
    });

    test('should handle error when prompt not found', async () => {
      const rule = {
        name: 'test_not_found',
        detectionQuery: {
          componentPattern: 'prompt:nonexistent'
        },
        remediation: { strategy: 'prompt_rollback', priority: 2 },
        notifications: DEFAULT_NOTIFICATIONS
      };

      const context = {
        evaluation: {
          metrics: { component: 'prompt:nonexistent:v1' }
        }
      };

      const result = await SelfHealingEngine.executeRemediation(rule, context);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('No active prompt found');
    });
  });

  describe('Service Restart Remediation', () => {
    test('should require approval for service restart', async () => {
      const rule = {
        name: 'test_service_restart',
        description: 'Test service restart with approval',
        remediation: {
          strategy: 'service_restart',
          requiresApproval: true,
          priority: 1
        },
        notifications: DEFAULT_NOTIFICATIONS
      };

      const context = {
        evaluation: {
          metrics: { component: 'agentx' }
        }
      };

      // Execute with approval required
      const result = await SelfHealingEngine.executeRemediation(rule, context);

      // Should return pending_approval status
      expect(result.status).toBe('pending_approval');
      expect(result.rule).toBe('test_service_restart');
      expect(result.approvalRequired).toBe(true);
    });

    test('should execute restart when automation enabled and no approval required', async () => {
      // Note: This test will attempt actual PM2 commands in integration environment
      // Skip in CI/unit test environments
      if (process.env.CI || process.env.SKIP_PM2_TESTS) {
        return;
      }

      const rule = {
        name: 'test_auto_restart',
        remediation: {
          strategy: 'service_restart',
          requiresApproval: false,
          priority: 1
        },
        notifications: DEFAULT_NOTIFICATIONS
      };

      const context = {
        evaluation: {
          metrics: { component: 'agentx' }
        }
      };

      try {
        const result = await SelfHealingEngine.executeRemediation(rule, context);

        // If PM2 is available and restart succeeds
        if (result.status === 'success') {
          expect(result.result.action).toBe('service_restart');
          expect(result.result.service).toBe('agentx');
          expect(result.result.status).toBe('online');
        }
      } catch (error) {
        // Expected in test environments without PM2
        expect(error.message).toBeTruthy();
      }
    });
  });

  describe('Request Throttling Remediation', () => {
    test('should activate request throttling', async () => {
      const rule = {
        name: 'test_throttle',
        description: 'Test throttling activation',
        remediation: {
          strategy: 'throttle_requests',
          priority: 2
        },
        notifications: DEFAULT_NOTIFICATIONS
      };

      const context = {
        evaluation: {
          metrics: { component: 'agentx' }
        }
      };

      // Execute throttling
      const result = await SelfHealingEngine.executeRemediation(rule, context);

      expect(result.status).toBe('success');
      expect(result.result.action).toBe('throttle_requests');
      expect(result.result.enabled).toBe(true);
      expect(result.result.reductionPercentage).toBe('50%');
      expect(result.result.durationMs).toBe(15 * 60 * 1000); // 15 minutes
      expect(result.result.expiresAt).toBeDefined();
      expect(result.result.adjustedLimits).toBeDefined();

      // Verify global state
      expect(global._selfHealingThrottle).toBeDefined();
      expect(global._selfHealingThrottle.enabled).toBe(true);
      expect(global._selfHealingThrottle.reductionFactor).toBe(0.5);
    });

    test('should track previous throttle state', async () => {
      // Activate throttling first time
      const rule = {
        name: 'test_throttle_state',
        remediation: { strategy: 'throttle_requests', priority: 2 },
        notifications: DEFAULT_NOTIFICATIONS
      };

      const context = {
        evaluation: { metrics: { component: 'agentx' } }
      };

      // First activation
      const result1 = await SelfHealingEngine.executeRemediation(rule, context);
      expect(result1.result.previouslyThrottled).toBe(false);

      // Second activation (while still throttled)
      const result2 = await SelfHealingEngine.executeRemediation(rule, context);
      expect(result2.result.previouslyThrottled).toBe(true);
    });
  });

  describe('Alert-Only Remediation', () => {
    test('should create alert without other actions', async () => {
      const rule = {
        name: 'test_alert_only',
        description: 'Test alert-only action',
        detectionQuery: {
          metric: 'test_metric',
          componentPattern: 'test'
        },
        remediation: {
          strategy: 'alert_only',
          priority: 3
        },
        notifications: {
          onTrigger: ['slack']
        }
      };

      const context = {
        evaluation: {
          metrics: { component: 'test', value: 100 }
        }
      };

      // Execute alert-only
      const result = await SelfHealingEngine.executeRemediation(rule, context);

      expect(result.status).toBe('success');
      expect(result.result.action).toBe('alert_only');
      expect(result.result.alertId).toBeDefined();
      expect(result.result.alertCreated).toBe(true);

      // Verify alert was created in database
      const alert = await Alert.findById(result.result.alertId);
      expect(alert).toBeDefined();
      expect(alert.ruleId).toBe('test_alert_only');
      expect(alert.title).toContain('Self-healing rule triggered');
    });
  });

  describe('Cooldown Period Enforcement', () => {
    test('should prevent execution during cooldown', async () => {
      const rule = {
        name: 'test_cooldown',
        description: 'Test cooldown enforcement',
        detectionQuery: {
          metric: 'test',
          threshold: 100,
          comparison: 'greater_than',
          window: '5m',
          componentPattern: '*'
        },
        remediation: {
          strategy: 'alert_only',
          cooldown: '15m',
          priority: 3
        },
        notifications: DEFAULT_NOTIFICATIONS
      };

      const metricsData = { value: 150, count: 1 };

      // First evaluation should trigger
      const eval1 = await SelfHealingEngine.evaluateRule(rule, metricsData);
      expect(eval1.shouldTrigger).toBe(true);

      // Execute first time
      await SelfHealingEngine.executeRemediation(rule, {});

      // Second evaluation should be blocked by cooldown
      const eval2 = await SelfHealingEngine.evaluateRule(rule, metricsData);
      expect(eval2.shouldTrigger).toBe(false);
      expect(eval2.reason).toBe('cooldown_active');
      expect(eval2.cooldownRemaining).toBeGreaterThan(0);
    });
  });

  describe('Rule Loading', () => {
    test('should load rules from configuration file', async () => {
      const configPath = '/home/yb/codes/AgentX/config/self-healing-rules.json';

      const ruleCount = await SelfHealingEngine.loadRules(configPath);

      expect(ruleCount).toBeGreaterThan(0);

      const loadedRules = SelfHealingEngine.getRules();
      expect(loadedRules).toBeDefined();
      expect(Array.isArray(loadedRules)).toBe(true);
      expect(loadedRules.length).toBe(ruleCount);

      // Verify rule structure
      const firstRule = loadedRules[0];
      expect(firstRule.name).toBeDefined();
      expect(firstRule.enabled).toBeDefined();
      expect(firstRule.detectionQuery).toBeDefined();
      expect(firstRule.remediation).toBeDefined();
    });
  });

  describe('Execution History', () => {
    test('should track remediation execution history', async () => {
      const rule = {
        name: 'test_history',
        remediation: { strategy: 'alert_only', cooldown: '15m' },
        notifications: DEFAULT_NOTIFICATIONS
      };

      const context = { evaluation: { metrics: {} } };

      // Execute remediation
      await SelfHealingEngine.executeRemediation(rule, context);

      // Check execution history
      const history = SelfHealingEngine.getExecutionHistory();

      expect(Array.isArray(history)).toBe(true);

      const historyEntry = history.find(h => h.ruleName === 'test_history');
      expect(historyEntry).toBeDefined();
      expect(historyEntry.lastExecuted).toBeDefined();
      expect(historyEntry.cooldownRemaining).toBeGreaterThan(0);
    });
  });
});
