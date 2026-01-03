const express = require('express');
const router = express.Router();
const SelfHealingEngine = require('../src/services/selfHealingEngine');
const logger = require('../config/logger');

/**
 * Self-Healing API Routes - Track 4: Self-Healing & Resilience
 * 
 * Endpoints for managing and monitoring self-healing rules and executions.
 */

/**
 * GET /api/self-healing/rules
 * Get all self-healing rules
 */
router.get('/rules', async (req, res) => {
  try {
    const rules = SelfHealingEngine.getRules();

    res.json({
      status: 'success',
      data: {
        rules,
        count: rules.length
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
    const rules = SelfHealingEngine.getRules();
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
 * POST /api/self-healing/rules/load
 * Reload rules from configuration file
 */
router.post('/rules/load', async (req, res) => {
  try {
    const configPath = req.body.configPath; // Optional custom path
    const count = await SelfHealingEngine.loadRules(configPath);

    res.json({
      status: 'success',
      message: 'Rules loaded successfully',
      data: {
        count,
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
 * Evaluate a specific rule or all rules
 */
router.post('/evaluate', async (req, res) => {
  try {
    const { ruleName, metricsData } = req.body;

    if (ruleName) {
      // Evaluate single rule
      const rules = SelfHealingEngine.getRules();
      const rule = rules.find(r => r.name === ruleName);

      if (!rule) {
        return res.status(404).json({
          status: 'error',
          message: 'Rule not found',
          ruleName
        });
      }

      const evaluation = await SelfHealingEngine.evaluateRule(rule, metricsData);

      res.json({
        status: 'success',
        data: {
          rule: ruleName,
          evaluation
        }
      });
    } else {
      // Evaluate all rules
      const results = await SelfHealingEngine.evaluateAndExecute(metricsData);

      res.json({
        status: 'success',
        message: 'Rules evaluated',
        data: {
          results,
          triggered: results.filter(r => r.status === 'success').length,
          failed: results.filter(r => r.status === 'failed').length,
          skipped: results.filter(r => r.status === 'skipped').length
        }
      });
    }
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
router.post('/execute', async (req, res) => {
  try {
    const { ruleName, context } = req.body;

    if (!ruleName) {
      return res.status(400).json({
        status: 'error',
        message: 'ruleName is required'
      });
    }

    const rules = SelfHealingEngine.getRules();
    const rule = rules.find(r => r.name === ruleName);

    if (!rule) {
      return res.status(404).json({
        status: 'error',
        message: 'Rule not found',
        ruleName
      });
    }

    const result = await SelfHealingEngine.executeRemediation(rule, context || {});

    const statusCode = result.status === 'success' ? 200 : 
                       result.status === 'failed' ? 500 : 202;

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
    const history = SelfHealingEngine.getExecutionHistory();

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
    const history = SelfHealingEngine.getExecutionHistory();
    const ruleHistory = history.filter(h => h.ruleName === ruleName);

    res.json({
      status: 'success',
      data: {
        ruleName,
        history: ruleHistory,
        count: ruleHistory.length
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
 * GET /api/self-healing/status
 * Get overall self-healing engine status
 */
router.get('/status', async (req, res) => {
  try {
    const rules = SelfHealingEngine.getRules();
    const history = SelfHealingEngine.getExecutionHistory();

    const status = {
      enabled: SelfHealingEngine.config.enableAutomation,
      requireApproval: SelfHealingEngine.config.requireApprovalForCritical,
      maxConcurrentActions: SelfHealingEngine.config.maxConcurrentActions,
      rules: {
        total: rules.length,
        enabled: rules.filter(r => r.enabled !== false).length,
        byStrategy: rules.reduce((acc, r) => {
          const strategy = r.remediation.strategy;
          acc[strategy] = (acc[strategy] || 0) + 1;
          return acc;
        }, {}),
        byPriority: rules.reduce((acc, r) => {
          const priority = r.remediation.priority || 999;
          acc[`priority_${priority}`] = (acc[`priority_${priority}`] || 0) + 1;
          return acc;
        }, {})
      },
      executions: {
        total: history.length,
        recentlyExecuted: history.filter(h => h.cooldownRemaining > 0).length,
        availableNow: history.filter(h => h.cooldownRemaining === 0).length
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
