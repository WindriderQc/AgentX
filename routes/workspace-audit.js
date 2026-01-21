/**
 * Workspace Audit Log API
 *
 * Query and retrieve workspace activity logs
 * Post-Week 4: Workspace activity audit logs (A2)
 */

const express = require('express');
const router = express.Router();
const WorkspaceAuditLog = require('../models/WorkspaceAuditLog');
const logger = require('../config/logger');
const { requireAuth } = require('../src/middleware/auth');
const {
  attachWorkspace,
  requireWorkspaceAccess
} = require('../src/middleware/workspace');

/**
 * GET /api/workspaces/:slug/audit-logs
 * Get audit logs for workspace
 */
router.get('/:slug/audit-logs', requireAuth, attachWorkspace, requireWorkspaceAccess, async (req, res) => {
  try {
    const workspace = req.workspace;
    const {
      limit = 50,
      skip = 0,
      action,
      targetType,
      userId,
      from,
      to
    } = req.query;

    const options = {
      limit: Math.min(parseInt(limit, 10), 100), // Max 100 per page
      skip: parseInt(skip, 10),
      action,
      targetType,
      userId,
      from,
      to
    };

    const result = await WorkspaceAuditLog.getRecentActivity(workspace._id, options);

    res.json({
      status: 'success',
      data: {
        logs: result.logs.map(log => ({
          _id: log._id,
          action: log.action,
          description: log.description,
          targetType: log.targetType,
          targetId: log.targetId,
          user: {
            _id: log.userId._id,
            username: log.userId.username,
            email: log.userId.email
          },
          changes: log.changes,
          metadata: log.metadata,
          timestamp: log.timestamp,
          ipAddress: log.ipAddress
        })),
        pagination: {
          total: result.total,
          limit: result.limit,
          skip: result.skip,
          hasMore: result.skip + result.logs.length < result.total
        }
      }
    });
  } catch (error) {
    logger.error('Failed to get audit logs', {
      error: error.message,
      workspace: req.params.slug
    });

    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve audit logs'
    });
  }
});

/**
 * GET /api/workspaces/:slug/audit-logs/statistics
 * Get audit log statistics for workspace
 */
router.get('/:slug/audit-logs/statistics', requireAuth, attachWorkspace, requireWorkspaceAccess, async (req, res) => {
  try {
    const workspace = req.workspace;
    const { from, to } = req.query;

    const stats = await WorkspaceAuditLog.getStatistics(workspace._id, { from, to });

    // Populate user details for top users
    const userIds = stats.byUser.map(u => u._id);
    const UserProfile = require('../models/UserProfile');
    const users = await UserProfile.find({ _id: { $in: userIds } }, 'username email');

    const userMap = {};
    users.forEach(u => {
      userMap[u._id.toString()] = {
        username: u.username,
        email: u.email
      };
    });

    res.json({
      status: 'success',
      data: {
        total: stats.total,
        byAction: stats.byAction.map(item => ({
          action: item._id,
          count: item.count
        })),
        byUser: stats.byUser.map(item => ({
          userId: item._id,
          user: userMap[item._id?.toString()] || null,
          count: item.count
        })),
        timeline: stats.timeline.map(item => ({
          timestamp: new Date(
            item._id.year,
            item._id.month - 1,
            item._id.day,
            item._id.hour
          ),
          count: item.count
        }))
      }
    });
  } catch (error) {
    logger.error('Failed to get audit log statistics', {
      error: error.message,
      workspace: req.params.slug
    });

    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve audit log statistics'
    });
  }
});

/**
 * GET /api/workspaces/:slug/audit-logs/export
 * Export audit logs as CSV
 */
router.get('/:slug/audit-logs/export', requireAuth, attachWorkspace, requireWorkspaceAccess, async (req, res) => {
  try {
    const workspace = req.workspace;
    const { from, to, action, targetType } = req.query;

    // Get all logs (up to 10000 for export)
    const result = await WorkspaceAuditLog.getRecentActivity(workspace._id, {
      limit: 10000,
      skip: 0,
      action,
      targetType,
      from,
      to
    });

    // Generate CSV
    const csv = generateCSV(result.logs);

    // Set headers for file download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${workspace.slug}-${Date.now()}.csv"`);

    res.send(csv);

  } catch (error) {
    logger.error('Failed to export audit logs', {
      error: error.message,
      workspace: req.params.slug
    });

    res.status(500).json({
      status: 'error',
      message: 'Failed to export audit logs'
    });
  }
});

/**
 * Helper: Generate CSV from audit logs
 */
function generateCSV(logs) {
  const headers = ['Timestamp', 'Action', 'Description', 'User', 'Target Type', 'Target ID', 'IP Address'];
  const rows = logs.map(log => [
    log.timestamp.toISOString(),
    log.action,
    log.description,
    log.userId.username || log.userId.email,
    log.targetType,
    log.targetId?.toString() || '',
    log.ipAddress || ''
  ]);

  // Escape CSV values
  const escapeCSV = (value) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const csvLines = [
    headers.map(escapeCSV).join(','),
    ...rows.map(row => row.map(escapeCSV).join(','))
  ];

  return csvLines.join('\n');
}

module.exports = router;
