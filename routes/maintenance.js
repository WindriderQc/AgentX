/**
 * Maintenance Routes — repo health findings lifecycle and snapshot API.
 *
 * POST /api/maintenance/scan/:repo          — trigger a snapshot scan
 * GET  /api/maintenance/repos               — list managed repos
 * GET  /api/maintenance/snapshot/:repo      — latest scan summary + open finding counts
 * GET  /api/maintenance/findings            — findings list with filters
 * PATCH /api/maintenance/findings/:id       — update finding status
 * GET  /api/maintenance/digest              — Telegram-formatted summary (all repos)
 * GET  /api/maintenance/stats               — aggregate stats for dashboard header
 * GET  /api/maintenance/scheduler/status   — MaintenanceSchedulerService health + config
 */

const express = require('express');
const router = express.Router();
const Finding = require('../models/Finding');
const { runSnapshot, generateDigest, listRepos } = require('../src/services/maintenanceSnapshotService');
const { attachUser } = require('../src/middleware/auth');
const logger = require('../config/logger');

router.use(attachUser);

// ---------------------------------------------------------------------------
// GET /api/maintenance/repos
// ---------------------------------------------------------------------------
router.get('/repos', (_req, res) => {
  try {
    res.json({ repos: listRepos() });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/maintenance/scan/:repo
// ---------------------------------------------------------------------------
router.post('/scan/:repo', async (req, res) => {
  const { repo } = req.params;
  const { scanners } = req.body || {};
  try {
    const result = await runSnapshot(repo, { scanners });
    res.json({ status: 'ok', result });
  } catch (err) {
    logger.error('[maintenance] Scan failed', { repo, error: err.message });
    res.status(err.message.includes('Unknown repo') ? 404 : 500).json({
      status: 'error',
      message: err.message
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/maintenance/snapshot/:repo
// ---------------------------------------------------------------------------
router.get('/snapshot/:repo', async (req, res) => {
  const { repo } = req.params;
  try {
    const [openCounts, recentResolved] = await Promise.all([
      Finding.aggregate([
        { $match: { repo, status: { $in: ['new', 'acknowledged'] } } },
        { $group: { _id: '$severity', count: { $sum: 1 } } }
      ]),
      Finding.countDocuments({
        repo,
        status: 'resolved',
        statusChangedAt: { $gte: new Date(Date.now() - 7 * 86400 * 1000) }
      })
    ]);

    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const c of openCounts) {
      if (bySeverity[c._id] !== undefined) bySeverity[c._id] = c.count;
    }
    const totalOpen = Object.values(bySeverity).reduce((a, b) => a + b, 0);

    const topFindings = await Finding.find({
      repo,
      status: { $in: ['new', 'acknowledged'] }
    })
      .sort({ severity: 1, lastSeenAt: -1 })
      .limit(5)
      .select('severity category title firstSeenAt lastSeenAt occurrenceCount scanner')
      .lean();

    res.json({
      repo,
      totalOpen,
      bySeverity,
      recentResolved,
      topFindings: topFindings.map(f => ({
        ...f,
        daysOpen: Math.floor((Date.now() - new Date(f.firstSeenAt)) / 86400000)
      }))
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/maintenance/findings
// Query: repo, status, severity, scanner, category, limit, offset
// ---------------------------------------------------------------------------
router.get('/findings', async (req, res) => {
  try {
    const {
      repo, status, severity, scanner, category,
      limit: rawLimit = '50', offset: rawOffset = '0',
      sort = 'severity'
    } = req.query;

    const filter = {};
    if (repo) filter.repo = repo;
    if (status) filter.status = status;
    if (severity) filter.severity = severity;
    if (scanner) filter.scanner = scanner;
    if (category) filter.category = category;
    // Default: only open findings unless status explicitly set
    if (!status) filter.status = { $in: ['new', 'acknowledged'] };

    const limit = Math.min(parseInt(rawLimit, 10) || 50, 200);
    const skip = parseInt(rawOffset, 10) || 0;

    const sortMap = {
      severity: { severity: 1, lastSeenAt: -1 },
      newest: { firstSeenAt: -1 },
      oldest: { firstSeenAt: 1 },
      updated: { lastSeenAt: -1 }
    };

    const [findings, total] = await Promise.all([
      Finding.find(filter).sort(sortMap[sort] || sortMap.severity).skip(skip).limit(limit).lean(),
      Finding.countDocuments(filter)
    ]);

    res.json({
      total,
      limit,
      offset: skip,
      findings: findings.map(f => ({
        ...f,
        daysOpen: Math.floor((Date.now() - new Date(f.firstSeenAt)) / 86400000)
      }))
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/maintenance/findings/:id
// Body: { status, statusChangedBy }
// Valid transitions: new→acknowledged, new/acknowledged→deferred,
//                   any→resolved, any→false_positive
// ---------------------------------------------------------------------------
router.patch('/findings/:id', async (req, res) => {
  const VALID_STATUSES = ['acknowledged', 'deferred', 'resolved', 'false_positive', 'new'];
  const { status, statusChangedBy } = req.body || {};

  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      status: 'error',
      message: `status must be one of: ${VALID_STATUSES.join(', ')}`
    });
  }

  try {
    const finding = await Finding.findById(req.params.id);
    if (!finding) return res.status(404).json({ status: 'error', message: 'Finding not found' });

    finding.status = status;
    finding.statusChangedAt = new Date();
    finding.statusChangedBy = statusChangedBy || req.user?.username || 'api';
    await finding.save();

    res.json({ status: 'ok', finding });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/maintenance/digest
// Returns a Telegram-formatted text summary across all managed repos
// ---------------------------------------------------------------------------
router.get('/digest', async (req, res) => {
  try {
    const repos = listRepos();
    const digests = await Promise.all(repos.map(r => generateDigest(r.id)));
    const text = digests.join('\n\n---\n\n');
    res.json({ text, repos: repos.map(r => r.id) });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/maintenance/stats
// Dashboard header stats: totals across all repos
// ---------------------------------------------------------------------------
router.get('/stats', async (req, res) => {
  try {
    const [open, byScannerAgg, recentNew] = await Promise.all([
      Finding.aggregate([
        { $match: { status: { $in: ['new', 'acknowledged'] } } },
        { $group: { _id: { repo: '$repo', severity: '$severity' }, count: { $sum: 1 } } }
      ]),
      Finding.aggregate([
        { $match: { status: { $in: ['new', 'acknowledged'] } } },
        { $group: { _id: '$scanner', count: { $sum: 1 } } }
      ]),
      Finding.countDocuments({
        status: 'new',
        firstSeenAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) }
      })
    ]);

    // Aggregate by repo + severity
    const byRepo = {};
    for (const row of open) {
      const { repo, severity } = row._id;
      if (!byRepo[repo]) byRepo[repo] = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 };
      byRepo[repo][severity] = (byRepo[repo][severity] || 0) + row.count;
      byRepo[repo].total += row.count;
    }

    const byScanner = {};
    for (const row of byScannerAgg) byScanner[row._id] = row.count;

    const totalOpen = Object.values(byRepo).reduce((s, r) => s + r.total, 0);

    res.json({ totalOpen, newLast24h: recentNew, byRepo, byScanner });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/maintenance/scheduler/status
// Returns current state of the MaintenanceSchedulerService singleton.
// ---------------------------------------------------------------------------
router.get('/scheduler/status', (_req, res) => {
  try {
    const { getMaintenanceSchedulerService } = require('../src/services/maintenanceSchedulerService');
    const svc = getMaintenanceSchedulerService();
    const status = svc.getStatus();
    res.json({
      status: 'ok',
      scheduler: {
        started: status.started,
        active: status.active,
        pollMs: status.pollMs,
        pollIntervalHuman: `${Math.round(status.pollMs / 60000)} min`,
        enabled: process.env.MAINTENANCE_SCHEDULER_ENABLED !== 'false'
      }
    });
  } catch (err) {
    logger.error('[maintenance] Scheduler status error', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
