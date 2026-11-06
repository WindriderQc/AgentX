'use strict';

// A bounded view over existing Core observations. The instance maps native
// identities to scene nodes; the renderer never receives URLs, models or logs.
const fs = require('node:fs');
const path = require('node:path');
const CONTRACT = 'agentx.ecosystem-live/v1';
const SOURCE = 'core.ecosystem.live';
const LIVE_MS = 30_000;
const SOURCE_MS = 120_000;
const CACHE_MS = 5_000;
const RETAIN_MS = 5 * 60_000;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = code => Object.assign(new Error('Ecosystem live state is unavailable.'), { code, status: 503 });
const instant = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z')) ? ms : null;
};

function validateConfig(raw) {
  if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.nodes) || raw.nodes.length > 32
    || Object.keys(raw).some(key => !['version', 'nodes'].includes(key))) throw fail('ECOSYSTEM_LIVE_CONFIG_INVALID');
  const ids = new Set(), sources = new Set();
  return { version: 1, nodes: raw.nodes.map(row => {
    if (!object(row) || typeof row.id !== 'string' || !ID.test(row.id) || ids.has(row.id)
      || Object.keys(row).some(key => !['id', 'hosts', 'services'].includes(key))) throw fail('ECOSYSTEM_LIVE_CONFIG_INVALID');
    ids.add(row.id);
    const hasHosts = Object.hasOwn(row, 'hosts'), hasServices = Object.hasOwn(row, 'services');
    const key = hasHosts ? 'hosts' : 'services';
    if (hasHosts === hasServices || !Array.isArray(row[key]) || !row[key].length || row[key].length > 8
      || row[key].some(id => typeof id !== 'string' || !ID.test(id) || sources.has(key + ':' + id))) throw fail('ECOSYSTEM_LIVE_CONFIG_INVALID');
    if (new Set(row[key]).size !== row[key].length) throw fail('ECOSYSTEM_LIVE_CONFIG_INVALID');
    row[key].forEach(id => sources.add(key + ':' + id));
    return { id: row.id, [key]: [...row[key]] };
  }) };
}

function loadConfig(env = process.env) {
  if (!env.AGENTX_INSTANCE_ROOT) throw fail('ECOSYSTEM_LIVE_NOT_CONFIGURED');
  const file = path.join(env.AGENTX_INSTANCE_ROOT, 'config/ecosystem-live.json');
  try {
    if (fs.statSync(file).size > 16_384) throw fail('ECOSYSTEM_LIVE_CONFIG_INVALID');
    return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    throw fail(error.code === 'ENOENT' ? 'ECOSYSTEM_LIVE_NOT_CONFIGURED' : 'ECOSYSTEM_LIVE_CONFIG_INVALID');
  }
}

function evidence(at, now) {
  const time = instant(at);
  if (time === null || time > now) return { observedAt: null, expiresAt: null, freshness: 'unknown' };
  return { observedAt: new Date(time).toISOString(), expiresAt: new Date(Math.min(now + LIVE_MS, time + SOURCE_MS)).toISOString(),
    freshness: now - time > SOURCE_MS ? 'stale' : 'current' };
}

function combine(states) {
  if (states.every(state => state === 'offline')) return 'offline';
  if (states.every(state => state === 'parked')) return 'parked';
  if (states.includes('unknown')) return 'unknown';
  if (states.includes('offline') || states.includes('degraded')) return 'degraded';
  if (states.includes('busy')) return 'busy';
  return 'online';
}

function projectSnapshot(snapshot, rawConfig, now = Date.now()) {
  const config = validateConfig(rawConfig);
  if (snapshot?.authority !== 'agentx-product' || snapshot.readOnly !== true || snapshot.schemaVersion !== 2
    || instant(snapshot.generatedAt) === null || !Array.isArray(snapshot.cluster) || !Array.isArray(snapshot.services)) {
    throw fail('ECOSYSTEM_LIVE_SOURCE_INVALID');
  }
  const generated = instant(snapshot.generatedAt);
  if (generated > now + 5000 || now - generated > LIVE_MS) throw fail('ECOSYSTEM_LIVE_SOURCE_STALE');
  const contradictory = ['contradictory', 'inconsistent'].includes(snapshot.evidenceTrust?.status);
  const nodes = config.nodes.map(mapping => {
    const host = Boolean(mapping.hosts), keys = mapping.hosts || mapping.services;
    const rows = keys.map(key => (host ? snapshot.cluster.find(row => row.hostKey === key) : snapshot.services.find(row => row.id === key)));
    // A failed service probe has no running-service identity. Its source batch
    // still records when reachability was checked; final aggregation is not it.
    const observations = rows.map(row => evidence(host ? row?.checkedAt
      : row ? row.identity?.ts ?? snapshot.evidence?.servicesObservedAt : null, generated));
    const known = observations.map(row => instant(row.observedAt));
    const complete = rows.every(Boolean) && known.every(time => time !== null);
    const oldest = complete ? Math.min(...known) : null;
    const observed = evidence(oldest === null ? null : new Date(oldest).toISOString(), generated);
    const state = combine(rows.map(row => {
      if (contradictory || !row) return 'unknown';
      if (!host) return ({ ok: 'online', down: 'offline', degraded: 'degraded' })[row.status] || 'unknown';
      if (row.status !== 'online') return ['offline', 'parked'].includes(row.status) ? row.status : 'unknown';
      // A native preference transition is evidence of occupation, not a guessed
      // GPU load or evidence that a particular personal task is running.
      const preference = snapshot.hostPreferences?.find(pref => pref.hostKey === row.hostKey);
      if (['restoring', 'swapping', 'benchmarking'].includes(preference?.status)) return 'busy';
      return 'online';
    }));
    return { id: mapping.id, source: host ? 'inference_endpoints' : 'product_service', state,
      ...observed, ...(contradictory && { freshness: 'unknown' }) };
  });
  return { contract: 'agentx.presentation-read/v1', source: SOURCE, page: 'ecosystem',
    observedAt: new Date(generated).toISOString(), expiresAt: new Date(generated + LIVE_MS).toISOString(), nodes,
    limits: ['Inference endpoint availability does not establish physical host, voice or tool health.',
      'Product service health does not establish an accepted user journey. Unmapped nodes have no live evidence.',
      'No model names, addresses, raw alerts, task payloads or execution authority are included.'] };
}

// Keep the captured data immutable. Freshness is a separate read annotation;
// the stored observation timestamp is never moved forward by a cache read.
function readFreshness(snapshot, now = Date.now()) {
  return { ...snapshot, freshness: now >= Date.parse(snapshot.expiresAt) ? 'stale' : 'current',
    nodes: snapshot.nodes.map(node => ({ ...node, effectiveFreshness: node.freshness === 'current'
      && now >= Date.parse(node.expiresAt) ? 'stale' : node.freshness })) };
}

function createLiveState({ buildSnapshot, config = loadConfig, composition = () => null, reader, now = Date.now } = {}) {
  let cached = null, pending = null, epoch = 0;
  return async function read() {
    const settings = config(), inventory = composition(), key = JSON.stringify([settings, inventory?.contentRevision]);
    if (cached?.key === key && cached.until > now()) return cached.value;
    if (pending?.key === key) return pending.promise;
    const generation = ++epoch;
    const promise = (async () => {
      const snapshot = projectSnapshot(await buildSnapshot(), settings, now());
      const read = reader.publishEcosystemLive(snapshot);
      if (!read) throw fail('ECOSYSTEM_LIVE_NOT_RETAINED');
      const value = { contract: CONTRACT, generatedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt, nodes: snapshot.nodes, read,
        ...(inventory && { composition: { contentRevision: inventory.contentRevision, read: inventory.read } }) };
      if (generation === epoch) cached = { key, until: Math.min(now() + CACHE_MS, Date.parse(value.expiresAt)), value };
      return value;
    })();
    pending = { key, promise };
    try { return await promise; }
    catch (error) { if (generation === epoch) cached = null; throw error; }
    finally { if (generation === epoch) pending = null; }
  };
}

module.exports = { CONTRACT, SOURCE, LIVE_MS, RETAIN_MS, validateConfig, loadConfig, projectSnapshot, readFreshness, createLiveState };
