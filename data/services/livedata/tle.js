/**
 * On-demand TLE for one satellite (default: the ISS, NORAD 25544).
 *
 * Order: the `satellites` live feed's stored element set when it was fetched
 * less than FEED_FRESH_MS ago; otherwise CelesTrak's GP query for that one
 * catalog number, cached for two hours (CelesTrak asks clients not to fetch
 * the same data more often). When CelesTrak fails, the last element set known
 * here (cache, then feed, any age) is returned and marked stale.
 */
const { fetchWithTimeoutAndRetry } = require('../../utils/fetch-utils');
const { createCache, SourceError } = require('./onDemandCache');
const { parseTleText, epochOf, isValidElementSet } = require('./tleText');

const CELESTRAK_GP_URL = 'https://celestrak.org/NORAD/elements/gp.php';
const CACHE_TTL_MS = 2 * 3_600_000;
const FEED_FRESH_MS = 12 * 3_600_000;
const STALE_EPOCH_MS = 72 * 3_600_000;
const DEFAULT_NORAD_ID = '25544';

const cache = createCache({ ttlMs: CACHE_TTL_MS, failureBackoffMs: 10 * 60_000, maxEntries: 50 });

function normalizeNoradId(value) {
  const id = String(value ?? DEFAULT_NORAD_ID).trim();
  return /^\d{1,9}$/.test(id) ? id.padStart(5, '0') : null;
}

async function fetchFromCelestrak(noradId) {
  const url = `${CELESTRAK_GP_URL}?CATNR=${encodeURIComponent(noradId)}&FORMAT=tle`;
  let text;
  try {
    const res = await fetchWithTimeoutAndRetry(url, { timeout: 15000, retries: 1, name: 'CelesTrak TLE' });
    text = await res.text();
  } catch (err) {
    throw new SourceError(`CelesTrak did not answer: ${String(err.message).split('\n')[0].slice(0, 160)}`);
  }
  const set = parseTleText(text).find(s => s.noradId.padStart(5, '0') === noradId);
  if (!isValidElementSet(set)) throw new SourceError(`CelesTrak returned no valid element set for ${noradId}`);
  return set;
}

async function readFeedPoint(db, noradId) {
  if (!db) return null;
  const unpadded = String(Number(noradId));
  const [point] = await db.collection('livedata_points')
    .find({ feedId: 'satellites', 'payload.noradId': { $in: [noradId, unpadded] } })
    .sort({ ts: -1 }).limit(1).toArray();
  return point && isValidElementSet(point.payload) ? point : null;
}

function describe(set, { source, fetchedAt, cached, stale = false, note = null, now }) {
  const epoch = epochOf(set.tle1);
  const epochAgeMs = now - epoch.getTime();
  return {
    noradId: set.tle1.slice(2, 7).trim(),
    name: set.name || null,
    line1: set.tle1,
    line2: set.tle2,
    epoch: epoch.toISOString(),
    epochAgeHours: Math.round(epochAgeMs / 360_000) / 10,
    source,
    fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
    cached: !!cached,
    stale: stale || epochAgeMs > STALE_EPOCH_MS,
    ...(note ? { note } : {})
  };
}

async function getTle({ db, noradId = DEFAULT_NORAD_ID, now = Date.now() } = {}) {
  const feedPoint = await readFeedPoint(db, noradId);
  if (feedPoint && now - new Date(feedPoint.ts).getTime() < FEED_FRESH_MS) {
    return describe(feedPoint.payload, { source: 'feed', fetchedAt: feedPoint.ts, cached: true, now });
  }
  try {
    const hit = await cache.get(noradId, () => fetchFromCelestrak(noradId));
    return describe(hit.value, { source: 'celestrak', fetchedAt: hit.fetchedAt, cached: hit.cached, now });
  } catch (err) {
    const last = cache.peek(noradId);
    if (last) return describe(last.value, { source: 'celestrak', fetchedAt: last.fetchedAt, cached: true, stale: true, note: err.message, now });
    if (feedPoint) return describe(feedPoint.payload, { source: 'feed', fetchedAt: feedPoint.ts, cached: true, stale: true, note: err.message, now });
    throw err;
  }
}

module.exports = { getTle, normalizeNoradId, DEFAULT_NORAD_ID, _cache: cache };
