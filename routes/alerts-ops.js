'use strict';
/**
 * Alert Operations Routes (CRUD by ID, rules, test, notifications)
 * Extracted from alerts.js — mounted via router.use() in alerts.js.
 *
 * Note: isValidWebhookUrl / sanitizeWebhookHeaders / normalizeChannelConfig
 * are only needed by the POST /create and POST /evaluate routes that remain
 * in the parent alerts.js. No helpers are required here.
 */

const express = require('express');
const router = express.Router();
const alertService = require('../src/services/alertService');
const Alert = require('../models/Alert');
const { optionalAuth } = require('../src/middleware/auth');
const logger = require('../config/logger');
const { getNotificationService } = require('../src/services/notificationService');
const { validateObjectId } = require('../src/helpers/objectIdValidator');

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid alert ID'
      });
    }

    const alert = await Alert.findById(req.params.id);

    if (!alert) {
      return res.status(404).json({
        status: 'error',
        message: 'Alert not found'
      });
    }

    res.json({
      status: 'success',
      data: { alert }
    });
  } catch (error) {
    logger.error('Failed to get alert', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get alert',
      error: error.message
    });
  }
});

/**
 * PUT /api/alerts/:id/acknowledge
 * Acknowledge an alert
 * Body: { comment }
 */
router.put('/:id/acknowledge', optionalAuth, async (req, res) => {
  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Alert ID')) return;

    const { acknowledgedBy } = req.body;

    if (!acknowledgedBy) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required field: acknowledgedBy'
      });
    }

    await alertService.acknowledgeAlert(req.params.id, acknowledgedBy, req.body.comment);

    const alert = await Alert.findById(req.params.id);

    res.json({
      status: 'success',
      message: 'Alert acknowledged',
      data: {
        alert: {
          ...alert.toObject(),
          acknowledgedBy: alert.acknowledgment?.acknowledgedBy,
          acknowledgedAt: alert.acknowledgment?.acknowledgedAt
        }
      }
    });
  } catch (error) {
    logger.error('Failed to acknowledge alert', { error: error.message });
    
    if (error.message === 'Alert not found') {
      return res.status(404).json({
        status: 'error',
        message: error.message
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Failed to acknowledge alert',
      error: error.message
    });
  }
});

/**
 * PUT /api/alerts/:id/resolve
 * Resolve an alert
 * Body: { method, comment }
 */
router.put('/:id/resolve', optionalAuth, async (req, res) => {
  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Alert ID')) return;

    const { resolvedBy, resolution, method = 'manual' } = req.body;

    if (!resolvedBy) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required field: resolvedBy'
      });
    }

    await alertService.resolveAlert(req.params.id, resolvedBy, method, resolution);

    const alert = await Alert.findById(req.params.id);

    res.json({
      status: 'success',
      message: 'Alert resolved',
      data: {
        alert: {
          ...alert.toObject(),
          resolvedBy: alert.resolution?.resolvedBy,
          resolvedAt: alert.resolution?.resolvedAt,
          resolution: alert.resolution?.comment
        }
      }
    });
  } catch (error) {
    logger.error('Failed to resolve alert', { error: error.message });
    
    if (error.message === 'Alert not found') {
      return res.status(404).json({
        status: 'error',
        message: error.message
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Failed to resolve alert',
      error: error.message
    });
  }
});

/**
 * POST /api/alerts/:id/delivery-status
 * Update delivery status for an alert (called by n8n workflows)
 * Body: { channel, sent, error }
 */
router.post('/:id/delivery-status', optionalAuth, async (req, res) => {
  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Alert ID')) return;

    const { channel, status, error, timestamp } = req.body;

    if (!channel) {
      return res.status(400).json({
        status: 'error',
        message: 'Channel is required'
      });
    }

    const alert = await Alert.findById(req.params.id);

    if (!alert) {
      return res.status(404).json({
        status: 'error',
        message: 'Alert not found'
      });
    }

    const sent = status === 'sent';
    const sentAt = timestamp ? new Date(timestamp) : new Date();

    // Update delivery status (virtual alias deliveryStatus maps to delivery)
    const deliveryStatus = alert.deliveryStatus || {};
    deliveryStatus[channel] = deliveryStatus[channel] || {};
    deliveryStatus[channel].sent = sent;
    deliveryStatus[channel].sentAt = sent ? sentAt : undefined;
    deliveryStatus[channel].error = !sent ? (error || undefined) : undefined;
    alert.deliveryStatus = deliveryStatus;

    await alert.save();

    res.json({
      status: 'success',
      message: 'Delivery status updated',
      data: {
        alert
      }
    });
  } catch (error) {
    logger.error('Failed to update delivery status', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to update delivery status',
      error: error.message
    });
  }
});

/**
 * GET /api/alerts/stats/summary
 * Get alert statistics
 * Query params: from, to, severity, status
 */
router.get('/stats/summary', optionalAuth, async (req, res) => {
  try {
    const { from, to, severity, status } = req.query;

    const filters = {};
    if (from) filters.from = from;
    if (to) filters.to = to;
    if (severity) filters.severity = severity;
    if (status) filters.status = status;

    const statsArray = await alertService.getStatistics(filters);
    const stats = statsArray?.[0] || { total: 0, bySeverity: {}, byStatus: {} };

    res.json({
      status: 'success',
      data: {
        statistics: stats
      }
    });
  } catch (error) {
    logger.error('Failed to get alert statistics', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get alert statistics',
      error: error.message
    });
  }
});

/**
 * POST /api/alerts/rules/load
 * Load alert rules from configuration
 * Body: { rules: [...] } or reload from file if no body
 */
router.post('/rules/load', optionalAuth, async (req, res) => {
  try {
    let rules;

    if (req.body.rules && Array.isArray(req.body.rules)) {
      rules = req.body.rules;
    } else {
      // Load from default file
      const RulesValidator = require('../src/utils/validateRules');
      const validator = new RulesValidator();
      const result = validator.loadAndValidate();

      if (!result.valid) {
        return res.status(400).json({
          status: 'error',
          message: 'Rules validation failed',
          errors: result.errors,
          warnings: result.warnings
        });
      }

      rules = validator.getEnabledRules();
    }

    const count = alertService.loadRules(rules);
    const enabledCount = rules.filter(r => r.enabled !== false).length;

    logger.info('Alert rules loaded', { count, userId: res.locals.user?.userId });

    res.json({
      status: 'success',
      message: `Loaded ${count} alert rules`,
      data: {
        loadedCount: count,
        enabledCount: enabledCount
      }
    });
  } catch (error) {
    logger.error('Failed to load alert rules', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to load alert rules',
      error: error.message
    });
  }
});

/**
 * GET /api/alerts/test/config
 * Get current alert service configuration (for debugging)
 */
router.get('/test/config', optionalAuth, async (req, res) => {
  try {
    const enabledChannels = [];
    if (alertService.config.email.enabled) enabledChannels.push('email');
    if (alertService.config.slack.enabled) enabledChannels.push('slack');
    if (alertService.config.webhook.enabled) enabledChannels.push('webhook');
    if (alertService.config.dataapi.enabled) enabledChannels.push('dataapi');

    const config = {
      email: {
        enabled: alertService.config.email.enabled,
        from: alertService.config.email.from,
        to: alertService.config.email.to
      },
      slack: {
        enabled: alertService.config.slack.enabled,
        webhookConfigured: !!alertService.config.slack.webhookUrl
      },
      webhook: {
        enabled: alertService.config.webhook.enabled,
        urlConfigured: !!alertService.config.webhook.url
      },
      dataapi: {
        enabled: alertService.config.dataapi.enabled,
        url: alertService.config.dataapi.url
      },
      testMode: alertService.testMode,
      cooldownMs: alertService.config.cooldownMs,
      maxOccurrences: alertService.config.maxOccurrences,
      rulesLoaded: alertService.rules.length,
      enabledChannels
    };

    res.json({
      status: 'success',
      data: { config }
    });
  } catch (error) {
    logger.error('Failed to get alert config', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get alert config',
      error: error.message
    });
  }
});

/**
 * GET /api/alerts/notifications/status
 * Get notification channels configuration status
 */
router.get('/notifications/status', optionalAuth, async (req, res) => {
  try {
    const notificationService = getNotificationService();
    const status = notificationService.getStatus();

    res.json({
      status: 'success',
      data: status
    });
  } catch (error) {
    logger.error('Failed to get notification status', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get notification status',
      error: error.message
    });
  }
});

/**
 * POST /api/alerts/notifications/test
 * Test a notification channel
 * Body: { channel: 'email' | 'slack' | 'webhook' }
 */
router.post('/notifications/test', optionalAuth, async (req, res) => {
  try {
    const { channel } = req.body;

    if (!channel) {
      return res.status(400).json({
        status: 'error',
        message: 'Channel parameter required'
      });
    }

    const validChannels = ['email', 'slack', 'webhook'];
    if (!validChannels.includes(channel)) {
      return res.status(400).json({
        status: 'error',
        message: `Invalid channel. Must be one of: ${validChannels.join(', ')}`
      });
    }

    const notificationService = getNotificationService();

    // Create test alert
    const testAlert = {
      _id: 'test-alert-id',
      title: 'Test Alert - AgentX Notification System',
      message: 'This is a test alert to verify notification channel configuration.',
      severity: 'info',
      ruleName: 'Test Rule',
      ruleId: 'test-rule',
      source: 'agentx-test',
      context: {
        component: 'notification-test',
        metric: 'test',
        currentValue: 100,
        threshold: 80
      },
      createdAt: new Date(),
      status: 'active'
    };

    // Send test notification
    const result = await notificationService.send(channel, testAlert);

    res.json({
      status: 'success',
      data: {
        channel,
        sent: result.sent,
        error: result.error,
        message: result.sent
          ? `Test notification sent successfully to ${channel}`
          : `Failed to send test notification: ${result.error}`
      }
    });
  } catch (error) {
    logger.error('Failed to test notification', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to test notification',
      error: error.message
    });
  }
});

/**
 * POST /api/alerts/notifications/verify
 * Verify notification channel configuration
 * Body: { channel: 'email' | 'slack' | 'webhook' }
 */
router.post('/notifications/verify', optionalAuth, async (req, res) => {
  try {
    const { channel } = req.body;

    if (!channel) {
      return res.status(400).json({
        status: 'error',
        message: 'Channel parameter required'
      });
    }

    const validChannels = ['email', 'slack', 'webhook'];
    if (!validChannels.includes(channel)) {
      return res.status(400).json({
        status: 'error',
        message: `Invalid channel. Must be one of: ${validChannels.join(', ')}`
      });
    }

    const notificationService = getNotificationService();
    const verificationResult = await notificationService.verifyChannel(channel);

    res.json({
      status: 'success',
      data: {
        channel,
        ...verificationResult
      }
    });
  } catch (error) {
    logger.error('Failed to verify notification channel', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to verify notification channel',
      error: error.message
    });
  }
});


module.exports = router;
