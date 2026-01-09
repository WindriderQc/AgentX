/**
 * Alert Management Routes - Track 1: Alerts & Notifications
 * 
 * Provides endpoints for creating, managing, and querying alerts
 * Integrates with AlertService for rule-based alerting
 */

const express = require('express');
const router = express.Router();
const alertService = require('../src/services/alertService');
const Alert = require('../models/Alert');
const { optionalAuth } = require('../src/middleware/auth');
const logger = require('../config/logger');
const { getNotificationService } = require('../src/services/notificationService');
const { validateObjectId } = require('../src/helpers/objectIdValidator');

/**
 * Validates an email address format
 * @param {string} email - Email address to validate
 * @returns {boolean} True if valid email format
 */
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

/**
 * Validates a webhook URL to prevent SSRF attacks
 * @param {string} url - URL to validate
 * @returns {boolean} True if URL is safe
 */
const isValidWebhookUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  
  try {
    const parsed = new URL(url);
    
    // Only allow HTTP/HTTPS protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }
    
    // Block localhost and private IP ranges
    const hostname = parsed.hostname.toLowerCase();
    
    // Block localhost variations
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return false;
    }
    
    // Block private IPv4 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
    if (/^10\./.test(hostname) || 
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        /^192\.168\./.test(hostname)) {
      return false;
    }
    
    // Block link-local addresses (169.254.0.0/16)
    if (/^169\.254\./.test(hostname)) {
      return false;
    }
    
    // Block cloud metadata endpoints
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
      return false;
    }
    
    return true;
  } catch {
    return false;
  }
};

/**
 * Sanitizes webhook headers to prevent injection attacks
 * @param {object} headers - Headers object to sanitize
 * @returns {object} Sanitized headers
 */
const sanitizeWebhookHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') {
    return {};
  }
  
  // Dangerous headers that should not be user-configurable
  const blockedHeaders = [
    'host', 'content-length', 'transfer-encoding', 'connection',
    'upgrade', 'via', 'te', 'trailer', 'proxy-authorization'
  ];
  
  const sanitized = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (!blockedHeaders.includes(normalizedKey) && typeof value === 'string') {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
};

/**
 * Normalizes and validates channel configuration from user input
 * @param {object} channelConfig - Raw channel configuration from request
 * @returns {object} Normalized and validated channel configuration
 */
const normalizeChannelConfig = (channelConfig = {}) => {
  const normalized = {};

  if (channelConfig.email) {
    const recipients = channelConfig.email.recipients;
    const normalizedRecipients = Array.isArray(recipients)
      ? recipients.filter(Boolean)
      : typeof recipients === 'string'
        ? recipients.split(',').map(recipient => recipient.trim()).filter(Boolean)
        : undefined;

    const emailConfig = {};

    // Only include recipients if valid emails are present
    if (Array.isArray(normalizedRecipients) && normalizedRecipients.length > 0) {
      const validRecipients = normalizedRecipients.filter(isValidEmail);
      if (validRecipients.length > 0) {
        emailConfig.recipients = validRecipients;
      }
    }

    // Validate and include optional fields only if present
    if (channelConfig.email.subject && typeof channelConfig.email.subject === 'string') {
      emailConfig.subject = channelConfig.email.subject;
    }
    
    if (channelConfig.email.from && typeof channelConfig.email.from === 'string' && isValidEmail(channelConfig.email.from)) {
      emailConfig.from = channelConfig.email.from;
    }
    
    if (channelConfig.email.replyTo && typeof channelConfig.email.replyTo === 'string' && isValidEmail(channelConfig.email.replyTo)) {
      emailConfig.replyTo = channelConfig.email.replyTo;
    }

    if (Object.keys(emailConfig).length > 0) {
      normalized.email = emailConfig;
    }
  }

  if (channelConfig.webhook) {
    let headers = channelConfig.webhook.headers;
    if (typeof headers === 'string') {
      try {
        headers = JSON.parse(headers);
      } catch {
        headers = headers.split(',').reduce((acc, pair) => {
          const [key, value] = pair.split(':').map(part => part.trim());
          if (key && value) acc[key] = value;
          return acc;
        }, {});
      }
    }

    const webhookConfig = {};

    // Validate webhook URL to prevent SSRF
    if (channelConfig.webhook.url && isValidWebhookUrl(channelConfig.webhook.url)) {
      webhookConfig.url = channelConfig.webhook.url;
    }

    // Include method only if present
    if (channelConfig.webhook.method && typeof channelConfig.webhook.method === 'string') {
      webhookConfig.method = channelConfig.webhook.method;
    }

    // Sanitize headers to prevent header injection
    if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
      const sanitized = sanitizeWebhookHeaders(headers);
      if (Object.keys(sanitized).length > 0) {
        webhookConfig.headers = sanitized;
      }
    }

    // Include template only if present
    if (channelConfig.webhook.template && typeof channelConfig.webhook.template === 'string') {
      webhookConfig.template = channelConfig.webhook.template;
    }

    if (Object.keys(webhookConfig).length > 0) {
      normalized.webhook = webhookConfig;
    }
  }

  return normalized;
};

/**
 * POST /api/alerts
 * Create a new alert manually
 * Body: { ruleId, ruleName, severity, title, message, context, channels }
 */
router.post('/', optionalAuth, async (req, res) => {
  try {
    const {
      ruleId,
      ruleName,
      severity,
      title,
      message,
      source,
      context = {},
      channels = ['dataapi_log'],
      channelConfig = {},
      tags = [],
      metadata = {}
    } = req.body;

    // Validate required fields
    if (!title || !message || !severity || !source) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: title, message, severity, source'
      });
    }

    // Validate severity
    const validSeverities = ['info', 'warning', 'critical'];
    if (!validSeverities.includes(severity)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid severity. Must be: info, warning, or critical'
      });
    }

    // Validate and filter channels (graceful handling of unknown channels)
    const validChannels = ['email', 'slack', 'webhook', 'dataapi_log'];
    let filteredChannels = channels.filter(c => validChannels.includes(c));
    const normalizedChannelConfig = normalizeChannelConfig(channelConfig);

    if (normalizedChannelConfig.email && !filteredChannels.includes('email')) {
      filteredChannels.push('email');
    }
    if (normalizedChannelConfig.webhook && !filteredChannels.includes('webhook')) {
      filteredChannels.push('webhook');
    }

    // If all channels were invalid, default to dataapi_log
    if (filteredChannels.length === 0) {
      logger.warn('All provided channels were invalid, defaulting to dataapi_log', {
        providedChannels: channels
      });
      filteredChannels = ['dataapi_log'];
    }

    // Generate fingerprint
    const crypto = require('crypto');
    const fingerprint = crypto
      .createHash('md5')
      .update(`${ruleId || 'manual'}|${context.component || ''}|${context.metric || ''}`)
      .digest('hex');

    // Create alert
    const alert = new Alert({
      ruleId: ruleId || 'manual',
      ruleName: ruleName || 'Manual Alert',
      severity,
      title,
      message,
      context,
      channels: filteredChannels,
      channelConfig: normalizedChannelConfig,
      fingerprint,
      source: source || res.locals.user?.userId || 'manual',
      tags,
      metadata
    });

    await alert.save();

    // Send notifications
    await alertService._sendNotifications(alert, filteredChannels);

    logger.info('Alert created manually', { 
      alertId: alert._id, 
      userId: res.locals.user?.userId 
    });

    res.status(201).json({
      status: 'success',
      message: 'Alert created',
      data: {
        alert: {
          _id: alert._id.toString(),
          ruleId: alert.ruleId,
          severity: alert.severity,
          title: alert.title,
          status: alert.status,
          createdAt: alert.createdAt
        }
      }
    });
  } catch (error) {
    logger.error('Failed to create alert', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to create alert',
      error: error.message
    });
  }
});

/**
 * POST /api/alerts/evaluate
 * Evaluate an event against configured alert rules
 * Body: { component, metric, value, threshold, trend, source, additionalData }
 */
router.post('/evaluate', optionalAuth, async (req, res) => {
  try {
    const event = req.body;

    // Accept events in either format:
    // - { component, metric, value, ... }
    // - { source, data: { ...facts } }
    if (!event || typeof event !== 'object') {
      return res.status(400).json({
        status: 'error',
        message: 'Event payload is required'
      });
    }

    const alerts = await alertService.evaluateEvent(event);
    const matched = alerts.length > 0;

    res.json({
      status: 'success',
      data: {
        matched,
        alert: matched ? alerts[0] : null
      }
    });
  } catch (error) {
    logger.error('Failed to evaluate event', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to evaluate event',
      error: error.message
    });
  }
});

/**
 * GET /api/alerts
 * List alerts with filtering
 * Query params: severity, status, ruleId, limit, offset
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      severity,
      status,
      ruleId,
      limit = 50,
      skip = 0
    } = req.query;

    const filters = {};
    if (severity) filters.severity = severity;
    if (status) filters.status = status;
    if (ruleId) filters.ruleId = ruleId;

    const limitNum = parseInt(limit);
    const skipNum = parseInt(skip);

    // Sort by severity priority (critical -> error -> warning -> info), then recency
    const alerts = await Alert.aggregate([
      { $match: filters },
      {
        $addFields: {
          __severityRank: {
            $switch: {
              branches: [
                { case: { $eq: ['$severity', 'critical'] }, then: 3 },
                { case: { $eq: ['$severity', 'error'] }, then: 2 },
                { case: { $eq: ['$severity', 'warning'] }, then: 1 },
                { case: { $eq: ['$severity', 'info'] }, then: 0 }
              ],
              default: 0
            }
          }
        }
      },
      { $sort: { __severityRank: -1, createdAt: -1 } },
      { $skip: skipNum },
      { $limit: limitNum },
      { $project: { __severityRank: 0 } }
    ]);

    const total = await Alert.countDocuments(filters);

    res.json({
      status: 'success',
      data: {
        alerts,
        total,
        limit: limitNum,
        skip: skipNum
      }
    });
  } catch (error) {
    logger.error('Failed to list alerts', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to list alerts',
      error: error.message
    });
  }
});

/**
 * GET /api/alerts/statistics
 * Get comprehensive alert statistics for analytics dashboard
 * Query params: from, to (ISO date strings)
 * NOTE: Must be defined BEFORE /:id route to avoid parameter matching
 */
router.get('/statistics', optionalAuth, async (req, res) => {
  try {
    const { from, to } = req.query;

    // Build date filter
    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);

    const matchFilter = Object.keys(dateFilter).length > 0
      ? { createdAt: dateFilter }
      : {};

    // Comprehensive aggregation pipeline
    const results = await Alert.aggregate([
      { $match: matchFilter },
      {
        $facet: {
          // Overall summary
          summary: [
            {
              $group: {
                _id: null,
                totalAlerts: { $sum: 1 },
                activeAlerts: {
                  $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
                },
                acknowledgedAlerts: {
                  $sum: { $cond: [{ $eq: ['$status', 'acknowledged'] }, 1, 0] }
                },
                resolvedAlerts: {
                  $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] }
                },
                avgResolutionTime: {
                  $avg: {
                    $cond: [
                      { $and: [
                        { $eq: ['$resolution.resolved', true] },
                        { $ne: ['$resolution.resolvedAt', null] }
                      ]},
                      { $subtract: ['$resolution.resolvedAt', '$createdAt'] },
                      null
                    ]
                  }
                },
                avgAcknowledgmentTime: {
                  $avg: {
                    $cond: [
                      { $and: [
                        { $eq: ['$acknowledgment.acknowledged', true] },
                        { $ne: ['$acknowledgment.acknowledgedAt', null] }
                      ]},
                      { $subtract: ['$acknowledgment.acknowledgedAt', '$createdAt'] },
                      null
                    ]
                  }
                }
              }
            }
          ],

          // By severity
          bySeverity: [
            { $group: { _id: '$severity', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
          ],

          // By status
          byStatus: [
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
          ],

          // By source/component
          bySource: [
            { $group: { _id: '$source', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 20 }
          ],

          // By rule
          byRule: [
            {
              $group: {
                _id: '$ruleName',
                count: { $sum: 1 },
                avgOccurrences: { $avg: '$occurrenceCount' }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],

          // Delivery stats by channel
          deliveryStats: [
            { $unwind: { path: '$delivery', preserveNullAndEmptyArrays: true } },
            {
              $group: {
                _id: '$delivery.k',
                sent: {
                  $sum: { $cond: [{ $eq: ['$delivery.v.sent', true] }, 1, 0] }
                },
                failed: {
                  $sum: { $cond: [{ $eq: ['$delivery.v.sent', false] }, 1, 0] }
                }
              }
            }
          ],

          // Time series data (hourly buckets)
          timeSeries: [
            {
              $group: {
                _id: {
                  year: { $year: '$createdAt' },
                  month: { $month: '$createdAt' },
                  day: { $dayOfMonth: '$createdAt' },
                  hour: { $hour: '$createdAt' }
                },
                count: { $sum: 1 },
                critical: {
                  $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] }
                },
                high: {
                  $sum: { $cond: [{ $eq: ['$severity', 'high'] }, 1, 0] }
                },
                warning: {
                  $sum: { $cond: [
                    { $or: [
                      { $eq: ['$severity', 'warning'] },
                      { $eq: ['$severity', 'medium'] }
                    ]},
                    1,
                    0
                  ]}
                },
                info: {
                  $sum: { $cond: [
                    { $or: [
                      { $eq: ['$severity', 'info'] },
                      { $eq: ['$severity', 'low'] }
                    ]},
                    1,
                    0
                  ]}
                }
              }
            },
            { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 } }
          ],

          // Recurrence heatmap (day of week x hour of day)
          heatmap: [
            {
              $group: {
                _id: {
                  dayOfWeek: { $dayOfWeek: '$createdAt' },
                  hour: { $hour: '$createdAt' }
                },
                count: { $sum: 1 }
              }
            }
          ]
        }
      }
    ]);

    // Format the response
    const stats = results[0];

    // Convert arrays to objects for easier consumption
    const bySeverity = stats.bySeverity.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    const byStatus = stats.byStatus.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    const bySource = stats.bySource.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    res.json({
      status: 'success',
      data: {
        summary: stats.summary[0] || {
          totalAlerts: 0,
          activeAlerts: 0,
          acknowledgedAlerts: 0,
          resolvedAlerts: 0,
          avgResolutionTime: null,
          avgAcknowledgmentTime: null
        },
        bySeverity,
        byStatus,
        bySource,
        byRule: stats.byRule,
        deliveryStats: stats.deliveryStats,
        timeSeries: stats.timeSeries,
        heatmap: stats.heatmap,
        generatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Failed to get alert statistics', { error: error.message, stack: error.stack });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get alert statistics',
      error: error.message
    });
  }
});

/**
 * GET /api/alerts/:id
 * Get a specific alert by ID
 */
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
