'use strict';

/**
 * Bounded GPU telemetry store fed by the native gpu-agent collector.
 *
 * - `hardware_collectors`: one row per collector (heartbeat, interval, declared hosts)
 * - `hardware_hosts`: latest snapshot and error/staleness state per GPU host,
 *   with the latest observation of its Ollama service settings when collected
 * - `hardware_gpu_samples`: per-GPU history, expired by a TTL index
 */

const { normalizeOllamaEnvironment } = require('../../shared/ollamaServiceEnvironment');
const activityEvents = require('./activityEvents');

const COLLECTORS = 'hardware_collectors';
const HOSTS = 'hardware_hosts';
const SAMPLES = 'hardware_gpu_samples';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_HOSTS = 32;
const MAX_GPUS = 16;
const MAX_HISTORY_LIMIT = 2000;
const MIN_ACTIVE_WINDOW_MS = 90_000;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TTL_DAYS = 7;
const MAX_TTL_DAYS = 90;
const TTL_INDEX_NAME = 'hardware_sample_ttl';

const NUMERIC_FIELDS = [
  'utilizationPct', 'memoryUtilizationPct', 'memoryUsedMiB', 'memoryTotalMiB',
  'temperatureC', 'powerDrawW', 'powerLimitW', 'smClockMHz', 'smClockMaxMHz',
  'pcieGen', 'pcieGenMax', 'pcieWidth', 'pcieWidthMax'
];

function historyTtlSeconds(env = process.env) {
  const days = Number(env.DATA_HARDWARE_HISTORY_TTL_DAYS);
  const bounded = Number.isFinite(days) && days > 0 ? Math.min(MAX_TTL_DAYS, days) : DEFAULT_TTL_DAYS;
  return Math.round(bounded * 86400);
}

function text(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validDate(value, fallback) {
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

function boundedInterval(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INTERVAL_MS;
  return Math.min(600_000, Math.max(5_000, Math.round(parsed)));
}

function staleAfterMs(intervalMs) {
  return Math.max(MIN_ACTIVE_WINDOW_MS, 3 * boundedInterval(intervalMs));
}

function normalizeGpu(raw, position) {
  const gpu = {
    index: Number.isInteger(Number(raw?.index)) ? Number(raw.index) : position,
    name: text(raw?.name),
    uuid: text(raw?.uuid, 80),
    busId: text(raw?.busId, 40),
    throttleReasonsActive: text(raw?.throttleReasonsActive, 40) || null,
    throttleReasons: Array.isArray(raw?.throttleReasons)
      ? raw.throttleReasons.map(value => text(value, 40)).filter(Boolean).slice(0, 16)
      : []
  };
  for (const field of NUMERIC_FIELDS) gpu[field] = finiteOrNull(raw?.[field]);
  return gpu;
}

function normalizeDeclaredHost(raw) {
  const hostId = text(raw?.id ?? raw?.hostId, 128);
  if (!SAFE_ID.test(hostId)) return null;
  return {
    hostId,
    name: text(raw?.name) || hostId,
    ollamaUrl: text(raw?.ollamaUrl, 300),
    local: raw?.local === true
  };
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function collectorFields(info) {
  const collectorId = text(info?.collectorId, 128);
  if (!SAFE_ID.test(collectorId)) throw validationError('collectorId must be a stable identifier');
  const hosts = Array.isArray(info?.hosts) ? info.hosts : [];
  if (hosts.length > MAX_HOSTS) throw validationError(`at most ${MAX_HOSTS} hosts per collector`);
  return {
    collectorId,
    hostname: text(info?.hostname),
    platform: text(info?.platform, 40),
    agentVersion: text(info?.agentVersion, 40),
    intervalMs: boundedInterval(info?.intervalMs),
    hosts: hosts.map(normalizeDeclaredHost).filter(Boolean)
  };
}

async function registerCollector(db, info = {}, now = new Date()) {
  const fields = collectorFields(info);
  const result = await db.collection(COLLECTORS).updateOne(
    { collectorId: fields.collectorId },
    { $set: { ...fields, lastSeen: now }, $setOnInsert: { firstSeen: now } },
    { upsert: true }
  );
  await activityEvents.collectorSeen(db, 'gpu', fields.collectorId, {
    inserted: (result?.upsertedCount || 0) > 0, hostname: fields.hostname
  });
  return fields;
}

/**
 * Store one collection cycle: every host result updates its latest state; only
 * successful results append GPU history. A failed host keeps its last GPUs and
 * last sample time so readers can see how stale they are.
 */
async function ingestSamples(db, body = {}, now = new Date()) {
  const collector = await registerCollector(db, body, now);
  const results = Array.isArray(body.results) ? body.results : [];
  if (results.length > MAX_HOSTS) throw validationError(`at most ${MAX_HOSTS} host results per request`);
  const declared = new Map(collector.hosts.map(host => [host.hostId, host]));

  let accepted = 0;
  let failed = 0;
  let gpuSamples = 0;
  const sampledHosts = [];
  const historyDocs = [];
  const hostWrites = [];
  for (const raw of results) {
    const known = declared.get(text(raw?.hostId, 128)) || {};
    const base = normalizeDeclaredHost({
      id: raw?.hostId,
      name: raw?.name ?? known.name,
      ollamaUrl: raw?.ollamaUrl ?? known.ollamaUrl,
      local: raw?.local ?? known.local
    });
    if (!base) continue;
    const sampledAt = validDate(raw.sampledAt, now);
    // Ollama settings are read less often than GPUs: a result without them keeps
    // the previous observation, which carries its own observedAt.
    const ollamaEnvironment = normalizeOllamaEnvironment(raw.ollamaEnvironment);
    const common = {
      collectorId: collector.collectorId,
      name: base.name,
      ollamaUrl: base.ollamaUrl,
      local: base.local,
      intervalMs: collector.intervalMs,
      lastAttemptAt: sampledAt,
      ...(ollamaEnvironment && { ollamaEnvironment })
    };
    if (raw.ok === true) {
      const gpus = (Array.isArray(raw.gpus) ? raw.gpus : []).slice(0, MAX_GPUS).map(normalizeGpu);
      accepted += 1;
      gpuSamples += gpus.length;
      sampledHosts.push({ hostId: base.hostId, name: base.name, collectorId: collector.collectorId });
      for (const gpu of gpus) {
        historyDocs.push({ hostId: base.hostId, collectorId: collector.collectorId, sampledAt, ...gpu });
      }
      hostWrites.push({
        updateOne: {
          filter: { hostId: base.hostId },
          update: {
            $set: {
              ...common,
              status: 'ok',
              lastSampleAt: sampledAt,
              gpuCount: gpus.length,
              gpus,
              consecutiveFailures: 0,
              lastError: null
            },
            $setOnInsert: { firstSeen: now }
          },
          upsert: true
        }
      });
    } else {
      failed += 1;
      hostWrites.push({
        updateOne: {
          filter: { hostId: base.hostId },
          update: {
            $set: {
              ...common,
              status: 'error',
              lastError: text(raw.error, 500) || 'collection failed',
              lastErrorAt: sampledAt
            },
            $inc: { consecutiveFailures: 1 },
            $setOnInsert: { firstSeen: now, gpus: [], gpuCount: 0, lastSampleAt: null }
          },
          upsert: true
        }
      });
    }
  }
  if (hostWrites.length) await db.collection(HOSTS).bulkWrite(hostWrites, { ordered: false });
  if (historyDocs.length) await db.collection(SAMPLES).insertMany(historyDocs, { ordered: false });
  await Promise.all(sampledHosts.map(host => activityEvents.gpuHostSampled(db, host)));
  return { collectorId: collector.collectorId, accepted, failed, gpuSamples };
}

function projectHost(doc, nowMs) {
  const lastSampleMs = doc.lastSampleAt ? new Date(doc.lastSampleAt).getTime() : null;
  const ageMs = Number.isFinite(lastSampleMs) ? Math.max(0, nowMs - lastSampleMs) : null;
  const threshold = staleAfterMs(doc.intervalMs);
  const fresh = ageMs != null && ageMs <= threshold;
  const { _id, ...rest } = doc;
  return {
    ...rest,
    ageMs,
    staleAfterMs: threshold,
    stale: !fresh,
    freshness: ageMs == null ? 'no_data' : fresh ? 'fresh' : 'stale'
  };
}

async function latest(db, filter = {}, now = Date.now()) {
  const query = {};
  if (filter.hostId) query.hostId = text(filter.hostId, 128);
  if (filter.collectorId) query.collectorId = text(filter.collectorId, 128);
  const docs = await db.collection(HOSTS).find(query).sort({ hostId: 1 }).limit(MAX_HOSTS * 4).toArray();
  return docs.map(doc => projectHost(doc, now));
}

async function listCollectors(db, now = Date.now()) {
  const docs = await db.collection(COLLECTORS).find({}).sort({ lastSeen: -1 }).limit(100).toArray();
  return docs.map(({ _id, ...doc }) => ({
    ...doc,
    active: now - new Date(doc.lastSeen || 0).getTime() < staleAfterMs(doc.intervalMs)
  }));
}

async function history(db, filter = {}) {
  const hostId = text(filter.hostId, 128);
  if (!SAFE_ID.test(hostId)) throw validationError('hostId query param required');
  const query = { hostId };
  if (filter.gpuIndex !== undefined && filter.gpuIndex !== '') {
    const index = Number.parseInt(filter.gpuIndex, 10);
    if (!Number.isInteger(index) || index < 0) throw validationError('gpuIndex must be a non-negative integer');
    query.index = index;
  }
  const from = validDate(filter.from, null);
  const to = validDate(filter.to, null);
  if (from || to) query.sampledAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const parsedLimit = Number.parseInt(filter.limit, 10);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(MAX_HISTORY_LIMIT, parsedLimit) : 500;
  const samples = await db.collection(SAMPLES).find(query, { projection: { _id: 0 } })
    .sort({ sampledAt: -1 }).limit(limit).toArray();
  return { hostId, limit, samples };
}

/**
 * The history TTL is configurable, and createIndex cannot change an existing
 * index's expireAfterSeconds, so a changed setting is applied with collMod.
 */
async function ensureHistoryTtl(db, env = process.env) {
  const seconds = historyTtlSeconds(env);
  const collection = db.collection(SAMPLES);
  let existing = [];
  try { existing = await collection.indexes(); } catch (_) { existing = []; }
  const current = existing.find(index => index.name === TTL_INDEX_NAME);
  if (current && current.expireAfterSeconds !== seconds) {
    await db.command({ collMod: SAMPLES, index: { name: TTL_INDEX_NAME, expireAfterSeconds: seconds } });
    return { name: TTL_INDEX_NAME, expireAfterSeconds: seconds, updated: true };
  }
  if (!current) {
    await collection.createIndex({ sampledAt: 1 }, { name: TTL_INDEX_NAME, expireAfterSeconds: seconds });
  }
  return { name: TTL_INDEX_NAME, expireAfterSeconds: seconds, updated: false };
}

module.exports = {
  COLLECTORS,
  HOSTS,
  SAMPLES,
  MAX_HOSTS,
  MAX_GPUS,
  MAX_HISTORY_LIMIT,
  TTL_INDEX_NAME,
  historyTtlSeconds,
  staleAfterMs,
  normalizeGpu,
  registerCollector,
  ingestSamples,
  latest,
  listCollectors,
  history,
  ensureHistoryTtl,
  projectHost
};
