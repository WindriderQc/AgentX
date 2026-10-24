'use strict';

// Read-only ISS pass tool for the Core MCP bus.
//
// The orbital elements and the household location are the ones Data already
// holds (CelesTrak "stations" feed, weather location rounded to 0.01°): the
// tool makes no outbound call and never returns the coordinates. Every answer
// is dated so an agent can quote times without inventing them.

const { fetchData: defaultFetchData } = require('./dataServiceClient');
const { computePasses, tleEpoch } = require('./iss/issPasses');
const { familyTimeZone } = require('../domains/household/family');

const ISS_NORAD_ID = '25544';
const TLE_STALE_EPOCH_MS = 3 * 24 * 3600 * 1000;
const TLE_STALE_RETRIEVAL_MS = 18 * 3600 * 1000; // Data refreshes every 6 h
const DATA_TIMEOUT_MS = 8000;
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

const ISS_TOOLS = [
  {
    name: 'iss_passes',
    title: 'ISS Passes Over the Home',
    description: 'Next International Space Station passes over the household, computed from the orbital elements Data holds. Each pass says whether it is observable to the naked eye (at least 10° high, station sunlit, dark enough sky) or only geometric (above the horizon), with local times, directions and height. Weather is not known: say "si le ciel est dégagé". Quote the returned times exactly; never estimate a pass time yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'integer', minimum: 1, maximum: 108, default: 72, description: 'Search window from now, in hours.' },
        visible_only: { type: 'boolean', default: false, description: 'Return only passes observable to the naked eye.' },
        max_passes: { type: 'integer', minimum: 1, maximum: 12, default: 8 },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENTS', status: 400 });
}

function unavailable(message) {
  return Object.assign(new Error(message), { code: 'ISS_DATA_UNAVAILABLE', status: 503 });
}

function parseArgs(args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw invalid('arguments must be an object');
  const unknown = Object.keys(args).filter(k => !['hours', 'visible_only', 'max_passes'].includes(k));
  if (unknown.length) throw invalid(`unknown argument: ${unknown[0].slice(0, 40)}`);
  const int = (value, min, max, fallback, name) => {
    if (value === undefined) return fallback;
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${name} must be an integer from ${min} to ${max}`);
    return n;
  };
  if (args.visible_only !== undefined && typeof args.visible_only !== 'boolean') throw invalid('visible_only must be a boolean');
  return {
    hours: int(args.hours, 1, 108, 72, 'hours'),
    visibleOnly: args.visible_only === true,
    maxPasses: int(args.max_passes, 1, 12, 8, 'max_passes'),
  };
}

async function readData(fetchData, path, query) {
  let result;
  try {
    result = await fetchData(path, { query, timeoutMs: DATA_TIMEOUT_MS });
  } catch (error) {
    throw unavailable(`Data did not answer (${error.name === 'TimeoutError' ? 'timeout' : 'unreachable'})`);
  }
  if (!result.response.ok || result.body.status !== 'success' || !Array.isArray(result.body.data)) {
    throw unavailable(`Data refused ${path} (HTTP ${result.response.status})`);
  }
  return result.body.data;
}

async function readIssTle(fetchData) {
  const rows = await readData(fetchData, '/api/v1/livedata/satellites/latest', 'limit=200');
  const iss = rows
    .filter(r => r && r.payload && r.payload.noradId === ISS_NORAD_ID && typeof r.payload.tle1 === 'string' && typeof r.payload.tle2 === 'string')
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
  if (!iss) throw unavailable('Data holds no ISS orbital elements (satellites feed)');
  const epoch = tleEpoch(iss.payload.tle1);
  if (!epoch) throw unavailable('ISS orbital elements are unreadable');
  return { line1: iss.payload.tle1, line2: iss.payload.tle2, epoch, retrievedAt: new Date(iss.ts) };
}

async function readHomeObserver(fetchData) {
  const rows = await readData(fetchData, '/api/v1/livedata/weather/latest', 'limit=1');
  const row = rows[0];
  const lat = Number(row && row.lat);
  const lon = Number(row && row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw unavailable('Data holds no household weather location');
  }
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

function localFormatter(timeZone) {
  const fmt = new Intl.DateTimeFormat('fr-CA', {
    timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  return (iso) => fmt.format(new Date(iso));
}

function viewUrl(env = process.env) {
  const raw = String(env.ISS_VIEW_URL || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch (_error) {
    return null;
  }
}

async function issPasses(args, deps = {}) {
  const input = parseArgs(args);
  const fetchData = deps.fetchData || defaultFetchData;
  const now = deps.now ? deps.now() : new Date();
  const [tle, observer] = await Promise.all([readIssTle(fetchData), readHomeObserver(fetchData)]);

  const epochAgeMs = now - tle.epoch;
  const retrievalAgeMs = now - tle.retrievedAt;
  const staleReason = epochAgeMs > TLE_STALE_EPOCH_MS
    ? 'éléments orbitaux de plus de 3 jours : heures moins sûres'
    : retrievalAgeMs > TLE_STALE_RETRIEVAL_MS ? 'Data n’a pas renouvelé les éléments orbitaux depuis plus de 18 h' : null;

  const result = computePasses(tle, observer, { start: now, hours: input.hours });
  const timeZone = familyTimeZone();
  const local = localFormatter(timeZone);
  const all = result.passes;
  const selected = (input.visibleOnly ? all.filter(p => p.observable) : all).slice(0, input.maxPasses);
  const next = all.find(p => p.observable) || null;

  return {
    status: 'ok',
    computedAt: now.toISOString(),
    computedAtLocal: local(now.toISOString()),
    timeZone,
    observer: { label: 'lieu météo de la maison (Data)', precision: 'environ 1 km' },
    tle: {
      source: 'CelesTrak via Data',
      epoch: tle.epoch.toISOString(),
      epochLocal: local(tle.epoch.toISOString()),
      epochAgeHours: Math.round(epochAgeMs / 36e5 * 10) / 10,
      retrievedAt: tle.retrievedAt.toISOString(),
      stale: Boolean(staleReason),
      staleReason,
    },
    window: result.window,
    rules: result.rules,
    counts: { geometric: all.length, observable: all.filter(p => p.observable).length },
    nextVisible: next && {
      start: next.visible.start.time,
      end: next.visible.end.time,
      startLocal: local(next.visible.start.time),
      endLocal: local(next.visible.end.time),
      from: next.visible.start.direction,
      to: next.visible.end.direction,
      maxElDeg: next.visible.maxElDeg,
      durationSec: next.visible.durationSec,
    },
    passes: selected.map(p => ({
      riseLocal: local(p.rise.time),
      setLocal: local(p.set.time),
      rise: p.rise,
      max: p.max,
      set: p.set,
      durationSec: p.durationSec,
      inProgressAtStart: p.inProgressAtStart,
      observable: p.observable,
      visible: p.visible && { ...p.visible, startLocal: local(p.visible.start.time), endLocal: local(p.visible.end.time) },
      notObservableBecause: p.reason ? p.reason.text : null,
    })),
    view: viewUrl(deps.env) ? { url: viewUrl(deps.env), label: 'Vue 3D de l’ISS et des passages' } : null,
    answerRules: 'Donne les heures locales telles quelles avec leur jour. Distingue « visible à l’œil nu si le ciel est dégagé » et « passe au-dessus de l’horizon mais pas visible ». Mentionne la date des éléments orbitaux si stale est vrai.',
  };
}

const ISS_TOOL_HANDLERS = { iss_passes: issPasses };

module.exports = { ISS_TOOLS, ISS_TOOL_HANDLERS, issPasses, parseArgs };
