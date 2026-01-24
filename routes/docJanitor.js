const express = require('express');
const router = express.Router();
const { requireAuth } = require('../src/middleware/auth');
const { optionalWorkspaceContext } = require('../src/middleware/workspace');
const logger = require('../config/logger');
const { getDocJanitorService } = require('../src/services/docJanitorService');

// Get latest DocJanitor scan status
router.get('/status', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const repoPath = process.env.REPO_WATCHER_PATH || process.cwd();
    const workspaceId = req.workspace?._id;
    const service = getDocJanitorService();
    const status = await service.getStatus(repoPath, workspaceId);
    res.json(status);
  } catch (error) {
    logger.error('Failed to get DocJanitor status', { error: error.message });
    res.status(500).json({ status: 'error', message: 'Failed to retrieve status' });
  }
});

// Trigger manual DocJanitor scan
router.post('/scan', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const repoPath = process.env.REPO_WATCHER_PATH || process.cwd();
    const workspaceId = req.workspace?._id;
    logger.info('DocJanitor manual scan triggered', { userId: req.user.userId, repoPath });
    const service = getDocJanitorService();
    const result = await service.scan(repoPath, workspaceId);
    res.json({ status: 'success', data: result });
  } catch (error) {
    logger.error('DocJanitor scan failed', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Get scan history
router.get('/history', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const repoPath = process.env.REPO_WATCHER_PATH || process.cwd();
    const workspaceId = req.workspace?._id;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = parseInt(req.query.skip, 10) || 0;

    const service = getDocJanitorService();
    const data = await service.getHistory(repoPath, workspaceId, limit, skip);
    res.json({ status: 'success', data });
  } catch (error) {
    logger.error('Failed to get DocJanitor history', { error: error.message });
    res.status(500).json({ status: 'error', message: 'Failed to retrieve history' });
  }
});

// Get scan details by ID
router.get('/scan/:scanId', requireAuth, optionalWorkspaceContext, async (req, res) => {
  try {
    const { scanId } = req.params;
    const workspaceId = req.workspace?._id;
    const service = getDocJanitorService();
    const scan = await service.getScanById(scanId, workspaceId);

    if (!scan) {
      return res.status(404).json({ status: 'error', message: 'Scan not found' });
    }

    res.json({ status: 'success', data: scan });
  } catch (error) {
    logger.error('Failed to get DocJanitor scan', { error: error.message });
    res.status(500).json({ status: 'error', message: 'Failed to retrieve scan' });
  }
});

module.exports = router;

