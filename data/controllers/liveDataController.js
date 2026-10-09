const liveData = require('../services/liveData');
const appEmitter = require('../utils/eventEmitter');
const { log } = require('../utils/logger');

// ── SSE plumbing (mirrors eventController; separate connection pool) ──
const MAX_SSE_CONNECTIONS = 50;
let sseCount = 0;
const sseConnections = new Set();

// ── helpers ──────────────────────────────────────────────────────
// Where a feed's points live + which field carries its timestamp.
function queryFor(feed) {
  if (feed.store.mode === 'points') {
    return { collectionName: 'livedata_points', filter: { feedId: feed.id }, tsField: 'ts' };
  }
  return { collectionName: feed.store.collection, filter: {}, tsField: feed.store.tsField || 'timeStamp' };
}

function feedOr404(req, res) {
  const id = req.params.feed;
  const feed = liveData.getFeedById(id);
  if (!feed) {
    res.status(404).json({ status: 'error', message: `Unknown feed '${id}'`, validFeeds: liveData.getFeeds().map(f => f.id) });
    return null;
  }
  return feed;
}

// Accept ISO string or epoch-ms for from/to.
function parseTs(v) {
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== '') return new Date(n);
  return new Date(v);
}

// ── config / state ───────────────────────────────────────────────
exports.getState = async (req, res) => {
  res.json({ status: 'success', data: liveData.getState() });
};

exports.getConfig = async (req, res) => {
  try {
    const db = req.app.locals.db;
    const configs = await db.collection('livedataconfigs').find({}).toArray();
    const result = configs.reduce((acc, c) => { acc[c.service] = c.enabled; return acc; }, {});
    res.json({ status: 'success', data: result });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
};

exports.updateConfig = async (req, res) => {
  const { service, enabled } = req.body;
  // Valid = master switch + every registry feed's toggle key (so new feeds are toggleable).
  const feedKeys = liveData.getFeeds().map(f => f.legacyToggle || f.id);
  const valid = ['liveDataEnabled', ...feedKeys];
  if (!valid.includes(service)) {
    return res.status(400).json({ status: 'error', message: `Invalid service. Must be: ${valid.join(', ')}` });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ status: 'error', message: 'enabled must be true or false' });
  }
  // Without the orchestrator a stored toggle starts nothing; say so instead of reporting success.
  if (!liveData.isRunning()) {
    return res.status(409).json({
      status: 'error',
      message: 'Live feeds are not running on this instance: start Data with DATA_BACKGROUND_JOBS_ENABLED=true'
    });
  }
  try {
    const db = req.app.locals.db;
    await db.collection('livedataconfigs').updateOne(
      { service }, { $set: { enabled, updatedAt: new Date() } }, { upsert: true }
    );
    await liveData.reloadConfig();
    res.json({ status: 'success', message: `${service} set to ${enabled}` });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
};

// ── feeds registry + health ──────────────────────────────────────
exports.getFeeds = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const feeds = liveData.getFeeds();
    const now = Date.now();
    const out = await Promise.all(feeds.map(async (f) => {
      const { collectionName, filter } = queryFor(f);
      let count = 0;
      try { count = await db.collection(collectionName).countDocuments(filter); } catch { /* ignore */ }
      const h = f.health || {};
      return {
        id: f.id, label: f.label, category: f.category, kind: f.kind,
        enabled: !!f.enabled, intervalMs: f.intervalMs, geo: !!f.geo,
        store: { collection: f.store.collection, mode: f.store.mode },
        count,
        lastFetchAt: h.lastFetchAt || null,
        ageMs: h.lastFetchAt ? now - new Date(h.lastFetchAt).getTime() : null,
        lastError: h.lastError || null,
        lastCount: h.lastCount != null ? h.lastCount : null
      };
    }));
    res.json({ status: 'success', data: out, count: out.length });
  } catch (error) { next(error); }
};

// ── latest / history (uniform over any feed) ─────────────────────
exports.getFeedLatest = async (req, res, next) => {
  const feed = feedOr404(req, res);
  if (!feed) return;
  try {
    const db = req.app.locals.db;
    const { collectionName, filter, tsField } = queryFor(feed);
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit) || 1));
    const data = await db.collection(collectionName).find(filter).sort({ [tsField]: -1 }).limit(limit).toArray();
    res.json({ status: 'success', feed: feed.id, data, count: data.length });
  } catch (error) { next(error); }
};

exports.getFeedHistory = async (req, res, next) => {
  const feed = feedOr404(req, res);
  if (!feed) return;
  try {
    const db = req.app.locals.db;
    const { collectionName, filter, tsField } = queryFor(feed);
    const q = { ...filter };
    const { from, to } = req.query;
    if (from || to) {
      q[tsField] = {};
      if (from) q[tsField].$gte = parseTs(from);
      if (to) q[tsField].$lte = parseTs(to);
    }
    const limit = Math.max(1, Math.min(5000, parseInt(req.query.limit) || 500));
    const order = req.query.order === 'desc' ? -1 : 1; // default chronological (asc) for charting
    const data = await db.collection(collectionName).find(q).sort({ [tsField]: order }).limit(limit).toArray();
    res.json({ status: 'success', feed: feed.id, data, count: data.length });
  } catch (error) { next(error); }
};

// ── SSE stream (reuses the shared bus; one event = one stored doc) ─
exports.streamFeed = (req, res) => {
  const feed = feedOr404(req, res);
  if (!feed) return;
  if (sseCount >= MAX_SSE_CONNECTIONS) {
    return res.status(503).json({ status: 'error', message: 'Too many SSE connections' });
  }
  sseCount++;
  sseConnections.add(res);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const onEvent = (evt) => {
    try {
      if (!evt || evt.feedId !== feed.id) return;
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch (e) { log(`[livedata] SSE write error: ${e.message}`, 'error'); }
  };
  appEmitter.on('liveData', onEvent);
  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { /* closed */ } }, 15000);

  req.on('close', () => {
    sseCount--;
    sseConnections.delete(res);
    appEmitter.removeListener('liveData', onEvent);
    clearInterval(heartbeat);
    res.end();
  });
};

// Close all live-data SSE connections — call during graceful shutdown.
exports.drainSSE = () => {
  for (const res of sseConnections) { try { res.end(); } catch { /* already closed */ } }
  sseConnections.clear();
  sseCount = 0;
};

// ── legacy aliases (kept byte-compatible for existing consumers) ──
exports.getISS = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const data = await db.collection('isses').find({}).sort({ timeStamp: -1 }).limit(100).toArray();
    res.json({ status: 'success', data, count: data.length });
  } catch (error) { next(error); }
};

exports.getQuakes = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const limit = Math.max(1, Math.min(5000, parseInt(req.query.limit) || 1000));
    const data = await db.collection('quakes').find({}).limit(limit).toArray();
    res.json({ status: 'success', data, count: data.length });
  } catch (error) { next(error); }
};

// /pressure + /weather → latest pressure readings (the weather feed).
// core/src/services/dataapiClient.js already calls both; previously 404.
exports.getPressure = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit) || 100));
    const data = await db.collection('pressures').find({}).sort({ timeStamp: -1 }).limit(limit).toArray();
    res.json({ status: 'success', data, count: data.length });
  } catch (error) { next(error); }
};
exports.getWeather = exports.getPressure;
