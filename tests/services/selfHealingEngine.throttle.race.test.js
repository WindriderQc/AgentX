const SelfHealingEngine = require('../../src/services/selfHealingEngine');
const mongoose = require('mongoose');

/**
 * Race Condition Tests for Self-Healing Engine Throttle
 *
 * Tests the fix for Race #3: Global throttle state race conditions
 * that occur when multiple throttle actions are triggered close together
 */
describe('SelfHealingEngine - Throttle Race Condition Fix', () => {
  let engine;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/agentx_test', {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
    }

    engine = SelfHealingEngine;
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  beforeEach(() => {
    // Clear global throttle state
    delete global._selfHealingThrottle;
    delete global._selfHealingThrottleTimeout;
  });

  afterEach(() => {
    // Clean up any timeouts
    if (global._selfHealingThrottleTimeout) {
      clearTimeout(global._selfHealingThrottleTimeout);
    }
  });

  describe('Token versioning', () => {
    test('should generate unique token for each throttle activation', async () => {
      const rule = {
        name: 'test_throttle_rule',
        remediation: {
          strategy: 'throttle_requests',
          action: 'Enable request throttling'
        },
        notifications: {}
      };

      // Execute throttle twice
      const result1 = await engine._executeThrottle(rule, {});
      const result2 = await engine._executeThrottle(rule, {});

      expect(result1.token).toBeDefined();
      expect(result2.token).toBeDefined();
      expect(result1.token).not.toBe(result2.token);
    });

    test('should update global throttle state with new token', async () => {
      const rule = {
        name: 'token_test_rule',
        remediation: {
          strategy: 'throttle_requests',
          action: 'Enable throttling'
        },
        notifications: {}
      };

      const result = await engine._executeThrottle(rule, {});

      expect(global._selfHealingThrottle).toBeDefined();
      expect(global._selfHealingThrottle.token).toBe(result.token);
      expect(global._selfHealingThrottle.enabled).toBe(true);
    });

    test('should clear previous timeout when new throttle is activated', async () => {
      const rule = {
        name: 'clear_timeout_rule',
        remediation: {
          strategy: 'throttle_requests',
          action: 'Enable throttling'
        },
        notifications: {}
      };

      // First throttle
      await engine._executeThrottle(rule, {});
      const firstTimeout = global._selfHealingThrottleTimeout;

      // Second throttle (should clear first timeout)
      await engine._executeThrottle(rule, {});
      const secondTimeout = global._selfHealingThrottleTimeout;

      expect(firstTimeout).toBeDefined();
      expect(secondTimeout).toBeDefined();
      expect(firstTimeout).not.toBe(secondTimeout);
    });
  });

  describe('Concurrent throttle activation', () => {
    test('should handle rapid successive throttle activations', async () => {
      const rule = {
        name: 'rapid_throttle_rule',
        remediation: {
          strategy: 'throttle_requests',
          action: 'Enable throttling'
        },
        notifications: {}
      };

      // Execute 5 throttles in rapid succession
      const results = await Promise.all([
        engine._executeThrottle(rule, {}),
        engine._executeThrottle(rule, {}),
        engine._executeThrottle(rule, {}),
        engine._executeThrottle(rule, {}),
        engine._executeThrottle(rule, {})
      ]);

      // All should succeed
      expect(results.every(r => r.action === 'throttle_requests')).toBe(true);

      // Final state should match last execution
      const lastToken = results[results.length - 1].token;
      expect(global._selfHealingThrottle.token).toBe(lastToken);
      expect(global._selfHealingThrottle.enabled).toBe(true);
    });

    test('should prevent premature throttle disabling from old timeouts', async () => {
      const rule1 = {
        name: 'throttle_rule_1',
        remediation: {
          strategy: 'throttle_requests',
          action: 'Enable throttling - short duration'
        },
        notifications: {}
      };

      const rule2 = {
        name: 'throttle_rule_2',
        remediation: {
          strategy: 'throttle_requests',
          action: 'Enable throttling - long duration'
        },
        notifications: {}
      };

      // Activate first throttle
      const result1 = await engine._executeThrottle(rule1, {});

      // Small delay
      await new Promise(resolve => setTimeout(resolve, 10));

      // Activate second throttle (should override first)
      const result2 = await engine._executeThrottle(rule2, {});

      // Current state should be from second throttle
      expect(global._selfHealingThrottle.token).toBe(result2.token);
      expect(global._selfHealingThrottle.reason).toBe('throttle_rule_2');

      // Verify tokens are different
      expect(result1.token).not.toBe(result2.token);
    });

    test('should maintain throttle state integrity under concurrent updates', async () => {
      const createRule = (name) => ({
        name: `throttle_rule_${name}`,
        remediation: {
          strategy: 'throttle_requests',
          action: `Throttle ${name}`
        },
        notifications: {}
      });

      // Execute 10 concurrent throttle activations
      const promises = Array(10).fill(null).map((_, i) =>
        engine._executeThrottle(createRule(i), {})
      );

      const results = await Promise.all(promises);

      // All should have unique tokens
      const tokens = results.map(r => r.token);
      const uniqueTokens = new Set(tokens);
      expect(uniqueTokens.size).toBe(10);

      // Final state should have one of the tokens
      expect(tokens).toContain(global._selfHealingThrottle.token);

      // Throttle should be enabled
      expect(global._selfHealingThrottle.enabled).toBe(true);
    });
  });

  describe('Throttle lifecycle', () => {
    test('should preserve throttle configuration during updates', async () => {
      const rule = {
        name: 'lifecycle_test_rule',
        remediation: {
          strategy: 'throttle_requests',
          action: 'Enable throttling'
        },
        notifications: {}
      };

      const result = await engine._executeThrottle(rule, {});

      // Verify all configuration is preserved
      expect(global._selfHealingThrottle).toMatchObject({
        enabled: true,
        token: result.token,
        reductionFactor: 0.5,
        reason: 'lifecycle_test_rule',
        originalLimits: {
          chat: 20,
          api: 100
        }
      });

      expect(global._selfHealingThrottle.appliedAt).toBeDefined();
      expect(global._selfHealingThrottle.expiresAt).toBeDefined();
    });

    test('should calculate correct expiration time', async () => {
      const rule = {
        name: 'expiration_test_rule',
        remediation: {
          strategy: 'throttle_requests',
          action: 'Enable throttling'
        },
        notifications: {}
      };

      const beforeExecution = Date.now();
      await engine._executeThrottle(rule, {});
      const afterExecution = Date.now();

      const expectedDuration = 15 * 60 * 1000; // 15 minutes
      const appliedAt = global._selfHealingThrottle.appliedAt;
      const expiresAt = global._selfHealingThrottle.expiresAt;

      expect(appliedAt).toBeGreaterThanOrEqual(beforeExecution);
      expect(appliedAt).toBeLessThanOrEqual(afterExecution);
      expect(expiresAt).toBe(appliedAt + expectedDuration);
    });

    test('should return correct adjusted limits', async () => {
      const rule = {
        name: 'limits_test_rule',
        remediation: {
          strategy: 'throttle_requests',
          action: 'Enable throttling'
        },
        notifications: {}
      };

      const result = await engine._executeThrottle(rule, {});

      expect(result.adjustedLimits).toEqual({
        chat: 10,  // 20 * 0.5
        api: 50    // 100 * 0.5
      });
    });

    test('should track previous throttle state', async () => {
      const rule = {
        name: 'state_tracking_rule',
        remediation: {
          strategy: 'throttle_requests',
          action: 'Enable throttling'
        },
        notifications: {}
      };

      // First activation
      const result1 = await engine._executeThrottle(rule, {});
      expect(result1.previouslyThrottled).toBe(false);

      // Second activation (should show previously throttled)
      const result2 = await engine._executeThrottle(rule, {});
      expect(result2.previouslyThrottled).toBe(true);
    });
  });

  describe('Edge cases', () => {
    test('should handle missing global throttle state gracefully', async () => {
      delete global._selfHealingThrottle;

      const rule = {
        name: 'missing_state_rule',
        remediation: {
          strategy: 'throttle_requests',
          action: 'Enable throttling'
        },
        notifications: {}
      };

      const result = await engine._executeThrottle(rule, {});

      expect(result.action).toBe('throttle_requests');
      expect(global._selfHealingThrottle).toBeDefined();
      expect(global._selfHealingThrottle.enabled).toBe(true);
    });

    test('should handle concurrent reads of throttle state', async () => {
      const rule = {
        name: 'concurrent_read_rule',
        remediation: {
          strategy: 'throttle_requests',
          action: 'Enable throttling'
        },
        notifications: {}
      };

      await engine._executeThrottle(rule, {});

      // Multiple concurrent reads should all see consistent state
      const reads = Array(20).fill(null).map(() =>
        Promise.resolve({
          enabled: global._selfHealingThrottle.enabled,
          token: global._selfHealingThrottle.token,
          reason: global._selfHealingThrottle.reason
        })
      );

      const results = await Promise.all(reads);

      // All reads should have the same values
      const firstResult = results[0];
      expect(results.every(r =>
        r.enabled === firstResult.enabled &&
        r.token === firstResult.token &&
        r.reason === firstResult.reason
      )).toBe(true);
    });
  });

  describe('Regression tests', () => {
    test('should not break when NODE_ENV is test', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';

      const rule = {
        name: 'test_env_rule',
        remediation: {
          strategy: 'throttle_requests',
          action: 'Enable throttling'
        },
        notifications: {}
      };

      const result = await engine._executeThrottle(rule, {});

      expect(result.action).toBe('throttle_requests');
      expect(result.enabled).toBe(true);

      // Timeout should not be set in test mode
      expect(global._selfHealingThrottleTimeout).toBeUndefined();

      process.env.NODE_ENV = originalEnv;
    });

    test('should maintain backward compatibility with old throttle checks', async () => {
      const rule = {
        name: 'compat_rule',
        remediation: {
          strategy: 'throttle_requests',
          action: 'Enable throttling'
        },
        notifications: {}
      };

      await engine._executeThrottle(rule, {});

      // Old code checking for enabled flag should still work
      expect(global._selfHealingThrottle.enabled).toBe(true);

      // Old code checking for reason should still work
      expect(global._selfHealingThrottle.reason).toBe('compat_rule');

      // Old code checking for expiration should still work
      expect(global._selfHealingThrottle.expiresAt).toBeDefined();
      expect(global._selfHealingThrottle.expiresAt).toBeGreaterThan(Date.now());
    });
  });
});
