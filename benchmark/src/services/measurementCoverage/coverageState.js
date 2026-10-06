'use strict';

/**
 * The coverage matrix: for each host and model in scope, is the profile
 * current, and which catalog prompts have a scored answer?
 *
 * A prompt is covered by an answer scored under the current scorer version,
 * for the prompt as the catalog holds it today, by the artifact the profile
 * describes. A new artifact, a new scorer version or an edited prompt
 * therefore re-opens the cells it affects without any bookkeeping.
 */

const BenchmarkResult = require('../../../models/BenchmarkResult');
const ModelProfile = require('../../../models/ModelProfile');
const HostProfile = require('../../../models/HostProfile');
const { loadCatalogPrompts } = require('../benchmark/promptComparison');
const { SCORER_VERSION } = require('../scoring/scorerVersion');
const { normalizeModelTag } = require('../../../../shared/modelNames');
const { resolveScope, hostKey, modelKey } = require('./coverageScope');

const digestKey = value => String(value || '').trim().toLowerCase().replace(/^sha256:/, '');

/** Profile state of one cell from the host's readiness entry. */
function profileState(readiness) {
  const base = { depth: readiness?.profileDepth || null, profiledAt: readiness?.profiledAt || null };
  if (!readiness || readiness.stage === 'available' || !readiness.profileDepth) {
    return { ...base, state: 'missing', reason: 'No profile on this host' };
  }
  if (readiness.stale || (readiness.authorityState && readiness.authorityState !== 'authoritative')) {
    return { ...base, state: 'stale', reason: readiness.staleReason || 'The profile no longer describes the deployed artifact' };
  }
  if (readiness.profileDepth === 'quick' || readiness.benchmarkQualified !== true) {
    return { ...base, state: 'unqualified', reason: readiness.qualificationReason || 'A standard profile is required before benchmarking' };
  }
  return { ...base, state: 'current', reason: null };
}

/**
 * Pure matrix computation.
 * @param {object} input
 * @param {Array} input.scope      cells from resolveScope
 * @param {Map} input.catalog      fingerprint -> { id, name, category, level }
 * @param {Map} input.hostIds      hostKey(url) -> hostId
 * @param {Map} input.readiness    `${hostId}::${modelKey}` -> readiness entry
 * @param {Map} input.answers      `${hostKey}::${modelKey}` -> Map(fingerprint -> [digest])
 */
function computeCoverage({ scope, catalog, hostIds, readiness, answers }) {
  const cells = scope.map(entry => {
    const hostId = hostIds.get(hostKey(entry.hostUrl)) || null;
    const ready = hostId ? readiness.get(`${hostId}::${modelKey(entry.model)}`) : null;
    const profile = profileState(ready);
    const artifact = digestKey(ready?.artifact?.digest);
    const scored = answers.get(`${hostKey(entry.hostUrl)}::${modelKey(entry.model)}`) || new Map();
    const byCategory = {};
    const missing = [];
    let covered = 0;
    for (const [fingerprint, prompt] of catalog) {
      const bucket = byCategory[prompt.category] = byCategory[prompt.category] || { total: 0, covered: 0 };
      bucket.total += 1;
      const digests = scored.get(fingerprint);
      // Without a profiled artifact any scored answer counts; with one, only its own.
      const done = Boolean(digests) && (!artifact || digests.some(digest => digestKey(digest) === artifact));
      if (done) { covered += 1; bucket.covered += 1; } else missing.push(prompt.id);
    }
    return {
      hostId, ...entry, profile,
      artifact: ready?.artifact ? { digest: ready.artifact.digest, runtimeFingerprint: ready.artifact.runtimeFingerprint } : null,
      catalog: { total: catalog.size, covered, byCategory },
      missingPromptIds: missing,
      complete: profile.state === 'current' && covered === catalog.size,
      next: profile.state !== 'current' ? 'profile' : covered < catalog.size ? 'benchmark' : null
    };
  });
  const prompts = cells.reduce((sum, cell) => sum + cell.catalog.total, 0);
  const covered = cells.reduce((sum, cell) => sum + cell.catalog.covered, 0);
  return {
    summary: {
      cells: cells.length,
      complete: cells.filter(cell => cell.complete).length,
      profilesCurrent: cells.filter(cell => cell.profile.state === 'current').length,
      prompts, covered,
      percent: prompts ? Math.round((covered / prompts) * 1000) / 10 : 0
    },
    cells
  };
}

function modelNames(scope) {
  return [...new Set(scope.flatMap(entry => [entry.model, normalizeModelTag(entry.model)]))];
}

async function loadReadiness(scope) {
  const readiness = new Map();
  for (const profile of await ModelProfile.find({ name: { $in: modelNames(scope) } }).select('name readiness').lean()) {
    for (const [hostId, entry] of Object.entries(profile.readiness || {})) {
      readiness.set(`${hostId}::${modelKey(profile.name)}`, entry);
    }
  }
  return readiness;
}

async function loadAnswers(scope, catalog) {
  const answers = new Map();
  if (!scope.length || !catalog.size) return answers;
  const rows = await BenchmarkResult.aggregate([
    { $match: {
      scorer_version: SCORER_VERSION,
      prompt_fingerprint: { $in: [...catalog.keys()] },
      quality_score: { $type: 'number' },
      excluded_from_leaderboard: { $ne: true },
      model: { $in: modelNames(scope) }
    } },
    { $group: { _id: { host: '$host', model: '$model', prompt: '$prompt_fingerprint' }, digests: { $addToSet: '$model_digest' } } }
  ]);
  for (const row of rows) {
    const key = `${hostKey(row._id.host)}::${modelKey(row._id.model)}`;
    if (!answers.has(key)) answers.set(key, new Map());
    answers.get(key).set(row._id.prompt, row.digests.filter(Boolean));
  }
  return answers;
}

async function buildCoverage(deps = {}) {
  const scope = await (deps.resolveScope || resolveScope)();
  const catalog = await (deps.loadCatalogPrompts || loadCatalogPrompts)();
  const hosts = await HostProfile.find({}).select('hostId hostUrl').lean();
  const coverage = computeCoverage({
    scope, catalog,
    hostIds: new Map(hosts.map(host => [hostKey(host.hostUrl), host.hostId])),
    readiness: await loadReadiness(scope),
    answers: await loadAnswers(scope, catalog)
  });
  return { generatedAt: new Date().toISOString(), scorerVersion: SCORER_VERSION, ...coverage };
}

module.exports = { buildCoverage, computeCoverage, profileState };
