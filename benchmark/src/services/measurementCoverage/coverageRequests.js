'use strict';

/**
 * Requests and recent results for whoever supervises coverage (an operator or
 * a lead agent through Core's tool bus).
 *
 * A request only moves a pair to the front of the queue. It never starts a
 * measurement: the coverage job still decides when, inside the quiet hours.
 */

const BenchmarkResult = require('../../../models/BenchmarkResult');
const { buildCoverage } = require('./coverageState');
const settingsStore = require('./coverageSettings');
const { hostKey, modelKey } = require('./coverageScope');
const { normalizeModelTag } = require('../../../../shared/modelNames');

const cellKey = cell => `${hostKey(cell.hostUrl)}::${modelKey(cell.model)}`;

function requestError(message, code = 'COVERAGE_REQUEST_INVALID', statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** The pair in scope that `host` (id, name or address) and `model` name. */
function findCell(cells, host, model) {
  const wanted = String(host || '').trim().toLowerCase();
  const name = modelKey(model);
  if (!wanted || !name) throw requestError('host and model are required');
  const cell = cells.find(item => modelKey(item.model) === name
    && [item.hostId, item.hostName, hostKey(item.hostUrl)].some(value => String(value || '').toLowerCase() === wanted.replace(/\/+$/, '')));
  if (!cell) throw requestError('This host and model are not in the coverage scope (pinned or routed)', 'COVERAGE_PAIR_UNKNOWN', 404);
  return cell;
}

async function requestMeasurement(input = {}, deps = {}) {
  const reason = String(input.reason || '').replace(/\s+/g, ' ').trim();
  if (!reason || reason.length > 300) throw requestError('reason is required, 300 characters at most');
  const priority = input.priority === undefined ? 2 : input.priority;
  if (![1, 2, 3].includes(priority)) throw requestError('priority is 1 (low), 2 or 3 (high)');
  const store = deps.store || settingsStore;
  const coverage = await (deps.buildCoverage || buildCoverage)();
  const cell = findCell(coverage.cells, input.host, input.model);
  if (!cell.next) throw requestError('This pair is already complete: nothing to measure', 'COVERAGE_PAIR_COMPLETE', 409);
  const state = await store.getState();
  const request = { priority, reason, requestedBy: String(input.requestedBy || 'operator').slice(0, 60), at: new Date().toISOString() };
  state.requests[cellKey(cell)] = request;
  await store.saveState(state);
  return { host: cell.hostName, model: cell.model, next: cell.next, request,
    note: 'Queued. The coverage job starts it in the quiet hours when the runtime is idle.' };
}

async function cancelRequest(input = {}, deps = {}) {
  const store = deps.store || settingsStore;
  const coverage = await (deps.buildCoverage || buildCoverage)();
  const cell = findCell(coverage.cells, input.host, input.model);
  const state = await store.getState();
  const existed = Boolean(state.requests[cellKey(cell)]);
  delete state.requests[cellKey(cell)];
  if (existed) await store.saveState(state);
  return { host: cell.hostName, model: cell.model, cancelled: existed };
}

/** Recent answers of one pair: scores and speed only, never the answer text. */
async function recentResults(input = {}, deps = {}) {
  const coverage = await (deps.buildCoverage || buildCoverage)();
  const cell = findCell(coverage.cells, input.host, input.model);
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit)) || 30));
  const rows = await (deps.findResults || (filter => BenchmarkResult.find(filter)
    .select('prompt_name prompt_category prompt_level quality_score scoring_method success error tokens tokens_per_sec latency timestamp scorer_version excluded_from_leaderboard')
    .sort({ timestamp: -1 }).limit(limit).lean()))({
    host: { $in: [cell.hostUrl, `${cell.hostUrl}/`] },
    model: { $in: [cell.model, normalizeModelTag(cell.model)] }
  });
  const results = rows.map(row => ({
    prompt: row.prompt_name, category: row.prompt_category, level: row.prompt_level,
    score: typeof row.quality_score === 'number' ? row.quality_score : null,
    scored: typeof row.quality_score === 'number', scoringMethod: row.scoring_method || null,
    success: row.success !== false, error: row.error ? String(row.error).slice(0, 160) : null,
    tokens: row.tokens ?? null, tokensPerSec: row.tokens_per_sec ?? null, seconds: row.latency ? Math.round(row.latency / 1000) : null,
    at: row.timestamp, scorerVersion: row.scorer_version || null, excluded: row.excluded_from_leaderboard === true
  }));
  const scored = results.filter(row => row.scored);
  return {
    host: cell.hostName, model: cell.model, count: results.length,
    summary: {
      scored: scored.length, unscored: results.length - scored.length,
      meanScore: scored.length ? Math.round((scored.reduce((sum, row) => sum + row.score, 0) / scored.length) * 100) / 100 : null,
      failed: results.filter(row => !row.success).length
    },
    results
  };
}

module.exports = { requestMeasurement, cancelRequest, recentResults, findCell, cellKey };
