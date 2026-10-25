/**
 * On-demand tides from WorldTides (heights and high/low extremes).
 *
 * Every WorldTides call spends credits of the instance's account, so answers
 * are cached in memory for WORLDTIDES_CACHE_MS (6 h by default) per rounded
 * position (0.01°, about 1 km), number of days and UTC day; the request always
 * starts at 00:00 UTC of that day so every question of the day shares it.
 * Needs WORLDTIDES_API_KEY; without it the route says so (503) and calls nothing.
 */
const { fetchWithTimeoutAndRetry } = require('../../utils/fetch-utils');
const { createCache, SourceError } = require('./onDemandCache');

const WORLDTIDES_URL = 'https://www.worldtides.info/api/v3';
const DEFAULT_CACHE_MS = 6 * 3_600_000;
const MAX_DAYS = 7;

function cacheMs() {
  const n = Number(process.env.WORLDTIDES_CACHE_MS);
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_CACHE_MS;
}

let cache = null;
let cacheTtl = null;
function getCache() {
  const ttl = cacheMs();
  if (!cache || cacheTtl !== ttl) {
    cache = createCache({ ttlMs: ttl, failureBackoffMs: 5 * 60_000, maxEntries: 100 });
    cacheTtl = ttl;
  }
  return cache;
}

const round2 = (n) => Math.round(n * 100) / 100;
const iso = (seconds) => new Date(seconds * 1000).toISOString();

function normalize(body, { days, start }) {
  const extremes = (Array.isArray(body.extremes) ? body.extremes : [])
    .filter(e => Number.isFinite(e?.dt) && Number.isFinite(e?.height))
    .map(e => ({ time: iso(e.dt), type: String(e.type || '').toLowerCase(), heightM: e.height }));
  const heights = (Array.isArray(body.heights) ? body.heights : [])
    .filter(h => Number.isFinite(h?.dt) && Number.isFinite(h?.height))
    .map(h => ({ time: iso(h.dt), heightM: h.height }));
  return {
    source: 'worldtides',
    station: body.station || null,
    atlas: body.atlas || null,
    stationLat: Number.isFinite(body.responseLat) ? body.responseLat : null,
    stationLon: Number.isFinite(body.responseLon) ? body.responseLon : null,
    datum: body.responseDatum || null,
    from: iso(start),
    days,
    extremes,
    heights,
    copyright: body.copyright || null
  };
}

async function fetchTides({ lat, lon, days, start, key }) {
  // Same flag-style query SBQC's working tides route sends (`heights&extremes&…`).
  const params = new URLSearchParams({ lat: String(lat), lon: String(lon), days: String(days), start: String(start), key });
  let body;
  try {
    const res = await fetchWithTimeoutAndRetry(`${WORLDTIDES_URL}?heights&extremes&${params}`, { timeout: 15000, retries: 1, name: 'WorldTides' });
    body = await res.json();
  } catch (err) {
    // The error text never carries the request URL, so the key cannot leak through it.
    throw new SourceError(`WorldTides did not answer: ${String(err.message).split('\n')[0].slice(0, 160)}`);
  }
  if (body?.error) throw new SourceError(`WorldTides refused the request: ${String(body.error).slice(0, 160)}`);
  if (!Array.isArray(body?.extremes)) throw new SourceError('WorldTides returned no tide extremes');
  return normalize(body, { days, start });
}

async function getTides({ lat, lon, days = 2, now = Date.now() }) {
  const key = process.env.WORLDTIDES_API_KEY;
  if (!key) throw new SourceError('WORLDTIDES_API_KEY is not set on this instance', { status: 503, code: 'not_configured' });
  const d = Math.min(MAX_DAYS, Math.max(1, Math.trunc(days)));
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const start = Math.floor(dayStart.getTime() / 1000);
  const rLat = round2(lat);
  const rLon = round2(lon);
  const cacheKey = `${rLat},${rLon},${d},${start}`;
  const hit = await getCache().get(cacheKey, () => fetchTides({ lat: rLat, lon: rLon, days: d, start, key }));
  return { ...hit.value, fetchedAt: hit.fetchedAt.toISOString(), cached: hit.cached };
}

module.exports = { getTides, MAX_DAYS, _resetCache: () => { cache = null; } };
