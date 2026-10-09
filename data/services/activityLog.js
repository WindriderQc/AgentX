'use strict';

/**
 * Data's activity log: what the service did or noticed, one bounded document
 * per fact in `appevents` (30-day TTL), plus the last state it reported for
 * each watched thing in `activity_state`, so a restart never reports the same
 * transition twice.
 *
 * Recording never throws: the operation an event describes must not fail
 * because the log could not be written.
 */

const appEmitter = require('../utils/eventEmitter');
const { log } = require('../utils/logger');

const EVENTS = 'appevents';
const STATE = 'activity_state';
const SEVERITIES = Object.freeze(['info', 'warning', 'error']);
const MAX_MESSAGE_CHARS = 300;
const MAX_META_BYTES = 4096;
const MAX_META_DEPTH = 3;
const MAX_META_KEYS = 30;
const MAX_META_ITEMS = 25;
const MAX_META_STRING = 200;
const TYPE_PATTERN = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_]{0,31}){1,2}$/;
const TYPE_PREFIX_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;
// What a trusted caller may post: Data's own types are never accepted from outside.
const EXTERNAL_PREFIX = 'external.';
const DEFAULT_EXTERNAL_TYPE = 'external.note';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_PAGE = 500;

/** Every type Data emits itself, with when it is emitted. Documented in the README. */
const EVENT_TYPES = Object.freeze({
  'storage.scan_queued': 'A storage scan was queued for a native collector.',
  'storage.scan_started': 'A storage scan started (claimed by a collector, or started in the container).',
  'storage.scan_finished': 'A storage scan ended; meta.outcome is complete, partial, failed or stopped.',
  'storage.scan_expired': 'The reaper failed an external scan whose collector went silent or that nobody claimed.',
  'collector.first_seen': 'A storage, network or GPU collector registered for the first time.',
  'collector.silent': 'A collector that was reporting has not been heard for five minutes.',
  'collector.back': 'A collector reported again after a silence.',
  'gpu.host_stale': 'A GPU host that was sampled has had no successful sample for five minutes.',
  'gpu.host_recovered': 'A stale GPU host was sampled again.',
  'network.device_first_seen': 'A network sweep reported a device the inventory did not hold.',
  'janitor.run_finished': 'A janitor profile run ended; meta.status is complete or failed.',
  'livedata.feed_failing': 'A live feed started to fail.',
  'livedata.feed_recovered': 'A failing live feed fetched again.',
  'mqtt.monitor_disconnected': 'The MQTT monitor lost, or could not open, its broker connection.',
  'mqtt.monitor_connected': 'The MQTT monitor connected again after a disconnection.'
});

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function cutText(value, max) {
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sanitizeValue(value, depth) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return cutText(value, MAX_META_STRING);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  if (depth >= MAX_META_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_META_ITEMS).map(item => sanitizeValue(item, depth + 1)).filter(item => item !== undefined);
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_META_KEYS)) {
      // Keys MongoDB would interpret, or that are not plain names, are dropped.
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key)) continue;
      const clean = sanitizeValue(item, depth + 1);
      if (clean !== undefined) result[key] = clean;
    }
    return result;
  }
  return undefined;
}

/**
 * A small plain structure: bounded depth, keys, list lengths, string lengths
 * and total size. `strict` refuses a meta that is not a plain object or that is
 * still over the size bound once cut, instead of dropping it.
 */
function sanitizeMeta(meta, { strict = false } = {}) {
  if (meta === undefined || meta === null) return {};
  if (typeof meta !== 'object' || Array.isArray(meta) || Object.getPrototypeOf(meta) !== Object.prototype) {
    if (strict) throw validationError('meta must be a plain object');
    return {};
  }
  const clean = sanitizeValue(meta, 0) || {};
  if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > MAX_META_BYTES) {
    if (strict) throw validationError(`meta must serialize to at most ${MAX_META_BYTES} bytes`);
    return { truncated: true };
  }
  return clean;
}

function buildEvent({ type, severity = 'info', message, meta, at } = {}) {
  if (typeof type !== 'string' || !TYPE_PATTERN.test(type)) throw validationError('invalid event type');
  if (!SEVERITIES.includes(severity)) throw validationError(`severity must be one of: ${SEVERITIES.join(', ')}`);
  const text = typeof message === 'string' ? cutText(message, MAX_MESSAGE_CHARS) : '';
  if (!text) throw validationError('message is required');
  const when = at instanceof Date && Number.isFinite(at.getTime()) ? at : new Date();
  return { type, severity, message: text, meta: sanitizeMeta(meta), timestamp: when };
}

/** The shape every reader gets, whatever the stored document looks like. */
function publicEvent(doc) {
  // Documents written before the typed log used `type` for the severity.
  const legacy = !doc.severity;
  const severity = legacy
    ? ({ error: 'error', warn: 'warning', warning: 'warning' })[doc.type] || 'info'
    : doc.severity;
  return {
    id: doc._id ? String(doc._id) : null,
    type: legacy ? DEFAULT_EXTERNAL_TYPE : doc.type,
    severity,
    message: doc.message,
    meta: doc.meta || {},
    at: doc.timestamp instanceof Date ? doc.timestamp.toISOString() : doc.timestamp
  };
}

/** Store one event and push it to the SSE subscribers. Returns the event, or null when it failed. */
async function record(db, event) {
  try {
    const doc = buildEvent(event);
    const result = await db.collection(EVENTS).insertOne(doc);
    const stored = publicEvent({ ...doc, _id: result?.insertedId });
    appEmitter.emit('newEvent', stored);
    return stored;
  } catch (error) {
    log(`[activity] Could not record ${event?.type || 'event'}: ${error.message}`, 'warn');
    return null;
  }
}

/**
 * An event posted by a trusted caller (Core, a collector): only `external.*`
 * types, with every field validated instead of cut. Throws statusCode 400.
 */
function externalEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('a JSON object is required');
  const unknown = Object.keys(body).filter(key => !['message', 'type', 'severity', 'meta'].includes(key));
  if (unknown.length) throw validationError(`unknown field: ${cutText(unknown[0], 40)}`);
  const { message, meta } = body;
  if (typeof message !== 'string' || !message.trim()) throw validationError('message is required');
  if (message.length > MAX_MESSAGE_CHARS) throw validationError(`message must be at most ${MAX_MESSAGE_CHARS} characters`);
  let { type, severity } = body;
  // The former API carried the severity in `type` (info, warn, error).
  if (severity === undefined && ['info', 'warn', 'warning', 'error'].includes(type)) {
    severity = type === 'warn' ? 'warning' : type;
    type = undefined;
  }
  if (type === undefined) type = DEFAULT_EXTERNAL_TYPE;
  if (typeof type !== 'string' || !TYPE_PATTERN.test(type) || !type.startsWith(EXTERNAL_PREFIX)) {
    throw validationError(`type must look like ${EXTERNAL_PREFIX}<name>`);
  }
  if (severity === undefined) severity = 'info';
  if (!SEVERITIES.includes(severity)) throw validationError(`severity must be one of: ${SEVERITIES.join(', ')}`);
  return { type, severity, message, meta: sanitizeMeta(meta, { strict: true }) };
}

function parseDate(value, name) {
  if (value === undefined || value === '') return null;
  const raw = Array.isArray(value) ? NaN : value;
  const date = /^\d{10,15}$/.test(String(raw)) ? new Date(Number(raw)) : new Date(String(raw));
  if (!Number.isFinite(date.getTime())) throw validationError(`${name} must be a date`);
  return date;
}

function boundedInt(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, parsed);
}

/** The MongoDB filter and paging of a read. Throws statusCode 400 on an invalid filter. */
function parseQuery(query = {}) {
  const filter = {};
  const applied = {};
  if (query.type !== undefined && query.type !== '') {
    if (typeof query.type !== 'string' || !TYPE_PREFIX_PATTERN.test(query.type)) {
      throw validationError('type must be an event type or the beginning of one, such as storage or storage.scan_');
    }
    // An anchored prefix uses the { type, timestamp } index.
    filter.type = { $regex: `^${query.type.replace(/\./g, '\\.')}` };
    applied.type = query.type;
  }
  if (query.severity !== undefined && query.severity !== '') {
    if (!SEVERITIES.includes(query.severity)) throw validationError(`severity must be one of: ${SEVERITIES.join(', ')}`);
    filter.severity = query.severity;
    applied.severity = query.severity;
  }
  const since = parseDate(query.since, 'since');
  const until = parseDate(query.until, 'until');
  if (since && until && since > until) throw validationError('since must not be after until');
  if (since || until) {
    filter.timestamp = { ...(since ? { $gte: since } : {}), ...(until ? { $lte: until } : {}) };
    applied.since = since ? since.toISOString() : null;
    applied.until = until ? until.toISOString() : null;
  }
  const limit = boundedInt(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const page = boundedInt(query.page, 1, MAX_PAGE);
  return { filter, applied, limit, page, skip: (page - 1) * limit };
}

async function list(db, query = {}) {
  const { filter, applied, limit, page, skip } = parseQuery(query);
  const collection = db.collection(EVENTS);
  const [total, docs] = await Promise.all([
    collection.countDocuments(filter),
    collection.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).toArray()
  ]);
  return {
    events: docs.map(publicEvent),
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    filters: applied
  };
}

/** Whether a stored or streamed event passes a type-prefix and severity filter. */
function matches(event, { type, severity } = {}) {
  if (type && !String(event.type || '').startsWith(type)) return false;
  if (severity && event.severity !== severity) return false;
  return true;
}

/**
 * Set the last reported state of a watched thing and return the previous one
 * (null when it had none). Atomic: of two callers setting the same new state,
 * only one sees the old state.
 */
async function setState(db, key, state, now = new Date()) {
  const before = await db.collection(STATE).findOneAndUpdate(
    { _id: key },
    [{ $set: { since: { $cond: [{ $eq: ['$state', state] }, '$since', now] }, state } }],
    { upsert: true, returnDocument: 'before' }
  );
  const doc = before && Object.prototype.hasOwnProperty.call(before, 'value') && !('state' in before) ? before.value : before;
  return doc ? doc.state ?? null : null;
}

/**
 * Move a watched thing from one state to another, only if it is in the first.
 * True when this call made the move: a thing without a recorded state stays
 * without one.
 */
async function moveState(db, key, from, to, now = new Date()) {
  const result = await db.collection(STATE).updateOne({ _id: key, state: from }, { $set: { state: to, since: now } });
  return (result?.modifiedCount || 0) === 1;
}

module.exports = {
  EVENTS,
  STATE,
  SEVERITIES,
  EVENT_TYPES,
  MAX_MESSAGE_CHARS,
  MAX_META_BYTES,
  MAX_PAGE_SIZE,
  MAX_PAGE,
  EXTERNAL_PREFIX,
  buildEvent,
  publicEvent,
  sanitizeMeta,
  externalEvent,
  parseQuery,
  record,
  list,
  matches,
  setState,
  moveState
};
