const express = require('express');
const router = express.Router();
const { getRepoWatcherService } = require('../src/services/repoWatcherService');
const { requireAuth } = require('../src/middleware/auth');
const { optionalWorkspaceContext } = require('../src/middleware/workspace');
const logger = require('../config/logger');

// Get current scan status
router.get('/status', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const repoPath = process.env.REPO_WATCHER_PATH || process.cwd();
    const workspaceId = req.workspace?._id;

    const service = getRepoWatcherService();
    const status = await service.getStatus(repoPath, workspaceId);

    res.json(status);
  } catch (error) {
    logger.error('Failed to get repo watcher status', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve status'
    });
  }
});

// Trigger manual scan
router.post('/scan', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const repoPath = process.env.REPO_WATCHER_PATH || process.cwd();
    const workspaceId = req.workspace?._id;

    logger.info('Manual scan triggered', { userId: req.user.userId, repoPath });

    const service = getRepoWatcherService();
    const result = await service.scan(repoPath, workspaceId);

    res.json({
      status: 'success',
      data: result
    });
  } catch (error) {
    logger.error('Scan failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Get trend data
router.get('/trends', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const repoPath = process.env.REPO_WATCHER_PATH || process.cwd();
    const workspaceId = req.workspace?._id;
    const limit = parseInt(req.query.limit) || 10;

    const service = getRepoWatcherService();
    const trends = await service.getTrends(repoPath, workspaceId, limit);

    res.json(trends);
  } catch (error) {
    logger.error('Failed to get trends', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve trends'
    });
  }
});

// Get scan history
router.get('/history', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const RepoScan = require('../models/RepoScan');
    const repoPath = process.env.REPO_WATCHER_PATH || process.cwd();
    const workspaceId = req.workspace?._id;
    const limit = parseInt(req.query.limit) || 20;
    const skip = parseInt(req.query.skip) || 0;

    const query = { repoPath };
    if (workspaceId) {
      query.workspaceId = workspaceId;
    }

    const scans = await RepoScan.find(query)
      .sort({ scannedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('status summary scannedAt scanDuration')
      .lean();

    const total = await RepoScan.countDocuments(query);

    res.json({
      status: 'success',
      data: {
        scans,
        total,
        page: Math.floor(skip / limit) + 1,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    logger.error('Failed to get scan history', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve history'
    });
  }
});

// Get specific scan by ID
router.get('/scan/:scanId', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const RepoScan = require('../models/RepoScan');
    const { scanId } = req.params;
    const workspaceId = req.workspace?._id;

    const query = { _id: scanId };
    if (workspaceId) {
      query.workspaceId = workspaceId;
    }

    const scan = await RepoScan.findOne(query).lean();

    if (!scan) {
      return res.status(404).json({
        status: 'error',
        message: 'Scan not found'
      });
    }

    res.json({
      status: 'success',
      data: scan
    });
  } catch (error) {
    logger.error('Failed to get scan', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve scan'
    });
  }
});

// Export latest scan results
router.get('/export/:format', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const RepoScan = require('../models/RepoScan');
    const { format } = req.params;
    const repoPath = process.env.REPO_WATCHER_PATH || process.cwd();
    const workspaceId = req.workspace?._id;

    if (!['json', 'csv', 'markdown'].includes(format)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid format. Supported: json, csv, markdown'
      });
    }

    // Get latest scan
    const scan = await RepoScan.getLatest(repoPath, workspaceId);

    if (!scan) {
      return res.status(404).json({
        status: 'error',
        message: 'No scan data available'
      });
    }

    const timestamp = new Date(scan.scannedAt).toISOString().replace(/[:.]/g, '-');
    const filename = `repo-scan-${timestamp}`;

    // JSON export
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
      return res.json({
        exportedAt: new Date().toISOString(),
        repoPath: scan.repoPath,
        scannedAt: scan.scannedAt,
        status: scan.status,
        scanDuration: scan.scanDuration,
        summary: scan.summary,
        findings: scan.findings,
        snapshot: scan.snapshot
      });
    }

    // CSV export
    if (format === 'csv') {
      const rows = [
        ['Type', 'Severity', 'Path', 'Evidence', 'Confidence'].join(','),
        ...scan.findings.map(f => [
          f.type,
          f.severity,
          `"${(f.path || '').replace(/"/g, '""')}"`,
          `"${(f.evidence || '').replace(/"/g, '""')}"`,
          Math.round((f.confidence || 0) * 100) + '%'
        ].join(','))
      ];

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      return res.send(rows.join('\n'));
    }

    // Markdown export
    if (format === 'markdown') {
      const groupedFindings = scan.findings.reduce((acc, f) => {
        if (!acc[f.type]) acc[f.type] = [];
        acc[f.type].push(f);
        return acc;
      }, {});

      let markdown = `# Repository Scan Report\n\n`;
      markdown += `**Repository:** ${scan.repoPath}\n`;
      markdown += `**Scanned:** ${new Date(scan.scannedAt).toLocaleString()}\n`;
      markdown += `**Status:** ${scan.status.toUpperCase()}\n\n`;

      markdown += `## Summary\n\n`;
      markdown += `- **Total Files:** ${scan.summary.totalFiles}\n`;
      markdown += `- **Failures:** ${scan.summary.failures}\n`;
      markdown += `- **Warnings:** ${scan.summary.warnings}\n`;
      markdown += `- **Infos:** ${scan.summary.infos}\n`;
      markdown += `- **Test Coverage:** ${scan.summary.testCoverage}%\n`;
      markdown += `- **Duplication Rate:** ${scan.summary.duplicationRate}%\n\n`;

      markdown += `## Findings\n\n`;

      for (const [type, findings] of Object.entries(groupedFindings)) {
        markdown += `### ${type.replace(/_/g, ' ').toUpperCase()} (${findings.length})\n\n`;

        findings.forEach((f, i) => {
          markdown += `#### ${i + 1}. ${f.severity.toUpperCase()}\n`;
          if (f.path) markdown += `**Path:** \`${f.path}\`\n`;
          markdown += `**Evidence:** ${f.evidence}\n`;
          markdown += `**Confidence:** ${Math.round((f.confidence || 0) * 100)}%\n\n`;
        });
      }

      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.md"`);
      return res.send(markdown);
    }

  } catch (error) {
    logger.error('Failed to export scan', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to export scan data'
    });
  }
});

module.exports = router;
