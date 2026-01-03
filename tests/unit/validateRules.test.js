const RulesValidator = require('../../src/utils/validateRules');
const fs = require('fs');
const path = require('path');

/**
 * Unit tests for RulesValidator - Track 4: Self-Healing & Automation
 */
describe('RulesValidator', () => {
  let validator;

  beforeAll(() => {
    validator = new RulesValidator();
  });

  describe('Initialization', () => {
    test('should initialize with schema loaded', () => {
      expect(validator.schema).toBeDefined();
      expect(validator.validate).toBeDefined();
    });
  });

  describe('Schema Validation', () => {
    test('should validate a correct rule', () => {
      const rules = [
        {
          name: 'test_rule',
          enabled: true,
          description: 'Test rule',
          detectionQuery: {
            metric: 'response_time',
            aggregation: 'avg',
            threshold: 5000,
            comparison: 'greater_than',
            window: '5m',
            componentType: 'ollama',
            componentPattern: 'ollama-*'
          },
          remediation: {
            strategy: 'model_failover',
            action: 'switch_to_backup',
            description: 'Switch to backup host',
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
        }
      ];

      const result = validator.validateRules(rules);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('should reject rule with missing required fields', () => {
      const rules = [
        {
          name: 'incomplete_rule',
          enabled: true
          // Missing detectionQuery and remediation
        }
      ];

      const result = validator.validateRules(rules);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('should reject rule with invalid enum value', () => {
      const rules = [
        {
          name: 'invalid_enum',
          enabled: true,
          detectionQuery: {
            metric: 'test_metric',
            threshold: 100,
            comparison: 'invalid_comparison', // Invalid enum
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'send_alert'
          }
        }
      ];

      const result = validator.validateRules(rules);

      expect(result.valid).toBe(false);
    });

    test('should reject rule with invalid pattern format', () => {
      const rules = [
        {
          name: 'invalid-name', // Should be snake_case
          enabled: true,
          detectionQuery: {
            metric: 'test_metric',
            threshold: 100,
            comparison: 'greater_than',
            window: 'invalid' // Invalid duration format
          },
          remediation: {
            strategy: 'alert_only',
            action: 'send_alert'
          }
        }
      ];

      const result = validator.validateRules(rules);

      expect(result.valid).toBe(false);
    });
  });

  describe('Logical Validation', () => {
    test('should detect duplicate rule names', () => {
      const rules = [
        {
          name: 'duplicate_name',
          enabled: true,
          detectionQuery: {
            metric: 'metric1',
            threshold: 100,
            comparison: 'greater_than',
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'send_alert'
          }
        },
        {
          name: 'duplicate_name', // Duplicate
          enabled: true,
          detectionQuery: {
            metric: 'metric2',
            threshold: 200,
            comparison: 'greater_than',
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'send_alert'
          }
        }
      ];

      const result = validator.validateRules(rules);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.type === 'duplicate_names')).toBe(true);
    });

    test('should detect invalid threshold type', () => {
      const rules = [
        {
          name: 'invalid_threshold',
          enabled: true,
          detectionQuery: {
            metric: 'test_metric',
            threshold: 'not_a_number', // Should be number
            comparison: 'greater_than',
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'send_alert'
          }
        }
      ];

      const result = validator.validateRules(rules);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.type === 'invalid_threshold')).toBe(true);
    });

    test('should detect invalid cooldown format', () => {
      const rules = [
        {
          name: 'invalid_cooldown',
          enabled: true,
          detectionQuery: {
            metric: 'test_metric',
            threshold: 100,
            comparison: 'greater_than',
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'send_alert',
            cooldown: 'invalid_format' // Invalid duration
          }
        }
      ];

      const result = validator.validateRules(rules);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.type === 'invalid_cooldown')).toBe(true);
    });

    test('should detect invalid priority range', () => {
      const rules = [
        {
          name: 'invalid_priority',
          enabled: true,
          detectionQuery: {
            metric: 'test_metric',
            threshold: 100,
            comparison: 'greater_than',
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'send_alert',
            priority: 15 // Should be 1-10
          }
        }
      ];

      const result = validator.validateRules(rules);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.type === 'invalid_priority')).toBe(true);
    });

    test('should warn about conflicting settings', () => {
      const rules = [
        {
          name: 'conflicting_settings',
          enabled: true,
          detectionQuery: {
            metric: 'test_metric',
            threshold: 100,
            comparison: 'greater_than',
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'send_alert',
            automated: true,
            requiresApproval: true // Conflict: automated + requires approval
          }
        }
      ];

      const result = validator.validateRules(rules);

      expect(result.warnings.some(w => w.type === 'conflicting_settings')).toBe(true);
    });

    test('should warn about missing notifications', () => {
      const rules = [
        {
          name: 'no_notifications',
          enabled: true,
          detectionQuery: {
            metric: 'test_metric',
            threshold: 100,
            comparison: 'greater_than',
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'send_alert'
          }
          // No notifications configured
        }
      ];

      const result = validator.validateRules(rules);

      expect(result.warnings.some(w => w.type === 'no_notifications')).toBe(true);
    });
  });

  describe('Conflict Detection', () => {
    test('should detect overlapping rules', () => {
      const rules = [
        {
          name: 'rule_1',
          enabled: true,
          detectionQuery: {
            metric: 'response_time',
            threshold: 5000,
            comparison: 'greater_than',
            window: '5m',
            componentPattern: 'ollama-*'
          },
          remediation: {
            strategy: 'model_failover',
            action: 'action_1'
          }
        },
        {
          name: 'rule_2',
          enabled: true,
          detectionQuery: {
            metric: 'response_time', // Same metric
            threshold: 4000,
            comparison: 'greater_than',
            window: '5m',
            componentPattern: 'ollama-*' // Same pattern
          },
          remediation: {
            strategy: 'alert_only',
            action: 'action_2'
          }
        }
      ];

      const result = validator.validateRules(rules);

      expect(result.warnings.some(w => w.type === 'conflicting_rules')).toBe(true);
    });
  });

  describe('File Loading', () => {
    test('should load rules from actual config file', () => {
      const result = validator.loadAndValidate();

      expect(result).toBeDefined();
      expect(result.valid).toBeDefined();
      expect(result.totalRules).toBeGreaterThan(0);
    });

    test('should handle invalid file path', () => {
      const result = validator.loadAndValidate('/nonexistent/path.json');

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Summary Statistics', () => {
    test('should provide summary after loading rules', () => {
      validator.loadAndValidate();
      const summary = validator.getSummary();

      expect(summary).toBeDefined();
      expect(summary.total).toBeGreaterThan(0);
      expect(summary.enabled).toBeDefined();
      expect(summary.disabled).toBeDefined();
      expect(summary.strategies).toBeDefined();
      expect(summary.componentTypes).toBeDefined();
    });

    test('should return null summary if no rules loaded', () => {
      const newValidator = new RulesValidator();
      const summary = newValidator.getSummary();

      expect(summary).toBeNull();
    });
  });

  describe('Rule Retrieval', () => {
    beforeAll(() => {
      validator.loadAndValidate();
    });

    test('should return all rules', () => {
      const rules = validator.getRules();

      expect(Array.isArray(rules)).toBe(true);
      expect(rules.length).toBeGreaterThan(0);
    });

    test('should return only enabled rules', () => {
      const enabledRules = validator.getEnabledRules();

      expect(Array.isArray(enabledRules)).toBe(true);
      expect(enabledRules.every(r => r.enabled === true)).toBe(true);
    });
  });

  describe('Duration Validation', () => {
    test('should validate various duration formats', () => {
      const validDurations = ['5s', '15m', '1h', '24h', '30m'];
      const invalidDurations = ['5', '15min', '1hour', 'invalid'];

      validDurations.forEach(duration => {
        expect(validator._isValidDuration(duration)).toBe(true);
      });

      invalidDurations.forEach(duration => {
        expect(validator._isValidDuration(duration)).toBe(false);
      });
    });
  });

  describe('Rate Metric Warnings', () => {
    test('should warn about suspicious rate thresholds', () => {
      const rules = [
        {
          name: 'suspicious_rate',
          enabled: true,
          detectionQuery: {
            metric: 'error_rate',
            threshold: 50, // Should typically be 0-1 for rates
            comparison: 'less_than',
            window: '5m'
          },
          remediation: {
            strategy: 'alert_only',
            action: 'send_alert'
          }
        }
      ];

      const result = validator.validateRules(rules);

      expect(result.warnings.some(w => w.type === 'suspicious_threshold')).toBe(true);
    });
  });
});
