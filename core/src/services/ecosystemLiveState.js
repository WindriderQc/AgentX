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
  if (!object(raw) || ![1, 2].includes(raw.version) || !Array.isArray(raw.nodes) || raw.nodes.length > (raw.version === 1 ? 32 : 64)
    || Object.keys(raw).some(key => !['version', 'nodes', ...(raw.version === 2 ? ['observer'] : [])].includes(key))) throw fail('ECOSYSTEM_LIVE_CONFIG_INVALID');
  const ids = new Set(), sources = new Set();
  if (raw.version === 2 && (!object(raw.observer) || Object.keys(raw.observer).length !== 2
    || !require('./ecosystemObservations').validPath(raw.observer.script) || !require('./ecosystemObservations').validPath(raw.observer.config))) throw fail('ECOSYSTEM_LIVE_CONFIG_INVALID');
  return { version: raw.version, ...(raw.version === 2 && { observer: { ...raw.observer } }), nodes: raw.nodes.map(row => {
    if (!object(row) || typeof row.id !== 'string' || !ID.test(row.id) || ids.has(row.id)
      || Object.keys(row).some(key => !['id', 'hosts', 'services', ...(raw.version === 2 ? ['observations', 'unobserved'] : [])].includes(key))) throw fail('ECOSYSTEM_LIVE_CONFIG_INVALID');
    ids.add(row.id);
    const kinds = ['hosts', 'services', 'observations', 'unobserved'].filter(key => Object.hasOwn(row, key));
    if (kinds.length !== 1) throw fail('ECOSYSTEM_LIVE_CONFIG_INVALID');
    const key = kinds[0];
    if (key === 'unobserved') {
      if (row.unobserved !== true) throw fail('ECOSYSTEM_LIVE_CONFIG_INVALID');
      return { id: row.id, unobserved: true };
    }
    if (!Array.isArray(row[key]) || !row[key].length || row[key].length > 8
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

function evidence(at, now, ttl = SOURCE_MS) {
  const time = instant(at);
  if (time === null || time > now) return { observedAt: null, expiresAt: null, freshness: 'unknown' };
  return { observedAt: new Date(time).toISOString(), expiresAt: new Date(Math.min(now + LIVE_MS, time + ttl)).toISOString(),
    freshness: now - time >= ttl ? 'stale' : 'current' };
}

function combine(states) {
  if (states.every(state => state === 'offline')) return 'offline';
  if (states.every(state => state === 'parked')) return 'parked';
  if (states.includes('unknown')) return 'unknown';
  if (states.includes('offline') || states.includes('degraded')) return 'degraded';
  if (states.includes('busy')) return 'busy';
  return 'online';
}

function projectSnapshot(snapshot, rawConfig, now = Date.now(), native = []) {
  const config = validateConfig(rawConfig);
  if (snapshot?.authority !== 'agentx-product' || snapshot.readOnly !== true || snapshot.schemaVersion !== 2
    || instant(snapshot.generatedAt) === null || !Array.isArray(snapshot.cluster) || !Array.isArray(snapshot.services)) {
    throw fail('ECOSYSTEM_LIVE_SOURCE_INVALID');
  }
  const generated = instant(snapshot.generatedAt);
  if (generated > now + 5000 || now - generated > LIVE_MS) throw fail('ECOSYSTEM_LIVE_SOURCE_STALE');
  const contradictory = ['contradictory', 'inconsistent'].includes(snapshot.evidenceTrust?.status);
  const sourceNow = config.version === 2 ? now : generated;
  const nodes = config.nodes.filter(row => row.hosts || row.services).map(mapping => {
    const host = Boolean(mapping.hosts), keys = mapping.hosts || mapping.services;
    const rows = keys.map(key => (host ? snapshot.cluster.find(row => row.hostKey === key) : snapshot.services.find(row => row.id === key)));
    // A failed service probe has no running-service identity. Its source batch
    // still records when reachability was checked; final aggregation is not it.
    const observations = rows.map(row => evidence(host ? row?.checkedAt
      : row ? row.identity?.ts ?? snapshot.evidence?.servicesObservedAt : null, sourceNow));
    const known = observations.map(row => instant(row.observedAt));
    const complete = rows.every(Boolean) && known.every(time => time !== null);
    const oldest = complete ? Math.min(...known) : null;
    const observed = evidence(oldest === null ? null : new Date(oldest).toISOString(), sourceNow);
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
  const generatedAt = config.version === 2 ? now : generated;
  if (config.version === 2) {
    for (const mapping of config.nodes.filter(row => row.observations || row.unobserved)) {
      const rows = (mapping.observations || []).map(id => native.find(row => row.id === id));
      const times = rows.map(row => instant(row?.observedAt));
      const oldest = rows.length && times.every(time => time !== null && time <= now) ? Math.min(...times) : null;
      const ttl = rows.length ? Math.min(...rows.map(row => row?.ttlMs || SOURCE_MS)) : SOURCE_MS;
      const observed = evidence(oldest === null ? null : new Date(oldest).toISOString(), now, ttl);
      const scopes = [...new Set(rows.map(row => row?.source).filter(Boolean))];
      nodes.push({ id: mapping.id, source: mapping.unobserved ? 'unobserved' : scopes.length === 1 ? scopes[0] : 'observation',
        state: rows.length ? combine(rows.map(row => row?.state || 'unknown')) : 'unknown', ...observed });
    }
    nodes.sort((a, b) => config.nodes.findIndex(row => row.id === a.id) - config.nodes.findIndex(row => row.id === b.id));
  }
  return { contract: 'agentx.presentation-read/v1', source: SOURCE, page: 'ecosystem',
    observedAt: new Date(generatedAt).toISOString(), expiresAt: new Date(generatedAt + LIVE_MS).toISOString(), nodes,
    limits: ['Inference endpoint availability does not establish physical host, voice or tool health.',
      'Product service health does not establish an accepted user journey. Unmapped nodes have no live evidence.',
      'Native process, HTTP interface, collector, storage and network scopes are distinct; none establish a successful user task. Network absence is not physical shutdown. Unobserved means no reliable probe is configured.',
      'No model names, addresses, raw alerts, task payloads or execution authority are included.'] };
}

// Keep the captured data immutable. Freshness is a separate read annotation;
// the stored observation timestamp is never moved forward by a cache read.
function readFreshness(snapshot, now = Date.now()) {
  return { ...snapshot, freshness: now >= Date.parse(snapshot.expiresAt) ? 'stale' : 'current',
    nodes: snapshot.nodes.map(node => ({ ...node, effectiveFreshness: node.freshness === 'current'
      && now >= Date.parse(node.expiresAt) ? 'stale' : node.freshness })) };
}

function createLiveState({ buildSnapshot, config = loadConfig, composition = () => null, observations = require('./ecosystemObservations').createObservationReader(), reader, now = Date.now } = {}) {
  let cached = null, pending = null, epoch = 0;
  return async function read() {
    const settings = config(), inventory = composition(), key = JSON.stringify([settings, inventory?.contentRevision]);
    if (cached?.key === key && cached.until > now()) return cached.value;
    if (pending?.key === key) return pending.promise;
    const generation = ++epoch;
    const promise = (async () => {
      const results = await Promise.allSettled([buildSnapshot(), settings.version === 2 ? observations(settings) : Promise.resolve([])]);
      if (settings.version === 1 && results[0].status === 'rejected') throw results[0].reason;
      const base = results[0].status === 'fulfilled' ? results[0].value : settings.version === 2
        ? { authority: 'agentx-product', readOnly: true, schemaVersion: 2, generatedAt: new Date(now()).toISOString(), cluster: [], services: [] } : null;
      const snapshot = projectSnapshot(base, settings, now(), results[1].status === 'fulfilled' ? results[1].value : []);
      const read = reader.publishEcosystemLive(snapshot);
      if (!read) throw fail('ECOSYSTEM_LIVE_NOT_RETAINED');
      const value = { contract: settings.version === 2 ? 'agentx.ecosystem-live/v2' : CONTRACT, generatedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt, nodes: snapshot.nodes, read,
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
