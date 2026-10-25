'use strict';

// Read-only ISS pass tool for the Core MCP bus.
//
// Data owns orbital-source reads and caching. Core computes passes locally
// and never returns observer coordinates. Every answer is dated so an agent
// can quote times without inventing them.

const { fetchData: defaultFetchData } = require('./dataServiceClient');
const { computePasses, tleEpoch } = require('./iss/issPasses');
const { familyTimeZone } = require('../domains/household/family');
const { parsePosition, resolvePosition, locationMetadata } = require('../../../shared/observerLocation');

const ISS_NORAD_ID = '25544';
const TLE_STALE_EPOCH_MS = 3 * 24 * 3600 * 1000;
const TLE_STALE_RETRIEVAL_MS = 18 * 3600 * 1000; // Data refreshes every 6 h
const DATA_TIMEOUT_MS = 8000;
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

const ISS_TOOLS = [
  {
    name: 'iss_passes',
    title: 'ISS Passes',
    description: 'Next International Space Station passes from Data orbital elements. Location: explicit lat/lon, otherwise the household weather location, otherwise the configured default. Disclose the returned observer label, especially a default location. Each pass says whether it is observable to the naked eye (at least 10° high, station sunlit, dark enough sky) or only geometric (above the horizon), with local times, directions and height. Weather is not known: say "si le ciel est dégagé". Quote the returned times and search window exactly; never estimate a pass time yourself or call it the best of the week when the window is shorter.',
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'integer', minimum: 1, maximum: 108, default: 72, description: 'Search window from now, in hours.' },
        visible_only: { type: 'boolean', default: false, description: 'Return only passes observable to the naked eye.' },
        max_passes: { type: 'integer', minimum: 1, maximum: 12, default: 8 },
        lat: { type: 'number', minimum: -90, maximum: 90, description: 'Optional observer latitude; provide lon too.' },
        lon: { type: 'number', minimum: -180, maximum: 180, description: 'Optional observer longitude; provide lat too.' },
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
  const unknown = Object.keys(args).filter(k => !['hours', 'visible_only', 'max_passes', 'lat', 'lon'].includes(k));
  if (unknown.length) throw invalid(`unknown argument: ${unknown[0].slice(0, 40)}`);
  const int = (value, min, max, fallback, name) => {
    if (value === undefined) return fallback;
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${name} must be an integer from ${min} to ${max}`);
    return n;
  };
  if (args.visible_only !== undefined && typeof args.visible_only !== 'boolean') throw invalid('visible_only must be a boolean');
  let position;
  try { position = parsePosition(args); }
  catch (error) { throw invalid(error.message); }
  return {
    hours: int(args.hours, 1, 108, 72, 'hours'),
    visibleOnly: args.visible_only === true,
    maxPasses: int(args.max_passes, 1, 12, 8, 'max_passes'),
    ...(position ? { position } : {}),
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

async function readStoredIssTle(fetchData) {
  const rows = await readData(fetchData, '/api/v1/livedata/satellites/latest', 'limit=200');
  const iss = rows
    .filter(r => r && r.payload && r.payload.noradId === ISS_NORAD_ID && typeof r.payload.tle1 === 'string' && typeof r.payload.tle2 === 'string')
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
  if (!iss) throw unavailable('Data holds no ISS orbital elements (satellites feed)');
  const epoch = tleEpoch(iss.payload.tle1);
  if (!epoch) throw unavailable('ISS orbital elements are unreadable');
  return { line1: iss.payload.tle1, line2: iss.payload.tle2, epoch, retrievedAt: new Date(iss.ts) };
}

async function readIssTle(fetchData) {
  let result;
  try {
    result = await fetchData('/api/v1/livedata/tle', { query: 'norad=25544', timeoutMs: 40000 });
  } catch (error) {
    throw unavailable(`Data did not answer the ISS orbital-element request (${error.name === 'TimeoutError' ? 'timeout' : 'unreachable'})`);
  }
  // Rolling upgrades: old Data installations still expose the stored feed.
  if (result.response.status === 404) return readStoredIssTle(fetchData);
  const data = result.body?.data;
  if (!result.response.ok || result.body?.status !== 'success' || !data
      || typeof data.line1 !== 'string' || typeof data.line2 !== 'string') {
    throw unavailable('Data could not supply ISS orbital elements');
  }
  const epoch = tleEpoch(data.line1);
  const retrievedAt = new Date(data.fetchedAt);
  if (!epoch || !data.fetchedAt || !Number.isFinite(retrievedAt.getTime())) throw unavailable('ISS orbital elements are unreadable');
  return { line1: data.line1, line2: data.line2, epoch, retrievedAt, stale: data.stale === true };
}

async function readHomeObserver(fetchData, explicit, env = process.env) {
  let known = null;
  let readError;
  if (!explicit) {
    try { known = (await readData(fetchData, '/api/v1/livedata/weather/latest', 'limit=1'))[0]; }
    catch (error) { readError = error; }
  }
  let position;
  try { position = resolvePosition({ explicit, known, defaultLocationJson: env.OBSERVER_DEFAULT_LOCATION_JSON }); }
  catch (_) { throw unavailable('The configured default observer location is invalid'); }
  if (!position) throw readError || unavailable('Data holds no household weather location: supply lat and lon or configure a default');
  return { ...position, lat: Math.round(position.lat * 100) / 100, lon: Math.round(position.lon * 100) / 100 };
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
  const [tle, observer] = await Promise.all([readIssTle(fetchData), readHomeObserver(fetchData, input.position, deps.env)]);

  const epochAgeMs = now - tle.epoch;
  const retrievalAgeMs = now - tle.retrievedAt;
  const staleReason = epochAgeMs > TLE_STALE_EPOCH_MS
    ? 'éléments orbitaux de plus de 3 jours : heures moins sûres'
    : retrievalAgeMs > TLE_STALE_RETRIEVAL_MS ? 'Data n’a pas renouvelé les éléments orbitaux depuis plus de 18 h'
      : tle.stale ? 'Data sert des éléments orbitaux de secours : heures moins sûres' : null;

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
    observer: { ...locationMetadata(observer), precision: 'environ 1 km' },
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
    answerRules: 'Donne les heures locales telles quelles avec leur jour et la fenêtre calculée. Indique le lieu utilisé; si observer.defaulted est vrai, annonce explicitement que ce lieu par défaut ne prouve pas la position de la personne. Distingue « visible à l’œil nu si le ciel est dégagé » et « passe au-dessus de l’horizon mais pas visible ». Mentionne la date des éléments orbitaux si stale est vrai. La vue 3D liée règle son lieu séparément : ses passages ne sont pas synchronisés avec ce calcul.',
  };
}

const ISS_TOOL_HANDLERS = { iss_passes: issPasses };

module.exports = { ISS_TOOLS, ISS_TOOL_HANDLERS, issPasses, parseArgs };
