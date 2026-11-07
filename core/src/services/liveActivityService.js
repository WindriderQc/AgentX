'use strict';

/**
 * Nerve Center live activity: what runs through Core right now and in the
 * last minutes, plus each GPU's recent power draw.
 *
 * - requests: Core's own inference admissions (runtime coordination). Work
 *   bound to a heavy-work or Benchmark workload is counted, not listed.
 * - recent: completed inference rows per minute and per caller.
 * - power: the gpu-agent samples kept by Data (one every ~30 s per GPU).
 * - one minute's requests (readMinuteRequests): caller, machine, duration,
 *   status and a stable failure reason. Never the error text, prompts or
 *   replies.
 *
 * Read-only. Each part fails on its own and reports its error.
 */

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const InferenceLog = require('../../models/InferenceLog');
const { fetchData } = require('./dataServiceClient');
const { failureReasonExpression } = require('./inferenceFailureAnalytics');
const { FAILURE_REASONS } = require('./routing/inferenceFailureReasons');

const MIN_MINUTES = 5;
const MAX_MINUTES = 60;
const DEFAULT_MINUTES = 15;
const MAX_ACTIVE = 50;
const TOP_CALLERS = 6;
const DATA_TIMEOUT_MS = 5000;
const MINUTE_ROWS = 60;
const MINUTE_MAX_AGE_MS = 24 * 3600_000;

// Core's own internal callers, named in plain words when no caller label exists.
const PRINCIPAL_LABELS = Object.freeze({
  'core-chat': 'Chat',
  'core-watchdog': 'Watchdog probe',
  'core-startup-pin-warm': 'Pin warm-up',
  'core-session-hold': 'Session hold',
  'core-trusted-runtime': 'Trusted runtime',
  'core-inference': 'Inference proxy',
  'core-service': 'Core service',
});

function boundedMinutes(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_MINUTES;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, n));
}

function requestLabel(item) {
  return item.caller || PRINCIPAL_LABELS[item.principal] || item.principal || 'Unknown caller';
}

function isMaintenance(item) {
  return /^(watchdog-probe|pin-warm)/.test(String(item.kind || ''));
}

// Never expose admission ids or generations: they are proofs of ownership.
function projectRequest(item, now) {
  const since = item.acquiredAt ? new Date(item.acquiredAt) : null;
  return {
    label: requestLabel(item),
    host: item.host || null,
    model: item.model || null,
    kind: item.kind || null,
    stream: /stream/.test(String(item.kind || '')),
    maintenance: isMaintenance(item),
    state: item.state || 'ACTIVE',
    since: since ? since.toISOString() : null,
    ageMs: since ? Math.max(0, now - since.getTime()) : null,
  };
}

async function readActiveRequests({ now = Date.now(), model = RuntimeCoordination } = {}) {
  const doc = await model.findOne({ _id: 'runtime' }, { inferences: 1 }).lean();
  const all = Array.isArray(doc?.inferences) ? doc.inferences : [];
  const heldByWork = all.filter(item => item.workloadAdmissionId);
  const active = all.filter(item => !item.workloadAdmissionId)
    .map(item => projectRequest(item, now))
    .sort((a, b) => (b.ageMs || 0) - (a.ageMs || 0))
    .slice(0, MAX_ACTIVE);
  return {
    active,
    heavyWorkInFlight: heldByWork.length,
    heavyWorkHosts: [...new Set(heldByWork.map(item => item.host).filter(Boolean))],
  };
}

async function readRecentActivity({ minutes, now = Date.now(), model = InferenceLog } = {}) {
  const since = new Date(now - minutes * 60_000);
  const [perMinute, byCaller] = await Promise.all([
    model.aggregate([
      { $match: { timestamp: { $gte: since } } },
      { $group: {
        _id: { $dateTrunc: { date: '$timestamp', unit: 'minute' } },
        n: { $sum: 1 },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 0, 1] } },
      } },
      { $sort: { _id: 1 } },
    ]),
    model.aggregate([
      { $match: { timestamp: { $gte: since } } },
      { $group: { _id: { $ifNull: ['$callerDetail', { $ifNull: ['$consumerContract', '$caller'] }] }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: TOP_CALLERS + 1 },
    ]),
  ]);
  const total = perMinute.reduce((sum, row) => sum + row.n, 0);
  return {
    windowMinutes: minutes,
    since: since.toISOString(),
    total,
    perMinute: perMinute.map(row => ({ t: new Date(row._id).toISOString(), n: row.n, failed: row.failed })),
    byCaller: byCaller.slice(0, TOP_CALLERS).map(row => ({ label: row._id || 'Unknown caller', n: row.n })),
    moreCallers: byCaller.length > TOP_CALLERS,
  };
}

function clean(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function originOf(value) {
  try { return new URL(value).origin; } catch (_) { return null; }
}

// The minute that contains `at`, if it lies in the last 24 hours.
function minuteBounds(at, now) {
  const t = Date.parse(at);
  if (!Number.isFinite(t) || t > now + 60_000 || t < now - MINUTE_MAX_AGE_MS) return null;
  const start = Math.floor(t / 60_000) * 60_000;
  return { start: new Date(start), end: new Date(start + 60_000) };
}

async function readMinuteRequests({ at, now = Date.now(), model = InferenceLog } = {}) {
  const bounds = minuteBounds(at, now);
  if (!bounds) {
    const error = new Error('at must be a time in the last 24 hours');
    error.statusCode = 400;
    throw error;
  }
  const match = { timestamp: { $gte: bounds.start, $lt: bounds.end } };
  const [rows, total] = await Promise.all([
    model.aggregate([
      { $match: match },
      { $sort: { timestamp: 1, _id: 1 } },
      { $limit: MINUTE_ROWS },
      { $project: {
        _id: 0, timestamp: 1, status: 1, durationMs: 1, host: 1, model: 1,
        label: { $ifNull: ['$callerDetail', { $ifNull: ['$consumerContract', '$caller'] }] },
        reason: { $cond: [{ $eq: ['$status', 'success'] }, null, failureReasonExpression()] },
      } },
    ]),
    model.countDocuments(match),
  ]);
  return {
    minute: bounds.start.toISOString(),
    total,
    truncated: total > rows.length,
    requests: rows.map(row => ({
      at: row.timestamp ? new Date(row.timestamp).toISOString() : null,
      caller: (row.label !== 'unknown' && clean(row.label, 96)) || 'Unknown caller',
      host: originOf(row.host),
      model: clean(row.model, 120),
      durationMs: numberOrNull(row.durationMs),
      status: ['success', 'error', 'timeout'].includes(row.status) ? row.status : 'error',
      reason: row.status === 'success' ? null : (FAILURE_REASONS.includes(row.reason) ? row.reason : 'unclassified_error'),
    })),
  };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function readPowerHistory({ minutes, now = Date.now(), fetchImpl = fetchData } = {}) {
  const { response, body } = await fetchImpl('/api/v1/hardware/latest', { timeoutMs: DATA_TIMEOUT_MS });
  if (!response.ok || !Array.isArray(body?.data?.hosts ?? body?.data)) {
    throw new Error(body?.message || `Data returned HTTP ${response.status}`);
  }
  const hostRows = Array.isArray(body.data) ? body.data : body.data.hosts;
  const hostIds = [...new Set(hostRows.map(row => row.hostId).filter(Boolean))].slice(0, 16);
  const from = new Date(now - minutes * 60_000).toISOString();
  const hosts = {};
  await Promise.all(hostIds.map(async (hostId) => {
    const query = new URLSearchParams({ hostId, from, limit: '2000' });
    try {
      const res = await fetchImpl('/api/v1/hardware/history', { query: query.toString(), timeoutMs: DATA_TIMEOUT_MS });
      const samples = res.response.ok && Array.isArray(res.body?.data?.samples) ? res.body.data.samples : null;
      if (!samples) { hosts[hostId] = { error: res.body?.message || `HTTP ${res.response.status}` }; return; }
      const gpus = {};
      for (const sample of samples) {
        if (!Number.isInteger(sample.index)) continue;
        (gpus[sample.index] ||= []).push({
          t: sample.sampledAt,
          w: numberOrNull(sample.powerDrawW),
          limit: numberOrNull(sample.powerLimitW),
        });
      }
      for (const series of Object.values(gpus)) series.sort((a, b) => String(a.t).localeCompare(String(b.t)));
      hosts[hostId] = { gpus };
    } catch (error) {
      hosts[hostId] = { error: error.message };
    }
  }));
  return { windowMinutes: minutes, from, hosts };
}

async function settle(work) {
  try { return { ok: true, data: await work() }; }
  catch (error) { return { ok: false, error: error.name === 'TimeoutError' ? 'timed out' : error.message }; }
}

async function getLiveActivity({ minutes: rawMinutes } = {}, deps = {}) {
  const now = deps.now ?? Date.now();
  const minutes = boundedMinutes(rawMinutes);
  const [requests, recent, power] = await Promise.all([
    settle(() => readActiveRequests({ now, model: deps.coordinationModel })),
    settle(() => readRecentActivity({ minutes, now, model: deps.logModel })),
    settle(() => readPowerHistory({ minutes, now, fetchImpl: deps.fetchImpl })),
  ]);
  return { sampledAt: new Date(now).toISOString(), minutes, requests, recent, power };
}

module.exports = {
  getLiveActivity, readActiveRequests, readRecentActivity, readPowerHistory, readMinuteRequests,
  minuteBounds, boundedMinutes, requestLabel, projectRequest, PRINCIPAL_LABELS,
};
