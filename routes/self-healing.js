const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const router = express.Router();
const SelfHealingEngine = require('../src/services/selfHealingEngine');
const RulesValidator = require('../src/utils/validateRules');
const logger = require('../config/logger');
const { optionalAuth, requireAuth } = require('../src/middleware/auth');
const { auditLog, auditSelfHealingOps } = require('../src/middleware/auditLogger');

const DEFAULT_RULES_CONFIG_PATH = path.join(__dirname, '../config/self-healing-rules.json');
const REPO_ROOT = path.resolve(path.join(__dirname, '..'));

const auditRulesChanged = auditLog('self_healing_rules_changed', 'warning', {
  resource: 'self_healing_rule',
  includeBody: true
});

const auditApprovalDecision = auditLog('self_healing_approval_decision', 'critical', {
  resource: 'system',
  includeBody: true
});

const auditEvaluation = auditLog('self_healing_evaluated', 'info', {
  resource: 'system',
  includeBody: true
});

function requireSelfHealingOperator(req, res, next) {
  const user = res.locals.user || {};
  const isPrivilegedUser = user.isAdmin === true;
  const isApiKey = req.authSource === 'api-key' || req.authSource === 'api-key-v2';

  if (isPrivilegedUser || isApiKey) {
    return next();
  }

  return res.status(403).json({
    status: 'error',
    message: 'Admin or API key access required'
  });
}

function resolveConfigPath(customPath) {
  const candidate = customPath || SelfHealingEngine.getRuleConfigPath() || DEFAULT_RULES_CONFIG_PATH;
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(REPO_ROOT)) {
    throw new Error('Config path must be inside repository root');
  }
  return resolved;
}

async function readRulesConfig(customPath = null) {
  const configPath = resolveConfigPath(customPath);
  const content = await fs.readFile(configPath, 'utf-8');
  const rules = JSON.parse(content);

  if (!Array.isArray(rules)) {
    throw new Error('Rules configuration must be an array');
  }

  return { rules, configPath };
}

async function validateRulesOrThrow(rules) {
  const validator = new RulesValidator();
  const result = validator.validateRules(rules);
  if (!result.valid) {
    throw new Error(`Rules validation failed: ${JSON.stringify(result.errors)}`);
  }
}

async function writeRulesConfig(rules, configPath) {
  await validateRulesOrThrow(rules);
  await fs.writeFile(configPath, JSON.stringify(rules, null, 2) + '\n', 'utf-8');
  await SelfHealingEngine.loadRules(configPath);
}

// All self-healing endpoints require authentication.
router.use(optionalAuth, requireAuth);

/**
 * GET /api/self-healing/rules
 * Get all self-healing rules from canonical config (enabled + disabled)
 */
router.get('/rules', async (req, res) => {
  try {
    const { rules } = await readRulesConfig();

    res.json({
      status: 'success',
      data: {
        rules,
        count: rules.length,
        enabledCount: rules.filter(r => r.enabled !== false).length,
        disabledCount: rules.filter(r => r.enabled === false).length
      }
    });
  } catch (error) {
    logger.error('Failed to get rules', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve rules',
      error: error.message
    });
  }
});

/**
 * GET /api/self-healing/rules/:name
 * Get a specific rule by name
 */
router.get('/rules/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { rules } = await readRulesConfig();
    const rule = rules.find(r => r.name === name);

    if (!rule) {
      return res.status(404).json({
        status: 'error',
        message: 'Rule not found',
        name
      });
    }

    res.json({
      status: 'success',
      data: { rule }
    });
  } catch (error) {
    logger.error('Failed to get rule', { error: error.message, name: req.params.name });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve rule',
      error: error.message
    });
  }
});

/**
 * POST /api/self-healing/rules
 * Create a new rule
 */
router.post('/rules', requireSelfHealingOperator, auditRulesChanged, async (req, res) => {
  try {
    const newRule = req.body || {};
    if (!newRule.name) {
      return res.status(400).json({
        status: 'error',
        message: 'Rule name is required'
      });
    }

    const { rules, configPath } = await readRulesConfig();
    if (rules.some(rule => rule.name === newRule.name)) {
      return res.status(409).json({
        status: 'error',
        message: `Rule ${newRule.name} already exists`
      });
    }

    rules.push(newRule);
    await writeRulesConfig(rules, configPath);

    res.status(201).json({
      status: 'success',
      message: 'Rule created',
      data: { rule: newRule }
    });
  } catch (error) {
    logger.error('Failed to create rule', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to create rule',
      error: error.message
    });
  }
});

/**
 * PUT /api/self-healing/rules/:name
 * Update an existing rule
 */
router.put('/rules/:name', requireSelfHealingOperator, auditRulesChanged, async (req, res) => {
  try {
    const { name } = req.params;
    const updatedRule = req.body || {};

    const { rules, configPath } = await readRulesConfig();
    const idx = rules.findIndex(r => r.name === name);

    if (idx === -1) {
      return res.status(404).json({
        status: 'error',
        message: 'Rule not found',
        name
      });
    }

    if (updatedRule.name && updatedRule.name !== name && rules.some(r => r.name === updatedRule.name)) {
      return res.status(409).json({
        status: 'error',
        message: `Rule ${updatedRule.name} already exists`
      });
    }

    rules[idx] = {
      ...rules[idx],
      ...updatedRule,
      name: updatedRule.name || name
    };

    await writeRulesConfig(rules, configPath);

    res.json({
      status: 'success',
      message: 'Rule updated',
      data: { rule: rules[idx] }
    });
  } catch (error) {
    logger.error('Failed to update rule', { error: error.message, name: req.params.name });
    res.status(500).json({
      status: 'error',
      message: 'Failed to update rule',
      error: error.message
    });
  }
});

/**
 * PATCH /api/self-healing/rules/:name/toggle
 * Enable or disable an existing rule
 */
router.patch('/rules/:name/toggle', requireSelfHealingOperator, auditRulesChanged, async (req, res) => {
  try {
    const { name } = req.params;
    const enabled = req.body?.enabled;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        status: 'error',
        message: 'enabled (boolean) is required'
      });
    }

    const { rules, configPath } = await readRulesConfig();
    const rule = rules.find(r => r.name === name);

    if (!rule) {
      return res.status(404).json({
        status: 'error',
        message: 'Rule not found',
        name
      });
    }

    rule.enabled = enabled;
    await writeRulesConfig(rules, configPath);

    res.json({
      status: 'success',
      message: `Rule ${enabled ? 'enabled' : 'disabled'}`,
      data: { rule }
    });
  } catch (error) {
    logger.error('Failed to toggle rule', { error: error.message, name: req.params.name });
    res.status(500).json({
      status: 'error',
      message: 'Failed to toggle rule',
      error: error.message
    });
  }
});

/**
 * DELETE /api/self-healing/rules/:name
 * Delete a rule
 */
router.delete('/rules/:name', requireSelfHealingOperator, auditRulesChanged, async (req, res) => {
  try {
    const { name } = req.params;

    const { rules, configPath } = await readRulesConfig();
    const idx = rules.findIndex(r => r.name === name);

    if (idx === -1) {
      return res.status(404).json({
        status: 'error',
        message: 'Rule not found',
        name
      });
    }

    const [deletedRule] = rules.splice(idx, 1);
    await writeRulesConfig(rules, configPath);

    res.json({
      status: 'success',
      message: 'Rule deleted',
      data: { deletedRule }
    });
  } catch (error) {
    logger.error('Failed to delete rule', { error: error.message, name: req.params.name });
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete rule',
      error: error.message
    });
  }
});

/**
 * POST /api/self-healing/rules/load
 * Reload rules from configuration file
 */
router.post('/rules/load', requireSelfHealingOperator, auditRulesChanged, async (req, res) => {
  try {
    const configPath = resolveConfigPath(req.body?.configPath);
    const count = await SelfHealingEngine.loadRules(configPath);

    res.json({
      status: 'success',
      message: 'Rules loaded successfully',
      data: {
        count,
        configPath,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Failed to load rules', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to load rules',
      error: error.message
    });
  }
});

/**
 * POST /api/self-healing/evaluate
 * Evaluate a specific rule or all enabled rules
 */
router.post('/evaluate', requireSelfHealingOperator, auditEvaluation, async (req, res) => {
  try {
    const { ruleName, metricsData } = req.body || {};

    if (ruleName) {
      const { rules } = await readRulesConfig();
      const rule = rules.find(r => r.name === ruleName);

      if (!rule) {
        return res.status(404).json({
          status: 'error',
          message: 'Rule not found',
          ruleName
        });
      }

      const evaluation = await SelfHealingEngine.evaluateRule(rule, metricsData);

      return res.json({
        status: 'success',
        data: {
          rule: ruleName,
          evaluation
        }
      });
    }

    const results = await SelfHealingEngine.evaluateAndExecute(metricsData);

    res.json({
      status: 'success',
      message: 'Rules evaluated',
      data: {
        results,
        triggered: results.filter(r => r.status === 'success').length,
        pendingApproval: results.filter(r => r.status === 'pending_approval').length,
        failed: results.filter(r => r.status === 'failed').length,
        skipped: results.filter(r => r.status === 'skipped').length
      }
    });
  } catch (error) {
    logger.error('Rule evaluation failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Rule evaluation failed',
      error: error.message
    });
  }
});

/**
 * POST /api/self-healing/execute
 * Execute remediation for a specific rule (manual trigger)
 */
router.post('/execute', requireSelfHealingOperator, auditSelfHealingOps.triggered, async (req, res) => {
  try {
    const { ruleName, context, force } = req.body || {};

    if (!ruleName) {
      return res.status(400).json({
        status: 'error',
        message: 'ruleName is required'
      });
    }

    const { rules } = await readRulesConfig();
    const rule = rules.find(r => r.name === ruleName);

    if (!rule) {
      return res.status(404).json({
        status: 'error',
        message: 'Rule not found',
        ruleName
      });
    }

    if (rule.enabled === false) {
      return res.status(400).json({
        status: 'error',
        message: `Rule ${ruleName} is disabled`
      });
    }

    if (!force) {
      const cooldown = await SelfHealingEngine.getCooldownStatus(rule.name, rule.remediation.cooldown);
      if (cooldown.inCooldown) {
        return res.status(409).json({
          status: 'error',
          message: 'Rule is in cooldown',
          data: {
            rule: ruleName,
            cooldownRemaining: cooldown.cooldownRemaining
          }
        });
      }
    }

    const result = await SelfHealingEngine.executeRemediation(rule, context || {}, {
      triggerSource: 'manual'
    });

    const statusCode = result.status === 'success'
      ? 200
      : result.status === 'failed'
        ? 500
        : 202;

    res.status(statusCode).json({
      status: 'success',
      message: 'Remediation executed',
      data: result
    });
  } catch (error) {
    logger.error('Remediation execution failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Remediation execution failed',
      error: error.message
    });
  }
});

/**
 * GET /api/self-healing/history
 * Get execution history for all rules
 */
router.get('/history', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '200', 10)));
    const history = await SelfHealingEngine.getExecutionHistoryPersisted({ limit });

    res.json({
      status: 'success',
      data: {
        history,
        count: history.length
      }
    });
  } catch (error) {
    logger.error('Failed to get execution history', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve execution history',
      error: error.message
    });
  }
});

/**
 * GET /api/self-healing/history/:ruleName
 * Get execution history for a specific rule
 */
router.get('/history/:ruleName', async (req, res) => {
  try {
    const { ruleName } = req.params;
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit || '200', 10)));
    const history = await SelfHealingEngine.getExecutionHistoryPersisted({ ruleName, limit });

    res.json({
      status: 'success',
      data: {
        ruleName,
        history,
        count: history.length
      }
    });
  } catch (error) {
    logger.error('Failed to get rule history', { error: error.message, ruleName: req.params.ruleName });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve rule history',
      error: error.message
    });
  }
});

/**
 * GET /api/self-healing/approvals
 * List pending or decided approvals
 */
router.get('/approvals', requireSelfHealingOperator, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '100', 10)));
    const approvals = await SelfHealingEngine.getApprovals({ status, limit });

    res.json({
      status: 'success',
      data: {
        approvals,
        count: approvals.length
      }
    });
  } catch (error) {
    logger.error('Failed to list approvals', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve approvals',
      error: error.message
    });
  }
});

/**
 * POST /api/self-healing/approvals/:approvalId/approve
 * Approve and execute a pending remediation
 */
router.post('/approvals/:approvalId/approve', requireSelfHealingOperator, auditApprovalDecision, async (req, res) => {
  try {
    const { approvalId } = req.params;
    const actor = req.user || res.locals.user || {};
    const decidedBy = actor.email || actor.name || actor.userId || 'admin';
    const comment = req.body?.comment || '';

    const result = await SelfHealingEngine.approveApproval(approvalId, decidedBy, comment);

    res.json({
      status: 'success',
      message: 'Approval accepted and remediation executed',
      data: result
    });
  } catch (error) {
    logger.error('Failed to approve remediation', { error: error.message, approvalId: req.params.approvalId });
    res.status(500).json({
      status: 'error',
      message: 'Failed to approve remediation',
      error: error.message
    });
  }
});

/**
 * POST /api/self-healing/approvals/:approvalId/reject
 * Reject a pending remediation
 */
router.post('/approvals/:approvalId/reject', requireSelfHealingOperator, auditApprovalDecision, async (req, res) => {
  try {
    const { approvalId } = req.params;
    const actor = req.user || res.locals.user || {};
    const decidedBy = actor.email || actor.name || actor.userId || 'admin';
    const comment = req.body?.comment || '';

    const result = await SelfHealingEngine.rejectApproval(approvalId, decidedBy, comment);

    res.json({
      status: 'success',
      message: 'Approval rejected',
      data: result
    });
  } catch (error) {
    logger.error('Failed to reject remediation', { error: error.message, approvalId: req.params.approvalId });
    res.status(500).json({
      status: 'error',
      message: 'Failed to reject remediation',
      error: error.message
    });
  }
});

/**
 * GET /api/self-healing/status
 * Get overall self-healing engine status
 */
router.get('/status', async (req, res) => {
  try {
    const { rules } = await readRulesConfig();
    const enabledRules = rules.filter(r => r.enabled !== false);
    const history = await SelfHealingEngine.getExecutionHistoryPersisted({ limit: 500 });
    const pendingApprovals = await SelfHealingEngine.getApprovals({ status: 'pending', limit: 500 });

    const status = {
      enabled: SelfHealingEngine.config.enableAutomation,
      requireApproval: SelfHealingEngine.config.requireApprovalForCritical,
      maxConcurrentActions: SelfHealingEngine.config.maxConcurrentActions,
      evaluationIntervalMs: SelfHealingEngine.config.evaluationIntervalMs,
      rules: {
        total: rules.length,
        enabled: enabledRules.length,
        disabled: rules.length - enabledRules.length,
        byStrategy: enabledRules.reduce((acc, r) => {
          const strategy = r.remediation?.strategy || 'unknown';
          acc[strategy] = (acc[strategy] || 0) + 1;
          return acc;
        }, {}),
        byPriority: enabledRules.reduce((acc, r) => {
          const priority = r.remediation?.priority || 999;
          acc[`priority_${priority}`] = (acc[`priority_${priority}`] || 0) + 1;
          return acc;
        }, {})
      },
      executions: {
        total: history.length,
        success: history.filter(h => h.status === 'success').length,
        failed: history.filter(h => h.status === 'failed').length,
        skipped: history.filter(h => h.status === 'skipped').length,
        pendingApproval: history.filter(h => h.status === 'pending_approval').length,
        recentlyExecuted: history.filter(h => h.cooldownRemaining > 0).length,
        availableNow: history.filter(h => h.cooldownRemaining === 0).length
      },
      approvals: {
        pending: pendingApprovals.length
      },
      timestamp: new Date().toISOString()
    };

    res.json({
      status: 'success',
      data: status
    });
  } catch (error) {
    logger.error('Failed to get status', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve status',
      error: error.message
    });
  }
});

module.exports = router;
