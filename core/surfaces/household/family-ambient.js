'use strict';

// What Nestor's standby screen may react to, in one small read for the Family page:
// the current weather, the next naked-eye ISS pass and whether the operations
// watch currently reports something. Each part is read from its existing owner
// (Data, the ISS tool, the operations watch), cached briefly, and dropped to null
// on failure: an unknown value is never shown as a real one.
//
// The page never receives coordinates, alert text or host inventories: only the
// weather words, pass times and directions, the ecosystem node a finding names, and the
// opaque identifiers of the pictures Nestor may paint (family-paintings.js).

const { fetchData: defaultFetchData } = require('../../src/services/dataServiceClient');
const { issPasses: defaultIssPasses, readHomeObserver } = require('../../src/services/mcpIssTools');
const { getOpsWatch: defaultGetOpsWatch } = require('../../src/services/opsWatchService');
const { createFamilyPaintings } = require('./family-paintings');

const WEATHER_TTL_MS = 10 * 60 * 1000;
const ISS_TTL_MS = 20 * 60 * 1000;
const FAILURE_TTL_MS = 2 * 60 * 1000;
const READ_TIMEOUT_MS = 8000;

// Ecosystem view nodes (GraphysX ?app=ecosystem) a finding's host can point to.
// Order matters: the first match wins, so specific names come before short ones.
const NODE_HINTS = [
  ['ugfrank', ['ugfrank', 'frank', '192.168.2.99']],
  ['ugalien', ['ugalien', 'alien', '192.168.2.199']],
  ['ugbrutal', ['ugbrutal', 'brutal', '192.168.2.12']],
  ['devx', ['devx', '192.168.2.117']],
  ['ugstation', ['ugstation', '192.168.2.128']],
  ['ugsmall', ['ugsmall']],
  ['babypi', ['babypi']],
  ['piusb', ['piusb']],
  ['pitft', ['pitft']]
];

// Environment Canada icon codes, day 00–29 and night 30–48.
const EC_ICON_KIND = {
  0: 'clear', 1: 'clear', 2: 'cloud', 3: 'cloud', 4: 'cloud', 5: 'cloud', 6: 'rain', 7: 'snow', 8: 'snow',
  9: 'storm', 10: 'cloud', 11: 'rain', 12: 'rain', 13: 'rain', 14: 'rain', 15: 'snow', 16: 'snow', 17: 'snow',
  18: 'snow', 19: 'storm', 22: 'cloud', 23: 'fog', 24: 'fog', 25: 'snow', 26: 'snow', 27: 'rain', 28: 'rain',
  30: 'clear', 31: 'clear', 32: 'cloud', 33: 'cloud', 34: 'cloud', 35: 'cloud', 36: 'rain', 37: 'snow', 38: 'snow',
  39: 'storm', 40: 'snow', 41: 'storm', 42: 'storm', 43: 'cloud', 44: 'fog', 45: 'fog', 46: 'storm', 47: 'storm', 48: 'storm'
};

const CONDITION_KIND = [
  [/orage|thunder/i, 'storm'],
  [/neige|flocon|poudrerie|snow|flurr/i, 'snow'],
  [/pluie|bruine|averse|verglas|rain|drizzle|shower/i, 'rain'],
  [/brouillard|brume|fum[ée]e|fog|mist|haze|smoke/i, 'fog'],
  [/nuag|couvert|cloud|overcast/i, 'cloud'],
  [/d[ée]gag|soleil|ensoleill|clair|clear|sunny/i, 'clear']
];

function weatherKind(current) {
  const icon = Number.parseInt(current?.iconCode, 10);
  if (Number.isInteger(icon) && EC_ICON_KIND[icon]) return EC_ICON_KIND[icon];
  const text = String(current?.condition || '');
  return CONDITION_KIND.find(([pattern]) => pattern.test(text))?.[1] || null;
}

// Light or heavy, from the condition words; null when the words say nothing.
function weatherStrength(condition) {
  const text = String(condition || '');
  if (/faible|l[ée]g[èe]re|light|flurr|bruine|drizzle/i.test(text)) return 'light';
  if (/forte|abondante|heavy|violent/i.test(text)) return 'heavy';
  return null;
}

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// Sun elevation in degrees (NOAA low-precision formulas, about ±1°): enough to tell
// day, twilight and night for a background, never quoted as a measurement.
function solarElevationDeg(lat, lon, date = new Date()) {
  const rad = Math.PI / 180;
  const days = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const meanLon = (280.46 + 0.9856474 * days) % 360;
  const anomaly = (357.528 + 0.9856003 * days) % 360 * rad;
  const eclipticLon = (meanLon + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * rad;
  const obliquity = (23.439 - 0.0000004 * days) * rad;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLon));
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLon), Math.cos(eclipticLon));
  const gmst = (18.697374558 + 24.06570982441908 * days) % 24;
  const hourAngle = (gmst * 15 + lon) * rad - rightAscension;
  const elevation = Math.asin(Math.sin(lat * rad) * Math.sin(declination)
    + Math.cos(lat * rad) * Math.cos(declination) * Math.cos(hourAngle));
  return Math.round(elevation / rad * 10) / 10;
}

function nodeFor(key) {
  const text = String(key || '').toLowerCase();
  return NODE_HINTS.find(([, hints]) => hints.some(hint => text.includes(hint)))?.[0] || null;
}

// The report's shape for a wall screen: counts and the machines to visit, no text.
// Only what concerns the house counts: a critical finding, or one naming a machine.
// Routine operator findings (a failed queued job, a stale read) stay in Nerve Center.
function alertView(report) {
  if (!report) return null;
  const findings = (Array.isArray(report.findings) ? report.findings : [])
    .filter(finding => finding?.severity === 'critical' || nodeFor(finding?.key));
  const nodes = [...new Set(findings.map(finding => nodeFor(finding?.key)).filter(Boolean))].slice(0, 3);
  return {
    at: report.at || null,
    fingerprint: report.fingerprint || null,
    count: findings.length,
    critical: findings.filter(finding => finding?.severity === 'critical').length,
    nodes
  };
}

function passView(result) {
  const next = result?.nextVisible;
  if (!next) return { next: null, stale: Boolean(result?.tle?.stale), computedAt: result?.computedAt || null };
  const pass = (result.passes || []).find(row => row.visible && row.visible.start?.time === next.start);
  const visible = pass?.visible;
  const max = pass?.max && Date.parse(pass.max.time) >= Date.parse(next.start) && Date.parse(pass.max.time) <= Date.parse(next.end)
    ? pass.max : null;
  return {
    computedAt: result.computedAt,
    stale: Boolean(result.tle?.stale),
    next: {
      start: next.start, end: next.end, startLocal: next.startLocal, endLocal: next.endLocal,
      from: next.from, to: next.to, maxElDeg: next.maxElDeg, durationSec: next.durationSec,
      fromAzDeg: finite(visible?.start?.azDeg), toAzDeg: finite(visible?.end?.azDeg),
      fromElDeg: finite(visible?.start?.elDeg), toElDeg: finite(visible?.end?.elDeg),
      maxAzDeg: finite(max?.azDeg)
    }
  };
}

function createFamilyAmbient({ fetchData = defaultFetchData, issPasses = defaultIssPasses,
  getOpsWatch = defaultGetOpsWatch, observer = readHomeObserver, now = () => new Date(), logger = null, paintings = null } = {}) {
  const cache = new Map();

  async function cached(name, ttl, read) {
    const at = now().getTime();
    const hit = cache.get(name);
    if (hit && hit.until > at) return hit.value;
    if (hit?.pending) return hit.pending;
    const pending = (async () => {
      try {
        const value = await read();
        cache.set(name, { value, until: now().getTime() + ttl });
        return value;
      } catch (error) {
        logger?.debug?.(`Family ambient ${name} unavailable: ${error.message}`);
        cache.set(name, { value: null, until: now().getTime() + FAILURE_TTL_MS });
        return null;
      }
    })();
    cache.set(name, { ...(hit || {}), until: 0, pending });
    return pending;
  }

  async function readWeather() {
    const result = await fetchData('/api/v1/livedata/ec-weather', { query: 'lang=fr', timeoutMs: READ_TIMEOUT_MS });
    if (!result?.response?.ok || result.body?.status !== 'success') throw new Error(`Data answered ${result?.response?.status}`);
    const current = result.body.data?.current;
    if (!current) throw new Error('no current conditions');
    return {
      condition: typeof current.condition === 'string' ? current.condition.slice(0, 80) : null,
      kind: weatherKind(current),
      strength: weatherStrength(current.condition),
      temperatureC: finite(current.temperatureC),
      windKmh: finite(current.windKmh),
      gustKmh: finite(current.gustKmh),
      windDirection: typeof current.windDirection === 'string' ? current.windDirection.slice(0, 8) : null,
      fetchedAt: result.body.data.fetchedAt || null,
      source: 'Environnement Canada'
    };
  }

  async function readIss() {
    return passView(await issPasses({ hours: 30, visible_only: true, max_passes: 2 }, { fetchData, now }));
  }

  async function snapshot() {
    const [weather, sun, iss, pictures] = await Promise.all([
      cached('weather', WEATHER_TTL_MS, readWeather),
      // The sun moves; its position is recomputed from a cached observer.
      cached('observer', ISS_TTL_MS, () => observer(fetchData, null)).then(position => (position
        ? { elevationDeg: solarElevationDeg(position.lat, position.lon, now()) } : null)),
      cached('iss', ISS_TTL_MS, readIss),
      paintings ? paintings.list().catch(() => null) : null
    ]);
    let alerts = null;
    try { alerts = alertView(getOpsWatch().latest()); } catch { alerts = null; }
    return { at: now().toISOString(), weather, sun, iss, alerts, paintings: pictures || null };
  }

  return { snapshot, painting: id => (paintings ? paintings.image(id) : null) };
}

function registerFamilyAmbient(router, ambient = createFamilyAmbient({ paintings: createFamilyPaintings() })) {
  router.get('/ambient', async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, status: 'success', data: await ambient.snapshot() });
    } catch (error) {
      return res.status(500).json({ ok: false, status: 'error', code: 'FAMILY_AMBIENT_FAILED', message: error.message });
    }
  });
  // A reduced copy of a picture the snapshot listed; identifiers are opaque and immutable.
  router.get('/ambient/paintings/:id', async (req, res) => {
    try {
      const picture = /^[a-f0-9-]{36}$/.test(req.params.id) ? await ambient.painting?.(req.params.id) : null;
      if (!picture) return res.status(404).json({ ok: false, status: 'error', code: 'PAINTING_UNKNOWN' });
      return res.set({ 'Content-Type': picture.mimeType, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' })
        .send(picture.bytes);
    } catch {
      return res.status(503).json({ ok: false, status: 'error', code: 'PAINTING_UNAVAILABLE' });
    }
  });
  return ambient;
}

module.exports = { createFamilyAmbient, registerFamilyAmbient, solarElevationDeg, weatherKind, weatherStrength, alertView, passView, nodeFor };
