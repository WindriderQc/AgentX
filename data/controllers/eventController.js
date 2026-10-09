const appEmitter = require('../utils/eventEmitter');
const { log } = require('../utils/logger');
const activityLog = require('../services/activityLog');

const MAX_SSE_CONNECTIONS = 50;
let sseConnectionCount = 0;
const sseConnections = new Set();

// --- REST endpoints ---

function badRequest(res, error) {
  return res.status(400).json({ status: 'error', message: error.message });
}

/**
 * GET / — newest first. Filters: `type` (a type or the beginning of one),
 * `severity`, `since`, `until`; paging: `page`, `limit` (at most 200).
 */
exports.getEvents = async (req, res, next) => {
  try {
    res.json({ status: 'success', data: await activityLog.list(req.app.locals.db, req.query) });
  } catch (error) {
    if (error.statusCode === 400) return badRequest(res, error);
    next(error);
  }
};

/** POST / — a trusted caller records an `external.*` event; every field is validated. */
exports.createEvent = async (req, res, next) => {
  try {
    let event;
    try { event = activityLog.externalEvent(req.body); }
    catch (error) { return badRequest(res, error); }
    const stored = await activityLog.record(req.app.locals.db, event);
    if (!stored) return res.status(500).json({ status: 'error', message: 'Event could not be stored' });
    res.status(201).json({ status: 'success', message: 'Event logged', data: stored });
  } catch (error) { next(error); }
};

/**
 * SSE stream — pushes real-time events to connected clients.
 */
exports.streamEvents = (req, res) => {
  if (sseConnectionCount >= MAX_SSE_CONNECTIONS) {
    return res.status(503).json({ status: 'error', message: 'Too many SSE connections' });
  }
  let filter;
  try { filter = activityLog.parseQuery({ type: req.query.type, severity: req.query.severity }).applied; }
  catch (error) { return res.status(400).json({ status: 'error', message: error.message }); }
  sseConnectionCount++;
  sseConnections.add(res);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (data) => {
    try {
      if (!activityLog.matches(data, filter)) return;
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      log(`[events] SSE write error: ${e.message}`, 'error');
    }
  };

  appEmitter.on('newEvent', sendEvent);

  const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, 15000);

  req.on('close', () => {
    sseConnectionCount--;
    sseConnections.delete(res);
    appEmitter.removeListener('newEvent', sendEvent);
    clearInterval(heartbeat);
    res.end();
  });
};

/**
 * Close all active SSE connections — call during graceful shutdown.
 */
exports.drainSSE = () => {
  for (const res of sseConnections) {
    try { res.end(); } catch { /* already closed */ }
  }
  sseConnections.clear();
  sseConnectionCount = 0;
};
