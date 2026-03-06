/**
 * Cluster Schedule Routes
 *
 * Unified view of scheduled tasks across the cluster:
 * OpenClaw cron jobs, AgentX internal timers, persistent GPU loads.
 *
 * Mounted at /api/cluster
 */
const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { optionalAuth } = require('../src/middleware/auth');
const clusterScheduleService = require('../src/services/clusterScheduleService');
const clusterLiveService = require('../src/services/clusterLiveService');

/**
 * GET /schedule
 * List all schedule entries with optional filters.
 * Query params: host, taskType, source, enabled
 */
router.get('/schedule', optionalAuth, async (req, res) => {
  try {
    const filters = {};
    if (req.query.host) filters.host = req.query.host;
    if (req.query.taskType) filters.taskType = req.query.taskType;
    if (req.query.source) filters.source = req.query.source;
    if (req.query.enabled !== undefined) filters.enabled = req.query.enabled === 'true';

    const entries = await clusterScheduleService.getAllEntries(filters);
    res.json({ status: 'success', data: { entries, count: entries.length } });
  } catch (err) {
    logger.error('Failed to get cluster schedule entries', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * GET /schedule/timeline
 * Resolve entries into time slots for a given date.
 * Query params: date (YYYY-MM-DD, defaults to today), timezone
 */
router.get('/schedule/timeline', optionalAuth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const timezone = req.query.timezone || 'America/Toronto';
    const timeline = await clusterScheduleService.getTimeline(date, timezone);
    res.json({ status: 'success', data: { date, timezone, timeline } });
  } catch (err) {
    logger.error('Failed to get cluster timeline', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * GET /schedule/timeline-by-host
 * Pivot timeline by host — rows are GPU hosts, each with their tasks.
 * Query params: date (YYYY-MM-DD, defaults to today), timezone
 */
router.get('/schedule/timeline-by-host', optionalAuth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const timezone = req.query.timezone || 'America/Toronto';
    const hosts = await clusterScheduleService.getTimelineByHost(date, timezone);
    res.json({ status: 'success', data: { date, timezone, hosts } });
  } catch (err) {
    logger.error('Failed to get host timeline', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * GET /schedule/conflicts
 * Detect overlapping tasks on the same host for a given date.
 * Query params: date (YYYY-MM-DD, defaults to today), timezone
 */
router.get('/schedule/conflicts', optionalAuth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const timezone = req.query.timezone || 'America/Toronto';
    const conflicts = await clusterScheduleService.getConflicts(date, timezone);
    res.json({ status: 'success', data: { date, timezone, conflicts, count: conflicts.length } });
  } catch (err) {
    logger.error('Failed to get schedule conflicts', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * GET /schedule/live
 * Real-time state of all Ollama hosts (loaded models, status).
 */
router.get('/schedule/live', optionalAuth, async (req, res) => {
  try {
    const liveState = await clusterLiveService.getLiveState();
    res.json({ status: 'success', data: liveState });
  } catch (err) {
    logger.error('Failed to get cluster live state', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * GET /schedule/next
 * Get the next N upcoming scheduled tasks.
 * Query params: count (default 5)
 */
router.get('/schedule/next', optionalAuth, async (req, res) => {
  try {
    const count = Math.min(parseInt(req.query.count) || 5, 50);
    const tasks = await clusterScheduleService.getNextTasks(count);
    res.json({ status: 'success', data: { tasks, count: tasks.length } });
  } catch (err) {
    logger.error('Failed to get next cluster tasks', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * POST /schedule/sync
 * Upsert entries by source+sourceId. Idempotent.
 * Body: { entries: [...] }
 */
router.post('/schedule/sync', optionalAuth, async (req, res) => {
  try {
    const entries = req.body.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ status: 'error', error: 'entries array required' });
    }
    const stats = await clusterScheduleService.syncEntries(entries);
    res.json({ status: 'success', data: stats });
  } catch (err) {
    logger.error('Failed to sync cluster schedule', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

module.exports = router;
