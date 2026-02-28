const express = require('express');
const router = express.Router();
const hostMonitorService = require('../src/services/hostMonitorService');
const { optionalAuth } = require('../src/middleware/auth');
const logger = require('../config/logger');

const AGENT_TOKEN = process.env.HOST_AGENT_TOKEN || '';

/**
 * Simple token check for agent reports.
 * If HOST_AGENT_TOKEN is set, the agent must send it in the x-agent-token header.
 */
function validateAgentToken(req, res, next) {
  if (!AGENT_TOKEN) return next(); // no token configured → open
  const token = req.headers['x-agent-token'] || '';
  if (token === AGENT_TOKEN) return next();
  return res.status(401).json({ status: 'error', message: 'Invalid agent token' });
}

// ─── Agent heartbeat endpoint ─────────────────────────────

router.post('/report', validateAgentToken, async (req, res) => {
  try {
    const report = req.body;
    if (!report || !report.hostId) {
      return res.status(400).json({ status: 'error', message: 'hostId is required' });
    }
    const host = await hostMonitorService.processReport(report);
    return res.json({ status: 'success', data: { hostId: host.hostId, status: host.status } });
  } catch (err) {
    logger.error('Host report failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── Dashboard endpoints ──────────────────────────────────

router.get('/summary', optionalAuth, async (_req, res) => {
  try {
    const summary = await hostMonitorService.getSummary();
    return res.json({ status: 'success', data: summary });
  } catch (err) {
    logger.error('Host summary failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/', optionalAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const hosts = await hostMonitorService.getAllHosts(status || null);
    return res.json({ status: 'success', data: hosts });
  } catch (err) {
    logger.error('List hosts failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/:hostId', optionalAuth, async (req, res) => {
  try {
    const host = await hostMonitorService.getHost(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', message: 'Host not found' });
    return res.json({ status: 'success', data: host });
  } catch (err) {
    logger.error('Get host failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/:hostId/history', optionalAuth, async (req, res) => {
  try {
    const { from, to, limit } = req.query;
    const history = await hostMonitorService.getHostHistory(req.params.hostId, {
      from, to,
      limit: limit ? parseInt(limit, 10) : 500
    });
    return res.json({ status: 'success', data: history });
  } catch (err) {
    logger.error('Host history failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/:hostId', optionalAuth, async (req, res) => {
  try {
    const host = await hostMonitorService.updateHost(req.params.hostId, req.body);
    if (!host) return res.status(404).json({ status: 'error', message: 'Host not found or no valid fields' });
    return res.json({ status: 'success', data: host });
  } catch (err) {
    logger.error('Update host failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/:hostId', optionalAuth, async (req, res) => {
  try {
    const host = await hostMonitorService.removeHost(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', message: 'Host not found' });
    return res.json({ status: 'success', message: 'Host removed' });
  } catch (err) {
    logger.error('Remove host failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
