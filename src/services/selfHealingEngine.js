/**
 * SelfHealingEngine — Orchestrator
 *
 * Coordinates rule evaluation, remediation dispatch, approval workflows,
 * cooldown management and execution persistence.
 *
 * Action handlers  → selfHealingActions.js
 * Pure helpers     → selfHealingHelpers.js
 */

'use strict';

const Alert                 = require('../../models/Alert');
const SelfHealingExecution  = require('../../models/SelfHealingExecution');
const SelfHealingApproval   = require('../../models/SelfHealingApproval');
const alertService          = require('./alertService');
const RulesValidator        = require('../utils/validateRules');
const { getSelfHealingStateStore } = require('./selfHealingStateStore');
const logger = require('../../config/logger');
const fs     = require('fs').promises;
const path   = require('path');
const crypto = require('crypto');

const {
  DEFAULT_COOLDOWN_MS, parseTimeWindow, checkTimeWindow,
  checkThreshold, mapPriorityToSeverity, formatNotificationMessage,
  fetchMetrics, countRecentOccurrences
} = require('./selfHealingHelpers');

const {
  executeModelFailover, executePromptRollback, executeServiceRestart,
  executeThrottle, executeAlertOnly
} = require('./selfHealingActions');

// ─────────────────────────────────────────────────────────────

class SelfHealingEngine {
  constructor() {
    if (SelfHealingEngine.instance) return SelfHealingEngine.instance;

    this.rules          = [];
    this.executionHistory = new Map();
    this.actionQueue    = [];
    this.isProcessing   = false;
    this.ruleConfigPath = path.join(__dirname, '../../config/self-healing-rules.json');
    this.stateStore     = getSelfHealingStateStore();

    this.config = {
      enableAutomation:          process.env.SELF_HEALING_ENABLED !== 'false',
      requireApprovalForCritical: process.env.REQUIRE_APPROVAL !== 'false',
      maxConcurrentActions:       parseInt(process.env.MAX_CONCURRENT_ACTIONS || '3', 10),
      evaluationIntervalMs:       parseInt(process.env.SELF_HEALING_EVALUATION_INTERVAL_MS || '300000', 10),
      defaultCooldownMs:          DEFAULT_COOLDOWN_MS
    };

    SelfHealingEngine.instance = this;
    logger.info('SelfHealingEngine initialized', { config: this.config });
  }

  // ── Rule loading ─────────────────────────────────────────────

  async loadRules(configPath = this.ruleConfigPath) {
    try {
      const validator  = new RulesValidator();
      const validation = validator.loadAndValidate(configPath);
      if (!validation.valid) throw new Error(`Rules validation failed: ${JSON.stringify(validation.errors)}`);

      const content = await fs.readFile(configPath, 'utf-8');
      const rules   = JSON.parse(content);
      if (!Array.isArray(rules)) throw new Error('Rules configuration must be an array');

      this.ruleConfigPath = configPath;
      this.rules = rules.filter(rule => rule.enabled !== false);
      logger.info('Self-healing rules loaded', { total: rules.length, enabled: this.rules.length });
      return this.rules.length;
    } catch (error) {
      logger.error('Failed to load self-healing rules', { error: error.message, configPath });
      throw error;
    }
  }

  // ── Rule evaluation ──────────────────────────────────────────

  async evaluateRule(rule, metricsData = null) {
    try {
      const { detectionQuery } = rule;

      if (!(await this._canExecuteDistributed(rule.name, rule.remediation.cooldown))) {
        return {
          shouldTrigger: false, reason: 'cooldown_active',
          cooldownRemaining: await this._getCooldownRemainingDistributed(rule.name, rule.remediation.cooldown)
        };
      }

      if (rule.conditions?.minOccurrences) {
        const occurrences = await countRecentOccurrences(rule, detectionQuery.window, { defaultCooldownMs: this.config.defaultCooldownMs });
        if (occurrences < rule.conditions.minOccurrences) {
          return { shouldTrigger: false, reason: 'min_occurrences_not_met', occurrences, required: rule.conditions.minOccurrences };
        }
      }

      if (rule.conditions?.timeOfDay) {
        if (!checkTimeWindow(rule.conditions.timeOfDay)) {
          return { shouldTrigger: false, reason: 'outside_time_window', window: rule.conditions.timeOfDay };
        }
      }

      if (Array.isArray(rule.conditions?.daysOfWeek) && rule.conditions.daysOfWeek.length > 0) {
        const allowedDays = rule.conditions.daysOfWeek.map(d => String(d).toLowerCase());
        const currentDay  = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][new Date().getDay()];
        if (!allowedDays.includes(currentDay)) {
          return { shouldTrigger: false, reason: 'outside_day_window', allowedDays, currentDay };
        }
      }

      if (!metricsData) metricsData = await fetchMetrics(detectionQuery, { defaultCooldownMs: this.config.defaultCooldownMs });

      const thresholdMet = checkThreshold(metricsData.value, detectionQuery.threshold, detectionQuery.comparison);
      if (!thresholdMet) {
        return { shouldTrigger: false, reason: 'threshold_not_met', currentValue: metricsData.value, threshold: detectionQuery.threshold };
      }

      return { shouldTrigger: true, reason: 'conditions_met', metrics: metricsData, rule: rule.name };
    } catch (error) {
      logger.error('Rule evaluation failed', { rule: rule.name, error: error.message });
      return { shouldTrigger: false, reason: 'evaluation_error', error: error.message };
    }
  }

  // ── Remediation dispatch ─────────────────────────────────────

  async executeRemediation(rule, context = {}, options = {}) {
    const { remediation } = rule;
    const startTime               = Date.now();
    const shouldBypassApproval    = options.bypassApproval === true;
    const skipTriggerNotification = options.skipTriggerNotification === true;
    const triggerSource           = options.triggerSource || context?.triggeredBy || 'auto';

    try {
      if (!this.config.enableAutomation) {
        logger.warn('Self-healing automation disabled', { rule: rule.name });
        await this._saveExecutionRecord(rule, { status: 'skipped', duration: Date.now() - startTime, triggerSource, context, error: 'automation_disabled' });
        return { status: 'skipped', reason: 'automation_disabled', rule: rule.name };
      }

      if (remediation.requiresApproval && this.config.requireApprovalForCritical && !shouldBypassApproval) {
        logger.info('Action requires approval', { rule: rule.name, action: remediation.action });
        await this._sendNotifications(rule, 'onTrigger', context);
        let approval = null;
        try { approval = await this._createPendingApproval(rule, context); } catch (e) {
          logger.error('Failed to persist approval request', { rule: rule.name, error: e.message });
        }
        await this._saveExecutionRecord(rule, { status: 'pending_approval', duration: Date.now() - startTime, triggerSource, context, approvalId: approval?._id || null });
        return { status: 'pending_approval', rule: rule.name, action: remediation.action, approvalRequired: true, approvalId: approval?._id || null };
      }

      if (!skipTriggerNotification) await this._sendNotifications(rule, 'onTrigger', context);

      let result;
      switch (remediation.strategy) {
        case 'model_failover':    result = await executeModelFailover(rule, context); break;
        case 'prompt_rollback':   result = await executePromptRollback(rule, context); break;
        case 'service_restart':   result = await executeServiceRestart(rule, context); break;
        case 'throttle_requests': result = await executeThrottle(rule, context, { stateStore: this.stateStore, parseTimeWindow }); break;
        case 'alert_only':        result = await executeAlertOnly(rule, context, { mapPriorityToSeverity }); break;
        default: throw new Error(`Unknown remediation strategy: ${remediation.strategy}`);
      }

      const executedAt = Date.now();
      await this._recordExecution(rule.name, executedAt);
      const executionRecord = await this._saveExecutionRecord(rule, { status: 'success', result, duration: Date.now() - startTime, triggerSource, context });
      await this._sendNotifications(rule, 'onSuccess', { ...context, result, duration: Date.now() - startTime });

      logger.info('Remediation executed successfully', { rule: rule.name, strategy: remediation.strategy, duration: Date.now() - startTime });
      return { status: 'success', rule: rule.name, action: remediation.action, result, duration: Date.now() - startTime, executionId: executionRecord?._id || null };

    } catch (error) {
      logger.error('Remediation execution failed', { rule: rule.name, strategy: remediation.strategy, error: error.message });
      await this._sendNotifications(rule, 'onFailure', { ...context, error: error.message, duration: Date.now() - startTime });
      const executionRecord = await this._saveExecutionRecord(rule, { status: 'failed', duration: Date.now() - startTime, error: error.message, triggerSource, context });
      return { status: 'failed', rule: rule.name, action: remediation.action, error: error.message, duration: Date.now() - startTime, executionId: executionRecord?._id || null };
    }
  }

  async evaluateAndExecute(metricsData = null) {
    const results = [];
    const sortedRules = [...this.rules].sort((a, b) => (a.remediation.priority || 999) - (b.remediation.priority || 999));
    for (const rule of sortedRules) {
      try {
        const evaluation = await this.evaluateRule(rule, metricsData);
        if (evaluation.shouldTrigger) {
          logger.info('Rule triggered', { rule: rule.name, reason: evaluation.reason, metrics: evaluation.metrics });
          const executionResult = await this.executeRemediation(rule, { evaluation, triggeredAt: new Date().toISOString() });
          results.push(executionResult);
        }
      } catch (error) {
        logger.error('Rule processing failed', { rule: rule.name, error: error.message });
        results.push({ status: 'error', rule: rule.name, error: error.message });
      }
    }
    return results;
  }

  // ── Cooldown / execution tracking ────────────────────────────

  _canExecute(ruleName, cooldownPeriod) {
    const lastExecution = this.executionHistory.get(ruleName);
    if (!lastExecution) return true;
    return (Date.now() - lastExecution) >= parseTimeWindow(cooldownPeriod, this.config.defaultCooldownMs);
  }

  _getCooldownRemaining(ruleName, cooldownPeriod) {
    const lastExecution = this.executionHistory.get(ruleName);
    if (!lastExecution) return 0;
    const cooldownMs = parseTimeWindow(cooldownPeriod, this.config.defaultCooldownMs);
    return Math.max(0, cooldownMs - (Date.now() - lastExecution));
  }

  _recordExecution(ruleName, timestamp) {
    this.executionHistory.set(ruleName, timestamp);
    this.stateStore.setLastExecution(ruleName, timestamp).catch(error => {
      logger.warn('Failed to persist self-healing execution timestamp', { ruleName, error: error.message });
    });
  }

  async _getLastExecutionTimestamp(ruleName) {
    const fromStateStore = await this.stateStore.getLastExecution(ruleName);
    if (fromStateStore) { this.executionHistory.set(ruleName, fromStateStore); return fromStateStore; }
    return this.executionHistory.get(ruleName) || null;
  }

  async _canExecuteDistributed(ruleName, cooldownPeriod) {
    const lastExecution = await this._getLastExecutionTimestamp(ruleName);
    if (!lastExecution) return true;
    return (Date.now() - lastExecution) >= parseTimeWindow(cooldownPeriod, this.config.defaultCooldownMs);
  }

  async _getCooldownRemainingDistributed(ruleName, cooldownPeriod) {
    const lastExecution = await this._getLastExecutionTimestamp(ruleName);
    if (!lastExecution) return 0;
    const cooldownMs = parseTimeWindow(cooldownPeriod, this.config.defaultCooldownMs);
    return Math.max(0, cooldownMs - (Date.now() - lastExecution));
  }

  // ── Notifications ────────────────────────────────────────────

  async _sendNotifications(rule, eventType, context) {
    const channels = rule?.notifications?.[eventType];
    if (!channels || channels.length === 0) return;

    const component = context?.evaluation?.metrics?.componentId || context?.evaluation?.metrics?.component || 'selfHealingEngine';
    const severity  = eventType === 'onFailure' ? 'error'
      : (eventType === 'onTrigger' && rule?.remediation?.priority === 1) ? 'critical'
      : (eventType === 'onTrigger') ? 'warning' : 'info';

    try {
      const fingerprint   = crypto.createHash('md5').update(`${rule.name}|${component}|${eventType}`).digest('hex');
      const createAlertFn = typeof Alert.createAlert === 'function' ? Alert.createAlert.bind(Alert) : Alert.create.bind(Alert);
      const alert = await createAlertFn({
        ruleId: rule.name, ruleName: rule.description || rule.name, severity,
        title:  `Self-Healing: ${rule.name} - ${eventType}`,
        message: formatNotificationMessage(rule, eventType, context),
        context: { component, metric: rule?.detectionQuery?.metric },
        channels, fingerprint, source: 'agentx',
        metadata: { ...context, eventType, ruleName: rule.name, strategy: rule.remediation.strategy }
      });
      await alertService._sendNotifications(alert, channels);
    } catch (error) {
      logger.error('Failed to send notification', { rule: rule.name, eventType, error: error.message });
    }
  }

  // ── Persistence ──────────────────────────────────────────────

  async _saveExecutionRecord(rule, data = {}) {
    try {
      const cooldownMs = data.status === 'success'
        ? parseTimeWindow(rule?.remediation?.cooldown || '15m', this.config.defaultCooldownMs) : 0;
      return await SelfHealingExecution.create({
        ruleName:  rule?.name || 'unknown_rule',
        strategy:  rule?.remediation?.strategy || 'unknown_strategy',
        action:    rule?.remediation?.action   || 'unknown_action',
        status:    data.status || 'failed', duration: data.duration || 0, error: data.error || null,
        cooldownMs, cooldownExpiresAt: cooldownMs > 0 ? new Date(Date.now() + cooldownMs) : null,
        approvalId: data.approvalId || null, triggerSource: data.triggerSource || 'auto',
        context: { ...(data.context || {}), result: data.result || null },
        executedAt: new Date()
      });
    } catch (error) {
      logger.warn('Failed to persist self-healing execution record', { rule: rule?.name, error: error.message });
      return null;
    }
  }

  async _createPendingApproval(rule, context = {}) {
    const existing = await SelfHealingApproval.findOne({ ruleName: rule.name, status: 'pending' }).sort({ createdAt: -1 });
    if (existing) return existing;
    const remediation    = rule?.remediation || {};
    const fallbackAction = remediation.action || remediation.strategy || 'approval_required_action';
    return SelfHealingApproval.create({
      ruleName: rule.name, strategy: remediation.strategy || 'unknown_strategy', action: fallbackAction,
      status: 'pending', reason: rule.description || '', ruleSnapshot: rule, context,
      requestedBy: context?.triggeredBy || 'system', requestedAt: new Date()
    });
  }

  // ── Public API ───────────────────────────────────────────────

  getRules()          { return this.rules; }
  getRuleConfigPath() { return this.ruleConfigPath; }

  getExecutionHistory() {
    return Array.from(this.executionHistory.entries()).map(([ruleName, timestamp]) => ({
      ruleName, lastExecuted: new Date(timestamp).toISOString(),
      cooldownRemaining: this._getCooldownRemaining(ruleName, this.rules.find(r => r.name === ruleName)?.remediation?.cooldown || '15m')
    }));
  }

  async getExecutionHistoryPersisted({ ruleName = null, limit = 200 } = {}) {
    try {
      const query = ruleName ? { ruleName } : {};
      const rows  = await SelfHealingExecution.find(query).sort({ executedAt: -1 }).limit(limit).lean();
      const now   = Date.now();
      return rows.map(row => {
        const expiresAtMs = row.cooldownExpiresAt ? new Date(row.cooldownExpiresAt).getTime() : 0;
        return {
          id: row._id?.toString?.() || String(row._id),
          ruleName: row.ruleName, strategy: row.strategy, action: row.action,
          status: row.status, duration: row.duration || 0, error: row.error || null,
          triggerSource: row.triggerSource || 'auto',
          lastExecuted: new Date(row.executedAt || row.createdAt).toISOString(),
          cooldownRemaining: Math.max(0, expiresAtMs - now),
          approvalId: row.approvalId ? row.approvalId.toString() : null
        };
      });
    } catch (error) {
      logger.warn('Falling back to in-memory self-healing history', { error: error.message });
      return this.getExecutionHistory();
    }
  }

  async getApprovals({ status = 'pending', limit = 100 } = {}) {
    try {
      const query = status ? { status } : {};
      const rows  = await SelfHealingApproval.find(query).sort({ requestedAt: -1 }).limit(limit).lean();
      return rows.map(row => ({
        id: row._id.toString(), ruleName: row.ruleName, strategy: row.strategy, action: row.action,
        status: row.status, reason: row.reason || '', requestedBy: row.requestedBy || 'system',
        requestedAt: row.requestedAt, decidedBy: row.decidedBy || null, decidedAt: row.decidedAt || null,
        decisionComment: row.decisionComment || ''
      }));
    } catch (error) {
      logger.warn('Failed to load self-healing approvals', { error: error.message });
      return [];
    }
  }

  async approveApproval(approvalId, decidedBy = 'admin', comment = '') {
    const approval = await SelfHealingApproval.findById(approvalId);
    if (!approval) throw new Error('Approval request not found');
    if (approval.status !== 'pending') throw new Error(`Approval request is already ${approval.status}`);

    approval.status = 'approved'; approval.decidedBy = decidedBy;
    approval.decidedAt = new Date(); approval.decisionComment = comment || '';
    await approval.save();

    const result = await this.executeRemediation(approval.ruleSnapshot, {
      ...(approval.context || {}), approvedBy: decidedBy, approvalId: approval._id.toString(), triggeredBy: 'approval'
    }, { bypassApproval: true, skipTriggerNotification: true, triggerSource: 'approval' });

    approval.status      = result.status === 'success' ? 'executed' : 'failed';
    approval.executionId = result.executionId || null;
    await approval.save();

    return { approvalId: approval._id.toString(), status: approval.status, execution: result };
  }

  async rejectApproval(approvalId, decidedBy = 'admin', comment = '') {
    const approval = await SelfHealingApproval.findById(approvalId);
    if (!approval) throw new Error('Approval request not found');
    if (approval.status !== 'pending') throw new Error(`Approval request is already ${approval.status}`);

    approval.status = 'rejected'; approval.decidedBy = decidedBy;
    approval.decidedAt = new Date(); approval.decisionComment = comment || '';
    await approval.save();
    return { approvalId: approval._id.toString(), status: approval.status };
  }

  async getCooldownStatus(ruleName, cooldownPeriod) {
    const remainingMs = await this._getCooldownRemainingDistributed(ruleName, cooldownPeriod);
    return { inCooldown: remainingMs > 0, cooldownRemaining: remainingMs };
  }

  async getThrottleState()                   { return this.stateStore.getThrottleState(); }
  async acquireEvaluationLock(ttlMs = 55000) { return this.stateStore.acquireEvaluationLock(ttlMs); }
  async releaseEvaluationLock(token)         { return this.stateStore.releaseEvaluationLock(token); }
}

module.exports = new SelfHealingEngine();
