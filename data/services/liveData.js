/**
 * Live Data orchestrator.
 *
 * Drives every feed in the registry (services/livedata/registry.js): on a
 * per-feed interval it fetches → parses → stores → MQTT-publishes → emits a
 * `liveData` bus event. Adding a feed is a registry entry + a parser, not a new
 * code path here. Public API (init/close/reloadConfig/getState/getConfig) is
 * preserved for server.js + liveDataController.js.
 */
const appEmitter = require('../utils/eventEmitter');
const mqttClient = require('./mqttClient');
const { fetchWithTimeoutAndRetry } = require('../utils/fetch-utils');
const { log } = require('../utils/logger');
const registry = require('./livedata/registry');
const parsers = require('./livedata/parsers');
const store = require('./livedata/store');

let db;
let intervalIds = [];
let initialized = false;

// Resolved registry (seeded disabled until init() runs reloadConfig()).
let feeds = registry.getSeedFeeds().map(f => ({ ...f, enabled: false }));
let masterEnabled = false;
let prevEnabled = new Set();   // feed ids running before the last (re)start — for immediate-on-enable
const health = {};             // feedId -> { lastFetchAt, lastError, lastErrorAt, lastCount }

// --- Feed execution ---

function buildUrl(feed, vars) {
  const ctx = { sourceUrl: feed.sourceUrl, ...vars };
  return (feed.urlTemplate || feed.sourceUrl).replace(/\$\{(\w+)\}/g, (_, k) => (ctx[k] != null ? ctx[k] : ''));
}

function publishAndEmit(feed, docs, loc) {
  // Replace-mode feeds (e.g. quakes) refresh in bulk — emit one summary, not N.
  if (feed.store.mode === 'replace') {
    appEmitter.emit('liveData', { feedId: feed.id, count: docs.length, replaced: true });
    return;
  }
  for (const doc of docs) {
    if (feed.mqttPublish) {
      const topic = loc ? `${feed.mqttPublish}/${loc.lat},${loc.lon}` : feed.mqttPublish;
      mqttClient.publish(topic, doc);
    }
    appEmitter.emit('liveData', { feedId: feed.id, doc });
  }
}

async function fetchParseStore(feed, location) {
  const url = location
    ? buildUrl(feed, { ...location, apiKey: feed.apiKeyEnv ? process.env[feed.apiKeyEnv] : undefined })
    : feed.sourceUrl;
  const res = await fetchWithTimeoutAndRetry(url, { timeout: feed.timeout, retries: feed.retries, name: feed.label });
  const docs = await parsers[feed.parser](res, { feed, location });
  const n = await store.write(db, feed, docs);
  publishAndEmit(feed, docs, location);
  return n;
}

async function runFeed(feed) {
  if (!db) return;
  try {
    let count = 0;
    if (feed.fanout) {
      // Per-location fanout (e.g. weather over weatherLocations).
      if (feed.apiKeyEnv && !process.env[feed.apiKeyEnv]) return; // preserve original silent key guard
      const locations = await db.collection(feed.fanout).find({}).toArray();
      for (const loc of locations) count += await fetchParseStore(feed, loc);
    } else {
      count = await fetchParseStore(feed);
    }
    health[feed.id] = { lastFetchAt: new Date(), lastError: null, lastCount: count };
    if (feed.store.mode === 'replace') log(`[liveData] ${feed.label} refreshed: ${count} records`);
  } catch (err) {
    health[feed.id] = { ...(health[feed.id] || {}), lastError: err.message, lastErrorAt: new Date() };
    log(`[liveData] ${feed.label} error: ${err.message}`, 'error');
  }
}

// --- Lifecycle ---

function clearIntervals() {
  intervalIds.forEach(clearInterval);
  intervalIds = [];
}

function startIntervals() {
  if (!masterEnabled) {
    log('[liveData] Master switch OFF — no intervals');
    prevEnabled = new Set();
    return;
  }
  const nowEnabled = new Set();
  for (const feed of feeds) {
    if (!feed.enabled || feed.kind !== 'http') continue; // non-http (mqtt push-in) feeds wired in Phase 3
    nowEnabled.add(feed.id);
    const run = () => runFeed(feed).catch(e => log(`[liveData] ${feed.id} run error: ${e.message}`, 'warn'));
    if (!prevEnabled.has(feed.id)) run(); // immediate fetch when a feed first turns on / on boot
    intervalIds.push(setInterval(run, feed.intervalMs));
  }
  prevEnabled = nowEnabled;
  log(`[liveData] Intervals set — ${[...nowEnabled].join(', ') || 'none'}`);
}

// Resolve a push-in feed's MQTT topics from its env list (e.g. LIVEDATA_MQTT_TOPICS).
function resolveTopics(feed) {
  const raw = (feed.topicsEnv && process.env[feed.topicsEnv]) || (feed.topics ? feed.topics.join(',') : '');
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// One broker message → parse → store → publish/emit. Used by kind:'mqtt' feeds.
async function handleMqttMessage(feed, topic, payloadStr) {
  if (!db) return;
  try {
    const docs = await parsers[feed.parser]({ topic, payloadStr }, { feed, topic });
    const n = await store.write(db, feed, docs);
    publishAndEmit(feed, docs);
    health[feed.id] = { lastFetchAt: new Date(), lastError: null, lastCount: n };
  } catch (err) {
    health[feed.id] = { ...(health[feed.id] || {}), lastError: err.message, lastErrorAt: new Date() };
    log(`[liveData] ${feed.label} mqtt error: ${err.message}`, 'error');
  }
}

// (Re)subscribe enabled push-in feeds; drops prior subscriptions first so a
// reload doesn't double-handle. No-op when MQTT isn't connected.
function restartMqttFeeds() {
  mqttClient.unsubscribeAll();
  if (!masterEnabled) return;
  for (const feed of feeds) {
    if (!feed.enabled || feed.kind !== 'mqtt') continue;
    const topics = resolveTopics(feed);
    if (!topics.length) { log(`[liveData] ${feed.label} enabled but no topics (${feed.topicsEnv}) — skipped`, 'warn'); continue; }
    mqttClient.subscribe(topics, (topic, payloadStr) => handleMqttMessage(feed, topic, payloadStr));
  }
}

async function resolveFeeds() {
  const [overrideDocs, toggleDocs] = await Promise.all([
    db.collection('livedatafeeds').find({}).toArray().catch(() => []),
    db.collection('livedataconfigs').find({}).toArray()
  ]);
  masterEnabled = registry.isMasterEnabled(toggleDocs);
  feeds = registry.resolveRegistry(overrideDocs, toggleDocs);
}

async function reloadConfig() {
  try {
    await resolveFeeds();
    log(`[liveData] Config reloaded — master=${masterEnabled} feeds=${feeds.filter(f => f.enabled).map(f => f.id).join(',') || 'none'}`);
    clearIntervals();
    startIntervals();
    restartMqttFeeds();
  } catch (e) {
    log(`[liveData] Reload error: ${e.message}`, 'error');
  }
}

async function init(dbConnection) {
  if (initialized) return;
  db = dbConnection;

  // Ensure default toggle docs exist (master + each seeded feed's toggle).
  const defaults = [
    { service: 'liveDataEnabled', enabled: false },
    ...registry.getSeedFeeds().map(f => ({ service: f.legacyToggle || f.id, enabled: false }))
  ];
  for (const svc of defaults) {
    await db.collection('livedataconfigs').updateOne(
      { service: svc.service },
      { $setOnInsert: { service: svc.service, enabled: svc.enabled, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  // Connect MQTT first (if configured) so push-in feeds can subscribe on reload.
  if (process.env.MQTT_BROKER_URL) mqttClient.init();

  await reloadConfig(); // resolves feeds + starts http intervals + mqtt subscriptions

  initialized = true;
  log('[liveData] Initialized');
}

async function close() {
  clearIntervals();
  prevEnabled = new Set();
  await mqttClient.close();
  initialized = false;
}

// Back-compat: getState() returns { liveDataEnabled, <toggle>: bool, ... }.
function getState() {
  const s = { liveDataEnabled: masterEnabled };
  for (const f of feeds) s[f.legacyToggle || f.id] = !!f.enabled;
  return s;
}

module.exports = {
  init,
  close,
  reloadConfig,
  getState,
  // Registry + health getters (consumed by the uniform consumption API).
  getFeeds: () => feeds.map(f => ({ ...f, health: health[f.id] || null })),
  getFeedById: (id) => feeds.find(f => f.id === id) || null,
  getHealth: () => ({ ...health }),
  // Back-compat shim — original exported getConfig(); return the resolved feeds.
  getConfig: () => feeds
};
