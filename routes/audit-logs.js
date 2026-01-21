/**
 * Audit Log Routes
 *
 * API endpoints for querying and viewing audit logs
 */

const express = require('express');
const router = express.Router();
const AuditLog = require('../models/AuditLog');
const { requireAuth, requireAdmin } = require('../src/middleware/auth');
const logger = require('../config/logger');

/**
 * GET /api/audit-logs
 * Query audit logs with filters
 */
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      userId,
      action,
      resource,
      severity,
      status,
      startDate,
      endDate,
      limit = 100,
      offset = 0,
      sort = '-timestamp'
    } = req.query;

    // Parse limit and offset
    const parsedLimit = Math.min(parseInt(limit, 10) || 100, 1000); // Max 1000
    const parsedOffset = parseInt(offset, 10) || 0;

    // Build filters
    const filters = {};
    if (userId) filters.userId = userId;
    if (action) filters.action = action;
    if (resource) filters.resource = resource;
    if (severity) filters.severity = severity;
    if (status) filters.status = status;
    if (startDate || endDate) {
      filters.timestamp = {};
      if (startDate) filters.timestamp.$gte = new Date(startDate);
      if (endDate) filters.timestamp.$lte = new Date(endDate);
    }

    // Query logs
    const logs = await AuditLog.find(filters)
      .sort(sort)
      .limit(parsedLimit)
      .skip(parsedOffset)
      .populate('userId', 'name email')
      .lean();

    // Get total count
    const totalCount = await AuditLog.countDocuments(filters);

    res.json({
      status: 'success',
      data: {
        logs: logs.map(log => ({
          id: log._id,
          timestamp: log.timestamp,
          username: log.username,
          authSource: log.authSource,
          action: log.action,
          resource: log.resource,
          resourceId: log.resourceId,
          resourceName: log.resourceName,
          severity: log.severity,
          status: log.status,
          ipAddress: log.ipAddress,
          details: log.details,
          errorMessage: log.errorMessage
        })),
        pagination: {
          total: totalCount,
          limit: parsedLimit,
          offset: parsedOffset,
          hasMore: parsedOffset + parsedLimit < totalCount
        }
      }
    });
  } catch (error) {
    logger.error('Query audit logs error', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * GET /api/audit-logs/stats
 * Get audit log statistics
 */
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const filters = {};
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    const stats = await AuditLog.getStats(filters);

    res.json({
      status: 'success',
      data: stats
    });
  } catch (error) {
    logger.error('Get audit stats error', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * GET /api/audit-logs/actions
 * Get list of available audit actions
 */
router.get('/actions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const actions = [
      { value: 'api_key_created', label: 'API Key Created', category: 'api_key' },
      { value: 'api_key_revoked', label: 'API Key Revoked', category: 'api_key' },
      { value: 'api_key_rotated', label: 'API Key Rotated', category: 'api_key' },

      { value: 'prompt_created', label: 'Prompt Created', category: 'prompt' },
      { value: 'prompt_activated', label: 'Prompt Activated', category: 'prompt' },
      { value: 'prompt_deactivated', label: 'Prompt Deactivated', category: 'prompt' },
      { value: 'prompt_deleted', label: 'Prompt Deleted', category: 'prompt' },

      { value: 'model_deployed', label: 'Model Deployed', category: 'model' },
      { value: 'model_deleted', label: 'Model Deleted', category: 'model' },
      { value: 'model_updated', label: 'Model Updated', category: 'model' },

      { value: 'rag_document_ingested', label: 'RAG Document Ingested', category: 'rag' },
      { value: 'rag_document_deleted', label: 'RAG Document Deleted', category: 'rag' },
      { value: 'rag_collection_cleared', label: 'RAG Collection Cleared', category: 'rag' },

      { value: 'user_login', label: 'User Login', category: 'user' },
      { value: 'user_logout', label: 'User Logout', category: 'user' },
      { value: 'user_created', label: 'User Created', category: 'user' },
      { value: 'user_updated', label: 'User Updated', category: 'user' },
      { value: 'user_deleted', label: 'User Deleted', category: 'user' },

      { value: 'self_healing_triggered', label: 'Self-Healing Triggered', category: 'system' },
      { value: 'failover_executed', label: 'Failover Executed', category: 'system' },
      { value: 'service_restarted', label: 'Service Restarted', category: 'system' },

      { value: 'settings_updated', label: 'Settings Updated', category: 'admin' },
      { value: 'system_backup_created', label: 'System Backup Created', category: 'admin' },
      { value: 'system_backup_restored', label: 'System Backup Restored', category: 'admin' },

      { value: 'unauthorized_access_attempt', label: 'Unauthorized Access Attempt', category: 'security' },
      { value: 'rate_limit_exceeded', label: 'Rate Limit Exceeded', category: 'security' },
      { value: 'suspicious_activity_detected', label: 'Suspicious Activity Detected', category: 'security' }
    ];

    res.json({
      status: 'success',
      data: actions
    });
  } catch (error) {
    logger.error('Get audit actions error', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * GET /api/audit-logs/:id
 * Get specific audit log entry with full details
 */
router.get('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const log = await AuditLog.findById(id)
      .populate('userId', 'name email')
      .lean();

    if (!log) {
      return res.status(404).json({
        status: 'error',
        message: 'Audit log not found'
      });
    }

    res.json({
      status: 'success',
      data: {
        id: log._id,
        timestamp: log.timestamp,
        userId: log.userId,
        username: log.username,
        authSource: log.authSource,
        action: log.action,
        resource: log.resource,
        resourceId: log.resourceId,
        resourceName: log.resourceName,
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        details: log.details,
        severity: log.severity,
        status: log.status,
        errorMessage: log.errorMessage
      }
    });
  } catch (error) {
    logger.error('Get audit log error', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * GET /api/audit-logs/export/csv
 * Export audit logs to CSV
 */
router.get('/export/csv', requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      userId,
      action,
      resource,
      severity,
      status,
      startDate,
      endDate,
      limit = 10000
    } = req.query;

    // Build filters
    const filters = {};
    if (userId) filters.userId = userId;
    if (action) filters.action = action;
    if (resource) filters.resource = resource;
    if (severity) filters.severity = severity;
    if (status) filters.status = status;
    if (startDate || endDate) {
      filters.timestamp = {};
      if (startDate) filters.timestamp.$gte = new Date(startDate);
      if (endDate) filters.timestamp.$lte = new Date(endDate);
    }

    // Query logs
    const logs = await AuditLog.find(filters)
      .sort('-timestamp')
      .limit(Math.min(parseInt(limit, 10) || 10000, 10000))
      .lean();

    // Generate CSV
    const csvHeader = 'Timestamp,Username,Auth Source,Action,Resource,Resource Name,Severity,Status,IP Address,Error Message\n';
    const csvRows = logs.map(log => {
      return [
        log.timestamp.toISOString(),
        log.username || 'Unknown',
        log.authSource || 'session',
        log.action,
        log.resource || '',
        log.resourceName || '',
        log.severity,
        log.status,
        log.ipAddress || '',
        log.errorMessage || ''
      ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(',');
    }).join('\n');

    const csv = csvHeader + csvRows;

    // Set headers for file download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${Date.now()}.csv"`);
    res.send(csv);
  } catch (error) {
    logger.error('Export audit logs error', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * DELETE /api/audit-logs/cleanup
 * Delete old audit logs (retention policy)
 */
router.delete('/cleanup', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { retentionDays = 90 } = req.body;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await AuditLog.deleteMany({
      timestamp: { $lt: cutoffDate }
    });

    logger.info('Audit logs cleanup completed', {
      retentionDays,
      deletedCount: result.deletedCount
    });

    res.json({
      status: 'success',
      message: `Deleted ${result.deletedCount} audit logs older than ${retentionDays} days`,
      data: {
        deletedCount: result.deletedCount,
        cutoffDate
      }
    });
  } catch (error) {
    logger.error('Cleanup audit logs error', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

module.exports = router;
