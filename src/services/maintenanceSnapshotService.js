/**
 * Maintenance Snapshot Service
 *
 * Orchestrates all four maintenance scanners against a managed repo,
 * normalizes their output through adapters, upserts findings into MongoDB,
 * and returns a ranked summary.
 *
 * Managed repos are defined in config/repo-profiles.json.
 * Called by: routes/maintenance.js, specialxTaskHandlers.js (maintenance_snapshot)
 */

const path = require('path');
const logger = require('../../config/logger');
const Finding = require('../../models/Finding');

const repoWatcherAdapter = require('./adapters/repoWatcherAdapter');
const docJanitorAdapter = require('./adapters/docJanitorAdapter');
const featureAlignmentAdapter = require('./adapters/featureAlignmentAdapter');
const validationScannerAdapter = require('./adapters/validationScannerAdapter');

// Lazy-load scanners to avoid circular deps and startup overhead
function getRepoProfiles() {
  try {
    return require('../../config/repo-profiles.json');
  } catch (_) {
    // Fallback if config file not yet present
    return { repos: [] };
  }
}

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run all scanners against a repo and upsert findings.
 *
 * @param {string} repoId — must match an id in repo-profiles.json
 * @param {Object} [options]
 * @param {string[]} [options.scanners] — subset of scanners to run (default: all)
 * @returns {Promise<Object>} snapshot summary
 */
async function runSnapshot(repoId, options = {}) {
  const profiles = getRepoProfiles();
  const profile = profiles.repos.find(r => r.id === repoId);
  if (!profile) {
    throw new Error(`Unknown repo: ${repoId}. Add it to config/repo-profiles.json`);
  }

  const scanners = options.scanners || ['repo-watcher', 'doc-janitor', 'feature-alignment', 'validation-scanner'];
  const startedAt = Date.now();
  const results = { scannedAt: new Date(), repo: repoId, repoPath: profile.repoPath, scanners: {} };
  const allFindingData = [];

  logger.info('[MaintenanceSnapshot] Starting scan', { repo: repoId, scanners });

  // Run scanners sequentially to avoid overloading disk I/O
  for (const scannerName of scanners) {
    try {
      const data = await runScanner(scannerName, profile);
      results.scanners[scannerName] = { status: 'ok', durationMs: data.durationMs };
      allFindingData.push(...data.findings);
    } catch (err) {
      logger.error(`[MaintenanceSnapshot] Scanner failed: ${scannerName}`, { error: err.message });
      results.scanners[scannerName] = { status: 'error', error: err.message };
    }
  }

  // Upsert all findings into MongoDB
  let newCount = 0, updatedCount = 0;
  for (const fd of allFindingData) {
    try {
      const { isNew } = await Finding.upsertFinding(fd);
      if (isNew) newCount++; else updatedCount++;
    } catch (err) {
      // Unique constraint race or validation error — skip
      logger.debug('[MaintenanceSnapshot] Finding upsert skipped', { error: err.message });
    }
  }

  // Mark findings not seen in this scan as potentially stale (do NOT auto-resolve)
  // Just fetch the current open findings for summary
  const openFindings = await Finding.find({
    repo: repoId,
    status: { $in: ['new', 'acknowledged'] }
  }).select('severity category title firstSeenAt lastSeenAt occurrenceCount').lean();

  const counts = countBySeverity(openFindings);
  const topFindings = openFindings
    .sort((a, b) => (SEVERITY_ORDER[a.severity] || 4) - (SEVERITY_ORDER[b.severity] || 4))
    .slice(0, 10)
    .map(f => ({
      id: f._id,
      severity: f.severity,
      category: f.category,
      title: f.title,
      daysOpen: Math.floor((Date.now() - new Date(f.firstSeenAt)) / 86400000)
    }));

  results.summary = {
    totalOpenFindings: openFindings.length,
    newThisScan: newCount,
    updatedThisScan: updatedCount,
    bySeverity: counts,
    topFindings,
    durationMs: Date.now() - startedAt
  };

  logger.info('[MaintenanceSnapshot] Scan complete', {
    repo: repoId,
    newFindings: newCount,
    updatedFindings: updatedCount,
    totalOpen: openFindings.length,
    durationMs: results.summary.durationMs
  });

  return results;
}

// ---------------------------------------------------------------------------
// Per-scanner runners
// ---------------------------------------------------------------------------

async function runScanner(scannerName, profile) {
  const start = Date.now();
  let findings = [];

  switch (scannerName) {
    case 'repo-watcher': {
      const { getRepoWatcherService } = require('./repoWatcherService');
      const svc = getRepoWatcherService();
      const result = await svc.scan(profile.repoPath);
      findings = repoWatcherAdapter.adapt(result, profile.id, profile.repoPath);
      break;
    }

    case 'doc-janitor': {
      const { getDocJanitorService } = require('./docJanitorService');
      const svc = getDocJanitorService();
      const result = await svc.scan(profile.repoPath);
      findings = docJanitorAdapter.adapt(result, profile.id, profile.repoPath);
      break;
    }

    case 'feature-alignment': {
      const { scanWorkspace } = require('./featureAlignmentScanner');
      const result = scanWorkspace({ rootDir: profile.repoPath });
      findings = featureAlignmentAdapter.adapt(result, profile.id, profile.repoPath);
      break;
    }

    case 'validation-scanner': {
      const { analyzeServiceCoverage, detectUnmountedRoutes } = require('./validationScanner');
      const serviceCoverage = analyzeServiceCoverage(profile.repoPath);
      const routeMounting = detectUnmountedRoutes(profile.repoPath);
      findings = validationScannerAdapter.adapt({ serviceCoverage, routeMounting }, profile.id, profile.repoPath);
      break;
    }

    default:
      throw new Error(`Unknown scanner: ${scannerName}`);
  }

  return { findings, durationMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    if (counts[f.severity] !== undefined) counts[f.severity]++;
  }
  return counts;
}

/**
 * Generate a Telegram-formatted digest string for a repo.
 * @param {string} repoId
 * @returns {Promise<string>}
 */
async function generateDigest(repoId) {
  const profiles = getRepoProfiles();
  const profile = profiles.repos.find(r => r.id === repoId);
  const repoName = profile?.name || repoId;

  const openFindings = await Finding.find({
    repo: repoId,
    status: { $in: ['new', 'acknowledged'] }
  }).sort({ severity: 1 }).limit(5).lean();

  const counts = await Finding.aggregate([
    { $match: { repo: repoId, status: { $in: ['new', 'acknowledged'] } } },
    { $group: { _id: '$severity', count: { $sum: 1 } } }
  ]);

  const bySev = {};
  for (const c of counts) bySev[c._id] = c.count;

  const sevIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' };
  const sevLine = Object.entries(bySev)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (SEVERITY_ORDER[a] || 4) - (SEVERITY_ORDER[b] || 4))
    .map(([s, n]) => `${sevIcon[s] || '•'} ${n} ${s}`)
    .join(' · ');

  const topList = openFindings.slice(0, 3)
    .map(f => `  ${sevIcon[f.severity] || '•'} ${f.title}`)
    .join('\n');

  return [
    `*${repoName} Repo Health*`,
    sevLine || 'No open findings ✅',
    topList ? `\nTop findings:\n${topList}` : '',
    `\n_View: /maintenance.html_`
  ].filter(Boolean).join('\n');
}

/**
 * List all managed repo IDs.
 */
function listRepos() {
  return getRepoProfiles().repos.map(r => ({ id: r.id, name: r.name, repoPath: r.repoPath }));
}

module.exports = { runSnapshot, generateDigest, listRepos };
