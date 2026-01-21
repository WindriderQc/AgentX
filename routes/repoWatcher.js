const express = require('express');
const router = express.Router();
const { getRepoWatcherService } = require('../src/services/repoWatcherService');
const { requireAuth } = require('../middleware/auth');
const { optionalWorkspaceContext } = require('../middleware/workspace');
const logger = require('../src/helpers/logger');

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

module.exports = router;
