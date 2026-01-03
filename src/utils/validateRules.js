const Ajv = require('ajv');
const fs = require('fs');
const path = require('path');
const logger = require('../../config/logger');

/**
 * Self-Healing Rules Validator - Track 4: Self-Healing & Automation
 * 
 * Validates self-healing rule configurations against JSON schema
 * and checks for logical conflicts
 */
class RulesValidator {
  constructor() {
    this.ajv = new Ajv({ allErrors: true });
    this.schema = null;
    this.rules = null;
    
    // Load schema
    try {
      const schemaPath = path.join(__dirname, '../../config/schemas/self-healing-rule.schema.json');
      this.schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      this.validate = this.ajv.compile(this.schema);
      logger.info('Rules validator initialized with schema');
    } catch (error) {
      logger.error('Failed to load schema', { error: error.message });
      throw error;
    }
  }

  /**
   * Load and validate rules from file
   * @param {string} rulesPath - Path to rules JSON file
   * @returns {Object} - Validation result
   */
  loadAndValidate(rulesPath = null) {
    const defaultPath = path.join(__dirname, '../../config/self-healing-rules.json');
    const filePath = rulesPath || defaultPath;

    try {
      this.rules = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      logger.info('Loaded rules from file', { path: filePath, count: this.rules.length });
    } catch (error) {
      return {
        valid: false,
        errors: [`Failed to load rules file: ${error.message}`]
      };
    }

    return this.validateRules(this.rules);
  }

  /**
   * Validate array of rules
   * @param {Array} rules - Array of rule objects
   * @returns {Object} - Validation result
   */
  validateRules(rules) {
    if (!Array.isArray(rules)) {
      return {
        valid: false,
        errors: ['Rules must be an array']
      };
    }

    const errors = [];
    const warnings = [];

    // Validate each rule against schema
    rules.forEach((rule, index) => {
      const schemaValid = this.validate(rule);
      if (!schemaValid) {
        errors.push({
          rule: rule.name || `rule[${index}]`,
          type: 'schema',
          errors: this.validate.errors
        });
      }
    });

    // Check for logical issues
    const logicalIssues = this._checkLogicalIssues(rules);
    errors.push(...logicalIssues.errors);
    warnings.push(...logicalIssues.warnings);

    // Check for duplicate names
    const duplicates = this._checkDuplicateNames(rules);
    if (duplicates.length > 0) {
      errors.push({
        type: 'duplicate_names',
        message: 'Duplicate rule names found',
        duplicates
      });
    }

    // Check for conflicting rules
    const conflicts = this._checkConflicts(rules);
    if (conflicts.length > 0) {
      warnings.push({
        type: 'conflicting_rules',
        message: 'Rules with overlapping conditions found',
        conflicts
      });
    }

    const valid = errors.length === 0;

    const result = {
      valid,
      totalRules: rules.length,
      enabledRules: rules.filter(r => r.enabled).length,
      errors,
      warnings
    };

    if (valid) {
      logger.info('All rules validated successfully', {
        total: result.totalRules,
        enabled: result.enabledRules,
        warnings: warnings.length
      });
    } else {
      logger.error('Rule validation failed', {
        errorCount: errors.length,
        warningCount: warnings.length
      });
    }

    return result;
  }

  /**
   * Check for duplicate rule names
   * @private
   */
  _checkDuplicateNames(rules) {
    const names = {};
    const duplicates = [];

    rules.forEach((rule, index) => {
      if (!rule.name) return;

      if (Object.prototype.hasOwnProperty.call(names, rule.name)) {
        duplicates.push({
          name: rule.name,
          indices: [names[rule.name], index]
        });
      } else {
        names[rule.name] = index;
      }
    });

    return duplicates;
  }

  /**
   * Check for conflicting rules (same trigger, different actions)
   * @private
   */
  _checkConflicts(rules) {
    const conflicts = [];
    const enabledRules = rules.filter(r => r.enabled);

    for (let i = 0; i < enabledRules.length; i++) {
      for (let j = i + 1; j < enabledRules.length; j++) {
        const rule1 = enabledRules[i];
        const rule2 = enabledRules[j];

        // Check if rules have overlapping detection criteria
        if (this._rulesOverlap(rule1, rule2)) {
          conflicts.push({
            rule1: rule1.name,
            rule2: rule2.name,
            reason: 'Overlapping detection criteria',
            resolution: 'Use priority field to determine execution order'
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Check if two rules have overlapping conditions
   * @private
   */
  _rulesOverlap(rule1, rule2) {
    const d1 = rule1.detectionQuery;
    const d2 = rule2.detectionQuery;

    // Same metric and component pattern
    if (d1.metric === d2.metric) {
      // Check if component patterns overlap
      if (d1.componentPattern === d2.componentPattern) {
        return true;
      }

      // Check for wildcard overlaps
      if (d1.componentPattern && d2.componentPattern) {
        const pattern1 = d1.componentPattern.replace('*', '.*');
        const pattern2 = d2.componentPattern.replace('*', '.*');
        
        // Simple overlap detection (not exhaustive)
        if (pattern1.includes(pattern2) || pattern2.includes(pattern1)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check for logical issues in rules
   * @private
   */
  _checkLogicalIssues(rules) {
    const errors = [];
    const warnings = [];

    rules.forEach((rule, index) => {
      const id = rule.name || `rule[${index}]`;

      // Check threshold validity
      if (rule.detectionQuery) {
        const { threshold, comparison } = rule.detectionQuery;
        
        if (threshold !== undefined && typeof threshold !== 'number') {
          errors.push({
            rule: id,
            type: 'invalid_threshold',
            message: 'Threshold must be a number'
          });
        }

        // Check for percentage metrics with invalid thresholds
        if (rule.detectionQuery.metric && rule.detectionQuery.metric.includes('rate')) {
          if (threshold > 1 && comparison !== 'greater_than') {
            warnings.push({
              rule: id,
              type: 'suspicious_threshold',
              message: 'Rate metrics should typically use thresholds between 0 and 1'
            });
          }
        }
      }

      // Check cooldown period
      if (rule.remediation && rule.remediation.cooldown) {
        if (!this._isValidDuration(rule.remediation.cooldown)) {
          errors.push({
            rule: id,
            type: 'invalid_cooldown',
            message: 'Cooldown must be in format like "5m", "1h", "30s"'
          });
        }
      }

      // Check window period
      if (rule.detectionQuery && rule.detectionQuery.window) {
        if (!this._isValidDuration(rule.detectionQuery.window)) {
          errors.push({
            rule: id,
            type: 'invalid_window',
            message: 'Window must be in format like "5m", "1h", "30s"'
          });
        }
      }

      // Warn about automated + requires approval combination
      if (rule.remediation) {
        if (rule.remediation.automated && rule.remediation.requiresApproval) {
          warnings.push({
            rule: id,
            type: 'conflicting_settings',
            message: 'Rule is marked as automated but requires approval (approval will block execution)'
          });
        }
      }

      // Check if priority is within valid range
      if (rule.remediation && rule.remediation.priority) {
        const priority = rule.remediation.priority;
        if (priority < 1 || priority > 10) {
          errors.push({
            rule: id,
            type: 'invalid_priority',
            message: 'Priority must be between 1 and 10'
          });
        }
      }

      // Warn if no notifications configured
      if (!rule.notifications || Object.keys(rule.notifications).length === 0) {
        warnings.push({
          rule: id,
          type: 'no_notifications',
          message: 'No notification channels configured for this rule'
        });
      }
    });

    return { errors, warnings };
  }

  /**
   * Check if duration string is valid
   * @private
   */
  _isValidDuration(duration) {
    return /^\d+[smh]$/.test(duration);
  }

  /**
   * Get summary statistics for loaded rules
   */
  getSummary() {
    if (!this.rules) {
      return null;
    }

    const enabled = this.rules.filter(r => r.enabled);
    const strategies = {};
    const componentTypes = {};

    enabled.forEach(rule => {
      const strategy = rule.remediation?.strategy;
      if (strategy) {
        strategies[strategy] = (strategies[strategy] || 0) + 1;
      }

      const componentType = rule.detectionQuery?.componentType;
      if (componentType) {
        componentTypes[componentType] = (componentTypes[componentType] || 0) + 1;
      }
    });

    return {
      total: this.rules.length,
      enabled: enabled.length,
      disabled: this.rules.length - enabled.length,
      automated: enabled.filter(r => r.remediation?.automated).length,
      requiresApproval: enabled.filter(r => r.remediation?.requiresApproval).length,
      strategies,
      componentTypes
    };
  }

  /**
   * Export validated rules
   */
  getRules() {
    return this.rules;
  }

  /**
   * Get enabled rules only
   */
  getEnabledRules() {
    return this.rules ? this.rules.filter(r => r.enabled) : [];
  }
}

module.exports = RulesValidator;
