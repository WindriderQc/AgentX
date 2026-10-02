/**
 * janitorController.js — thin HTTP handlers for disk janitor + dedup pipeline.
 * Delegates all business logic to janitorService and dedupScanner.
 */
const janitorService = require('../services/janitorService');
const dedupScanner = require('../services/dedupScanner');
const janitorAI = require('../services/janitorAI');
const janitorStrategy = require('../services/janitorStrategy');
const { log } = require('../utils/logger');

/** POST /analyze */
async function analyze(req, res, next) {
  const { path: scanPath } = req.body;
  if (!scanPath) return res.status(400).json({ status: 'error', message: 'path required' });
  try {
    const safePath = await janitorService.resolveAllowedPath(scanPath, { mustExist: true, type: 'directory' });
    if (!safePath.ok) {
      return res.status(safePath.reason === 'Blocked by safety policy' ? 403 : 400)
        .json({ status: 'error', message: safePath.reason });
    }
    const result = await janitorService.analyzeDirectory(safePath.realPath);
    delete result._fileMap;
    res.json({ status: 'success', data: result });
  } catch (err) { next(err); }
}

/** POST /suggest */
async function suggest(req, res, next) {
  const { path: scanPath, policies } = req.body;
  if (!scanPath) return res.status(400).json({ status: 'error', message: 'path required' });
  try {
    const safePath = await janitorService.resolveAllowedPath(scanPath, { mustExist: true, type: 'directory' });
    if (!safePath.ok) {
      return res.status(safePath.reason === 'Blocked by safety policy' ? 403 : 400)
        .json({ status: 'error', message: safePath.reason });
    }
    const analysis = await janitorService.analyzeDirectory(safePath.realPath);
    const active = policies || Object.keys(janitorService.POLICIES).filter(k => janitorService.POLICIES[k].enabled);
    const suggestions = janitorService.buildSuggestions(
      analysis,
      active.filter(policy => policy !== 'delete_duplicates')
    );
    let strategyStatus = 'not_requested';
    let decisionsRequired = [];
    if (active.includes('delete_duplicates')) {
      const policy = await janitorStrategy.getPolicy(req.app.locals.db);
      const duplicateGroups = (analysis.duplicate_groups || []).map(group => ({
        _id: group.hash,
        count: group.count,
        size: group.size,
        files: Array.from(analysis._fileMap.get(group.hash) || [])
      }));
      const plan = janitorStrategy.buildDuplicatePlan(duplicateGroups, policy);
      strategyStatus = plan.status;
      decisionsRequired = plan.decisions_required;
      suggestions.push(...plan.proposals.map(proposal => ({
        policy: proposal.policy,
        action: 'delete',
        files: proposal.files,
        reason: proposal.reason,
        space_saved: proposal.space_saved,
        evidence: proposal.evidence,
        survivor_rule: proposal.survivorRule,
        approval_required: true,
        execution_authorized: false
      })));
    }
    const totalSaved = suggestions.reduce((s, x) => s + (x.space_saved || 0), 0);

    res.json({
      status: 'success',
      data: {
        suggestions_count: suggestions.length,
        total_space_saved: totalSaved,
        suggestions: suggestions.slice(0, 100),
        policies_applied: active,
        strategy_status: strategyStatus,
        decisions_required: decisionsRequired
      }
    });
  } catch (err) { next(err); }
}

/** GET /policies */
function listPolicies(req, res) {
  res.json({ status: 'success', data: { policies: Object.values(janitorService.POLICIES) } });
}

/** POST /dedup-scan */
async function dedupScan(req, res, next) {
  const db = req.app.locals.db;
  if (!db) return res.status(503).json({ status: 'error', message: 'Database not ready' });

  const { root_path, extensions, max_depth } = req.body;
  const rootPath = root_path || '/mnt/datalake/';

  try {
    const safePath = await janitorService.resolveAllowedPath(rootPath, { mustExist: true, type: 'directory' });
    if (!safePath.ok) {
      return res.status(safePath.reason === 'Blocked by safety policy' ? 403 : 400)
        .json({ status: 'error', message: safePath.reason });
    }
    const report = await dedupScanner.buildDedupReport(db, {
      rootPath: safePath.realPath,
      extensions: extensions || [],
      maxDepth: max_depth || null
    });
    const reportId = await dedupScanner.saveReport(db, report);
    log(`Dedup scan complete: ${report.summary.total_duplicate_groups} groups, ${report.summary.total_wasted_space_formatted} wasted`);
    res.json({
      status: 'success',
      message: 'Dedup scan complete',
      data: { report_id: reportId, summary: report.summary }
    });
  } catch (err) {
    log(`Dedup scan failed: ${err.message}`, 'error');
    next(err);
  }
}

/** GET /dedup-report */
async function dedupReport(req, res, next) {
  const db = req.app.locals.db;
  if (!db) return res.status(503).json({ status: 'error', message: 'Database not ready' });

  try {
    const report = await dedupScanner.getReport(db, req.query.report_id || null);
    // No report is a valid first-run collection state, not a missing route.
    // Return an empty success so dashboards do not emit a noisy console 404.
    if (!report) return res.json({ status: 'success', data: null, message: 'No dedup report found' });
    res.json({ status: 'success', data: report });
  } catch (err) { next(err); }
}

/** POST /ai */
async function aiChat(req, res) {
  const { action, context } = req.body;
  if (!action) return res.status(400).json({ status: 'error', message: 'action required' });
  if (!janitorAI.ACTIONS[action]) {
    return res.status(400).json({ status: 'error', message: `Invalid action: ${action}. Valid: ${Object.keys(janitorAI.ACTIONS).join(', ')}` });
  }

  try {
    const result = await janitorAI.callAI(action, context || {});
    res.json({ status: 'success', data: result });
  } catch (err) {
    log(`Janitor AI failed: ${err.message}`, 'error');
    res.status(503).json({ status: 'error', message: 'AI service unavailable — Ollama may be offline' });
  }
}

module.exports = { analyze, suggest, listPolicies, dedupScan, dedupReport, aiChat };
