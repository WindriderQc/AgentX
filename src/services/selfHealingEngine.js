const Alert = require('../../models/Alert');
const MetricsSnapshot = require('../../models/MetricsSnapshot');
const alertService = require('./alertService');
const ModelRouter = require('./modelRouter');
const logger = require('../../config/logger');
const fs = require('fs').promises;
const path = require('path');

/**
 * SelfHealingEngine - Track 4: Self-Healing & Resilience
 * 
 * Orchestrates automated remediation actions based on self-healing rules.
 * 
 * Features:
 * - Rule-based condition evaluation
 * - Automated remediation action execution
 * - Cooldown period enforcement
 * - Approval workflow for high-risk actions
 * - Execution history tracking
 * - Priority-based queueing
 * 
 * Supported Actions:
 * - model_failover: Switch Ollama hosts
 * - prompt_rollback: Revert to previous prompt version
 * - service_restart: Restart AgentX/services (requires approval)
 * - throttle_requests: Enable rate limiting
 * - alert_only: Send notifications without remediation
 */
class SelfHealingEngine {
  constructor() {
    if (SelfHealingEngine.instance) {
      return SelfHealingEngine.instance;
    }

    this.rules = [];
    this.executionHistory = new Map(); // ruleName -> last execution timestamp
    this.actionQueue = []; // Priority queue for actions
    this.isProcessing = false;

    // Configuration
    this.config = {
      enableAutomation: process.env.SELF_HEALING_ENABLED !== 'false',
      requireApprovalForCritical: process.env.REQUIRE_APPROVAL !== 'false',
      maxConcurrentActions: parseInt(process.env.MAX_CONCURRENT_ACTIONS || '3'),
      defaultCooldownMs: 15 * 60 * 1000 // 15 minutes
    };

    SelfHealingEngine.instance = this;
    logger.info('SelfHealingEngine initialized', { config: this.config });
  }

  /**
   * Load self-healing rules from configuration file
   * @param {string} configPath - Path to rules JSON file
   * @returns {Promise<number>} Number of rules loaded
   */
  async loadRules(configPath = path.join(__dirname, '../../config/self-healing-rules.json')) {
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      const rules = JSON.parse(content);

      if (!Array.isArray(rules)) {
        throw new Error('Rules configuration must be an array');
      }

      // Filter enabled rules only
      this.rules = rules.filter(rule => rule.enabled !== false);

      logger.info('Self-healing rules loaded', {
        total: rules.length,
        enabled: this.rules.length,
        disabled: rules.length - this.rules.length
      });

      return this.rules.length;
    } catch (error) {
      logger.error('Failed to load self-healing rules', { error: error.message, configPath });
      throw error;
    }
  }

  /**
   * Evaluate if a rule should be triggered based on metrics
   * @param {Object} rule - Self-healing rule
   * @param {Object} metricsData - Current metrics data
   * @returns {Promise<Object>} Evaluation result { shouldTrigger, reason, metrics }
   */
  async evaluateRule(rule, metricsData = null) {
    try {
      const { detectionQuery } = rule;

      // Check cooldown period
      if (!this._canExecute(rule.name, rule.remediation.cooldown)) {
        return {
          shouldTrigger: false,
          reason: 'cooldown_active',
          cooldownRemaining: this._getCooldownRemaining(rule.name, rule.remediation.cooldown)
        };
      }

      // Fetch metrics if not provided
      if (!metricsData) {
        metricsData = await this._fetchMetrics(detectionQuery);
      }

      // Check if metrics meet threshold
      const thresholdMet = this._checkThreshold(
        metricsData.value,
        detectionQuery.threshold,
        detectionQuery.comparison
      );

      if (!thresholdMet) {
        return {
          shouldTrigger: false,
          reason: 'threshold_not_met',
          currentValue: metricsData.value,
          threshold: detectionQuery.threshold
        };
      }

      // Check minOccurrences condition
      if (rule.conditions?.minOccurrences) {
        const occurrences = await this._countRecentOccurrences(rule, detectionQuery.window);
        if (occurrences < rule.conditions.minOccurrences) {
          return {
            shouldTrigger: false,
            reason: 'min_occurrences_not_met',
            occurrences,
            required: rule.conditions.minOccurrences
          };
        }
      }

      // Check time-based conditions
      if (rule.conditions?.timeOfDay) {
        const inTimeWindow = this._checkTimeWindow(rule.conditions.timeOfDay);
        if (!inTimeWindow) {
          return {
            shouldTrigger: false,
            reason: 'outside_time_window',
            window: rule.conditions.timeOfDay
          };
        }
      }

      return {
        shouldTrigger: true,
        reason: 'conditions_met',
        metrics: metricsData,
        rule: rule.name
      };
    } catch (error) {
      logger.error('Rule evaluation failed', { rule: rule.name, error: error.message });
      return {
        shouldTrigger: false,
        reason: 'evaluation_error',
        error: error.message
      };
    }
  }

  /**
   * Execute remediation action for a triggered rule
   * @param {Object} rule - Self-healing rule
   * @param {Object} context - Execution context (metrics, metadata)
   * @returns {Promise<Object>} Execution result
   */
  async executeRemediation(rule, context = {}) {
    const { remediation, notifications } = rule;
    const startTime = Date.now();

    try {
      // Check if automation is enabled
      if (!this.config.enableAutomation) {
        logger.warn('Self-healing automation disabled', { rule: rule.name });
        return {
          status: 'skipped',
          reason: 'automation_disabled',
          rule: rule.name
        };
      }

      // Check if requires approval
      if (remediation.requiresApproval && this.config.requireApprovalForCritical) {
        logger.info('Action requires approval', { rule: rule.name, action: remediation.action });
        await this._sendNotifications(rule, 'onTrigger', context);
        return {
          status: 'pending_approval',
          rule: rule.name,
          action: remediation.action,
          approvalRequired: true
        };
      }

      // Send trigger notifications
      await this._sendNotifications(rule, 'onTrigger', context);

      // Execute action based on strategy
      let result;
      switch (remediation.strategy) {
        case 'model_failover':
          result = await this._executeModelFailover(rule, context);
          break;
        case 'prompt_rollback':
          result = await this._executePromptRollback(rule, context);
          break;
        case 'service_restart':
          result = await this._executeServiceRestart(rule, context);
          break;
        case 'throttle_requests':
          result = await this._executeThrottle(rule, context);
          break;
        case 'alert_only':
          result = await this._executeAlertOnly(rule, context);
          break;
        default:
          throw new Error(`Unknown remediation strategy: ${remediation.strategy}`);
      }

      // Record successful execution
      this._recordExecution(rule.name, Date.now());

      // Send success notifications
      await this._sendNotifications(rule, 'onSuccess', {
        ...context,
        result,
        duration: Date.now() - startTime
      });

      logger.info('Remediation executed successfully', {
        rule: rule.name,
        strategy: remediation.strategy,
        duration: Date.now() - startTime,
        result
      });

      return {
        status: 'success',
        rule: rule.name,
        action: remediation.action,
        result,
        duration: Date.now() - startTime
      };

    } catch (error) {
      logger.error('Remediation execution failed', {
        rule: rule.name,
        strategy: remediation.strategy,
        error: error.message,
        stack: error.stack
      });

      // Send failure notifications
      await this._sendNotifications(rule, 'onFailure', {
        ...context,
        error: error.message,
        duration: Date.now() - startTime
      });

      return {
        status: 'failed',
        rule: rule.name,
        action: remediation.action,
        error: error.message,
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * Evaluate all rules and execute remediation for triggered rules
   * @param {Object} metricsData - Optional metrics data to evaluate against
   * @returns {Promise<Array>} Array of execution results
   */
  async evaluateAndExecute(metricsData = null) {
    const results = [];

    // Sort rules by priority (lower number = higher priority)
    const sortedRules = [...this.rules].sort((a, b) => {
      const priorityA = a.remediation.priority || 999;
      const priorityB = b.remediation.priority || 999;
      return priorityA - priorityB;
    });

    for (const rule of sortedRules) {
      try {
        const evaluation = await this.evaluateRule(rule, metricsData);

        if (evaluation.shouldTrigger) {
          logger.info('Rule triggered', {
            rule: rule.name,
            reason: evaluation.reason,
            metrics: evaluation.metrics
          });

          const executionResult = await this.executeRemediation(rule, {
            evaluation,
            triggeredAt: new Date().toISOString()
          });

          results.push(executionResult);
        }
      } catch (error) {
        logger.error('Rule processing failed', {
          rule: rule.name,
          error: error.message
        });
        results.push({
          status: 'error',
          rule: rule.name,
          error: error.message
        });
      }
    }

    return results;
  }

  // ==================== Private Action Handlers ====================

  /**
   * Execute model failover to backup Ollama host
   */
  async _executeModelFailover(rule, context) {
    const { detectionQuery } = rule;
    const component = context.evaluation?.metrics?.component || detectionQuery.componentPattern;

    logger.info('Executing model failover', { component, rule: rule.name });

    try {
      // Determine current and backup hosts
      const currentHost = ModelRouter.getActiveHost();
      const backupHost = ModelRouter.getBackupHost();
      const backupHostKey = this._getHostKeyFromUrl(backupHost);

      // Switch to backup host with reason
      ModelRouter.switchHost(backupHost, 'self_healing_failover');

      // Verify new host is responding
      const healthCheck = await ModelRouter.checkHostHealth(backupHostKey);
      if (healthCheck.status !== 'online') {
        // Rollback if backup is also unhealthy
        ModelRouter.switchHost(currentHost, 'rollback_unhealthy_backup');
        throw new Error(`Backup host is also unhealthy (${healthCheck.status}), rollback performed`);
      }

      logger.info('Model failover successful', {
        previousHost: currentHost,
        newHost: backupHost,
        backupLatency: healthCheck.latency,
        backupModelCount: healthCheck.models?.length || 0
      });

      return {
        action: 'model_failover',
        previousHost: currentHost,
        newHost: backupHost,
        healthCheck: {
          status: healthCheck.status,
          latency: healthCheck.latency,
          modelCount: healthCheck.models?.length || 0
        }
      };
    } catch (error) {
      logger.error('Model failover failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Convert host URL to host key for health checks
   * @param {string} url - Host URL
   * @returns {string} Host key ('primary' or 'secondary')
   */
  _getHostKeyFromUrl(url) {
    if (url === ModelRouter.HOSTS.primary) return 'primary';
    if (url === ModelRouter.HOSTS.secondary) return 'secondary';
    return 'primary'; // Fallback
  }

  /**
   * Execute prompt rollback to previous version
   */
  async _executePromptRollback(rule, context) {
    const PromptConfig = require('../../models/PromptConfig');

    logger.info('Executing prompt rollback', { rule: rule.name });

    try {
      // Extract prompt name from context
      const componentId = context.evaluation?.metrics?.component || rule.detectionQuery?.componentPattern || '';

      // Parse prompt name from component ID (format: "prompt:default_chat:v2" or just "default_chat")
      let promptName = componentId;
      if (componentId.startsWith('prompt:')) {
        promptName = componentId.replace('prompt:', '').split(':')[0];
      } else if (!componentId || componentId === '*') {
        promptName = 'default_chat'; // Fallback to default
      }

      logger.debug('Parsed prompt name for rollback', { componentId, promptName });

      // Find currently active prompt
      const currentPrompt = await PromptConfig.findOne({
        name: promptName,
        isActive: true
      }).sort({ version: -1 });

      if (!currentPrompt) {
        throw new Error(`No active prompt found for ${promptName}`);
      }

      // Find previous version (next highest version that's not current)
      const previousPrompt = await PromptConfig.findOne({
        name: promptName,
        version: { $lt: currentPrompt.version }
      }).sort({ version: -1 });

      if (!previousPrompt) {
        throw new Error(`No previous version found for ${promptName} (current: v${currentPrompt.version})`);
      }

      // Deactivate current, activate previous
      currentPrompt.isActive = false;
      currentPrompt.trafficWeight = 0;
      await currentPrompt.save();

      previousPrompt.isActive = true;
      previousPrompt.trafficWeight = 100;
      await previousPrompt.save();

      logger.info('Prompt rollback completed', {
        promptName,
        fromVersion: currentPrompt.version,
        toVersion: previousPrompt.version,
        currentPromptId: currentPrompt._id,
        previousPromptId: previousPrompt._id
      });

      return {
        action: 'prompt_rollback',
        promptName,
        previousVersion: currentPrompt.version,
        rolledBackToVersion: previousPrompt.version,
        previousPromptId: previousPrompt._id.toString(),
        systemPromptPreview: previousPrompt.systemPrompt.substring(0, 100)
      };
    } catch (error) {
      logger.error('Prompt rollback failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Execute service restart (PM2)
   */
  async _executeServiceRestart(rule, context) {
    const { exec } = require('child_process');
    const util = require('util');
    const execAsync = util.promisify(exec);

    logger.warn('Executing service restart', { rule: rule.name });

    try {
      const componentId = context.evaluation?.metrics?.component || rule.detectionQuery?.componentPattern || 'agentx';

      // Map component names to PM2 app names
      const serviceMap = {
        'agentx': 'agentx',
        'agentx-main': 'agentx',
        'agentx-api': 'agentx',
        'dataapi': 'dataapi',
        'dataapi-main': 'dataapi'
      };

      const pm2AppName = serviceMap[componentId.toLowerCase()] || 'agentx';

      logger.info('Restarting PM2 service', { component: componentId, pm2App: pm2AppName });

      // Execute PM2 reload (graceful restart with zero-downtime)
      const { stdout: reloadOutput, stderr: reloadError } = await execAsync(`pm2 reload ${pm2AppName}`);

      if (reloadError) {
        logger.warn('PM2 reload stderr (may be informational)', { stderr: reloadError });
      }

      logger.info('PM2 reload command completed', {
        service: pm2AppName,
        stdout: reloadOutput.trim()
      });

      // Wait for service to stabilize (5 seconds)
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Verify service is running
      const { stdout: statusOutput } = await execAsync(`pm2 jlist`);
      const processes = JSON.parse(statusOutput);
      const targetProcess = processes.find(p => p.name === pm2AppName);

      if (!targetProcess) {
        throw new Error(`Service ${pm2AppName} not found in PM2 process list after restart`);
      }

      if (targetProcess.pm2_env.status !== 'online') {
        throw new Error(`Service ${pm2AppName} status is ${targetProcess.pm2_env.status}, expected 'online'`);
      }

      const restartCount = targetProcess.pm2_env.restart_time || 0;
      const uptime = targetProcess.pm2_env.pm_uptime ? Date.now() - targetProcess.pm2_env.pm_uptime : 0;

      logger.info('Service restart verified successful', {
        service: pm2AppName,
        status: targetProcess.pm2_env.status,
        restartCount,
        uptimeMs: uptime
      });

      return {
        action: 'service_restart',
        service: pm2AppName,
        status: 'online',
        restartTime: new Date().toISOString(),
        restartCount,
        uptimeMs: uptime
      };

    } catch (error) {
      logger.error('Service restart failed', {
        rule: rule.name,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Execute request throttling
   */
  async _executeThrottle(rule, context) {
    logger.info('Executing request throttle', { rule: rule.name });

    try {
      // Dynamic rate limit adjustment
      // This will reduce limits by 50% for 15 minutes
      const throttleDurationMs = 15 * 60 * 1000; // 15 minutes
      const reductionFactor = 0.5; // 50% reduction

      // Store throttle state in global (in-memory for now, Redis in future)
      if (!global._selfHealingThrottle) {
        global._selfHealingThrottle = {};
      }

      const previousState = global._selfHealingThrottle.enabled || false;

      global._selfHealingThrottle = {
        enabled: true,
        reductionFactor,
        appliedAt: Date.now(),
        expiresAt: Date.now() + throttleDurationMs,
        reason: rule.name,
        originalLimits: {
          chat: 20, // per minute
          api: 100  // per 15 minutes
        }
      };

      logger.warn('Request throttling activated', {
        reductionFactor: `${(1 - reductionFactor) * 100}%`,
        durationMs: throttleDurationMs,
        expiresAt: new Date(global._selfHealingThrottle.expiresAt).toISOString(),
        previouslyThrottled: previousState
      });

      // Schedule automatic restoration
      setTimeout(() => {
        if (global._selfHealingThrottle && global._selfHealingThrottle.enabled) {
          global._selfHealingThrottle.enabled = false;
          logger.info('Request throttling automatically restored', {
            duration: throttleDurationMs,
            reason: 'timeout_reached'
          });
        }
      }, throttleDurationMs);

      return {
        action: 'throttle_requests',
        enabled: true,
        reductionPercentage: `${(1 - reductionFactor) * 100}%`,
        durationMs: throttleDurationMs,
        expiresAt: new Date(global._selfHealingThrottle.expiresAt).toISOString(),
        adjustedLimits: {
          chat: Math.floor(global._selfHealingThrottle.originalLimits.chat * reductionFactor),
          api: Math.floor(global._selfHealingThrottle.originalLimits.api * reductionFactor)
        },
        previouslyThrottled: previousState
      };
    } catch (error) {
      logger.error('Request throttling failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Execute alert-only action (no remediation)
   */
  async _executeAlertOnly(rule, context) {
    logger.info('Alert-only action', { rule: rule.name });

    const crypto = require('crypto');
    const channels = Array.isArray(rule?.notifications?.onTrigger) ? rule.notifications.onTrigger : [];
    const component = context?.evaluation?.metrics?.componentId || context?.evaluation?.metrics?.component || 'agentx';
    const fingerprint = crypto
      .createHash('md5')
      .update(`${rule.name}|${component}|${rule.detectionQuery?.metric || ''}|alert_only`)
      .digest('hex');

    const alert = await Alert.create({
      ruleId: rule.name,
      ruleName: rule.description || rule.name,
      severity: this._mapPriorityToSeverity(rule.remediation.priority),
      title: rule.description || `Self-Healing: ${rule.name}`,
      message: `Self-healing rule triggered: ${rule.name}`,
      context: {
        component,
        metric: rule.detectionQuery?.metric
      },
      channels,
      fingerprint,
      source: 'agentx',
      metadata: {
        ...context,
        ruleName: rule.name,
        strategy: rule.remediation.strategy
      }
    });

    if (channels.length > 0) {
      await alertService._sendNotifications(alert, channels);
    }

    return {
      action: 'alert_only',
      alertId: alert._id,
      alertCreated: true
    };
  }

  // ==================== Private Helper Methods ====================

  /**
   * Fetch metrics from database
   */
  async _fetchMetrics(detectionQuery) {
    const { metric, componentType, componentPattern, window, aggregation } = detectionQuery;

    // Parse window (e.g., "5m", "1h", "24h")
    const windowMs = this._parseTimeWindow(window);
    const startTime = new Date(Date.now() - windowMs);

    // Build query
    const query = {
      timestamp: { $gte: startTime },
      type: this._mapMetricToType(metric)
    };

    if (componentPattern && componentPattern !== '*') {
      query.componentId = new RegExp(componentPattern.replace('*', '.*'));
    }

    // Fetch and aggregate
    const metrics = await MetricsSnapshot.find(query).sort({ timestamp: -1 }).limit(100);

    if (metrics.length === 0) {
      return { value: null, count: 0 };
    }

    // Apply aggregation
    let value;
    const values = metrics.map(m => m.value);

    switch (aggregation) {
      case 'avg':
        value = values.reduce((sum, v) => sum + v, 0) / values.length;
        break;
      case 'sum':
        value = values.reduce((sum, v) => sum + v, 0);
        break;
      case 'max':
        value = Math.max(...values);
        break;
      case 'min':
        value = Math.min(...values);
        break;
      case 'count':
        value = values.length;
        break;
      default:
        value = values[0]; // Latest value
    }

    return {
      value,
      count: metrics.length,
      componentId: metrics[0]?.componentId,
      component: metrics[0]?.componentId,
      timestamp: metrics[0]?.timestamp
    };
  }

  /**
   * Check if threshold condition is met
   */
  _checkThreshold(value, threshold, comparison) {
    if (value === null || value === undefined) return false;

    switch (comparison) {
      case 'greater_than':
        return value > threshold;
      case 'less_than':
        return value < threshold;
      case 'equal':
        return value === threshold;
      case 'greater_or_equal':
        return value >= threshold;
      case 'less_or_equal':
        return value <= threshold;
      default:
        return false;
    }
  }

  /**
   * Check if rule can execute (cooldown check)
   */
  _canExecute(ruleName, cooldownPeriod) {
    const lastExecution = this.executionHistory.get(ruleName);
    if (!lastExecution) return true;

    const cooldownMs = this._parseTimeWindow(cooldownPeriod);
    const timeSinceLastExecution = Date.now() - lastExecution;

    return timeSinceLastExecution >= cooldownMs;
  }

  /**
   * Get remaining cooldown time in milliseconds
   */
  _getCooldownRemaining(ruleName, cooldownPeriod) {
    const lastExecution = this.executionHistory.get(ruleName);
    if (!lastExecution) return 0;

    const cooldownMs = this._parseTimeWindow(cooldownPeriod);
    const elapsed = Date.now() - lastExecution;
    return Math.max(0, cooldownMs - elapsed);
  }

  /**
   * Record execution timestamp
   */
  _recordExecution(ruleName, timestamp) {
    this.executionHistory.set(ruleName, timestamp);
  }

  /**
   * Count recent occurrences of threshold breaches
   */
  async _countRecentOccurrences(rule, window) {
    // This would query MetricsSnapshot for breaches in the window
    // For now, return 1 (assuming current breach)
    return 1;
  }

  /**
   * Check if current time is within specified time window
   */
  _checkTimeWindow(timeWindow) {
    const now = new Date();
    const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    
    return currentTime >= timeWindow.start && currentTime <= timeWindow.end;
  }

  /**
   * Send notifications based on event type
   */
  async _sendNotifications(rule, eventType, context) {
    const channels = rule?.notifications?.[eventType];
    if (!channels || channels.length === 0) return;

    const crypto = require('crypto');
    const component = context?.evaluation?.metrics?.componentId || context?.evaluation?.metrics?.component || 'selfHealingEngine';
    const severity = eventType === 'onFailure'
      ? 'error'
      : (eventType === 'onTrigger' && rule?.remediation?.priority === 1)
        ? 'critical'
        : (eventType === 'onTrigger')
          ? 'warning'
          : 'info';

    try {
      const fingerprint = crypto
        .createHash('md5')
        .update(`${rule.name}|${component}|${eventType}`)
        .digest('hex');

      const alert = await Alert.create({
        ruleId: rule.name,
        ruleName: rule.description || rule.name,
        severity,
        title: `Self-Healing: ${rule.name} - ${eventType}`,
        message: this._formatNotificationMessage(rule, eventType, context),
        context: {
          component,
          metric: rule?.detectionQuery?.metric
        },
        channels,
        fingerprint,
        source: 'agentx',
        metadata: {
          ...context,
          eventType,
          ruleName: rule.name,
          strategy: rule.remediation.strategy
        }
      });

      await alertService._sendNotifications(alert, channels);
    } catch (error) {
      logger.error('Failed to send notification', {
        rule: rule.name,
        eventType,
        error: error.message
      });
    }
  }

  /**
   * Format notification message
   */
  _formatNotificationMessage(rule, eventType, context) {
    const { remediation } = rule;

    switch (eventType) {
      case 'onTrigger':
        return `🚨 Self-healing rule triggered: ${rule.description}\nAction: ${remediation.action}\nStrategy: ${remediation.strategy}`;
      case 'onSuccess':
        return `✅ Remediation successful: ${rule.description}\nAction completed: ${remediation.action}\nDuration: ${context.duration}ms`;
      case 'onFailure':
        return `❌ Remediation failed: ${rule.description}\nAction: ${remediation.action}\nError: ${context.error}`;
      default:
        return rule.description;
    }
  }

  /**
   * Parse time window string to milliseconds
   */
  _parseTimeWindow(window) {
    if (!window) return this.config.defaultCooldownMs;

    const match = window.match(/^(\d+)([smhd])$/);
    if (!match) return this.config.defaultCooldownMs;

    const value = parseInt(match[1]);
    const unit = match[2];

    const multipliers = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000
    };

    return value * (multipliers[unit] || 1000);
  }

  /**
   * Map metric name to metric type
   */
  _mapMetricToType(metricName) {
    const typeMap = {
      health_status: 'health',
      avg_response_time: 'performance',
      tokens_per_second: 'performance',
      error_rate: 'quality',
      positive_rate: 'quality',
      quality_score: 'quality',
      daily_cost: 'cost',
      memory_percentage: 'resource',
      disk_usage_percentage: 'resource',
      connection_pool_usage: 'resource'
    };

    return typeMap[metricName] || 'usage';
  }

  /**
   * Map priority to alert severity
   */
  _mapPriorityToSeverity(priority) {
    if (priority === 1) return 'critical';
    if (priority === 2) return 'error';
    if (priority === 3) return 'warning';
    return 'info';
  }

  /**
   * Get current rules
   */
  getRules() {
    return this.rules;
  }

  /**
   * Get execution history
   */
  getExecutionHistory() {
    return Array.from(this.executionHistory.entries()).map(([ruleName, timestamp]) => ({
      ruleName,
      lastExecuted: new Date(timestamp).toISOString(),
      cooldownRemaining: this._getCooldownRemaining(
        ruleName,
        this.rules.find(r => r.name === ruleName)?.remediation?.cooldown || '15m'
      )
    }));
  }
}

// Export singleton instance
module.exports = new SelfHealingEngine();
