'use strict';

// ISS passes over an observer, computed from a TLE with SGP4 (satellite.js).
//
// A geometric pass is the time the station is above the horizon. It is
// observable to the naked eye only when, at the same moment, it is at least
// 10° high, lit by the Sun, and the observer's Sun is at -6° or lower.
// Weather, obstacles, light pollution and brightness are not modelled.

const satellite = require('satellite.js');

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const EARTH_RADIUS_KM = 6378.137;
const AU_KM = 149597870.7;

const DEFAULTS = Object.freeze({
  hours: 72,
  stepSec: 20,
  minObservableElevationDeg: 10,
  maxSunElevationDeg: -6,
  maxPasses: 24,
});

const DIRECTIONS_FR = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];

function directionFr(azDeg) {
  return DIRECTIONS_FR[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];
}

// Low-precision Sun position (Astronomical Almanac), about 0.01°.
function sunEciKm(date) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) * RAD;
  const g = (357.528 + 0.9856003 * n) * RAD;
  const lambda = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const r = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * AU_KM;
  return { x: r * Math.cos(lambda), y: r * Math.cos(eps) * Math.sin(lambda), z: r * Math.sin(eps) * Math.sin(lambda) };
}

// Cylindrical Earth shadow; penumbra ignored.
function isSunlit(satEci, sunEci) {
  const sl = Math.hypot(sunEci.x, sunEci.y, sunEci.z);
  const s = { x: sunEci.x / sl, y: sunEci.y / sl, z: sunEci.z / sl };
  const proj = satEci.x * s.x + satEci.y * s.y + satEci.z * s.z;
  if (proj > 0) return true;
  return Math.hypot(satEci.x - proj * s.x, satEci.y - proj * s.y, satEci.z - proj * s.z) > EARTH_RADIUS_KM;
}

function round1(x) { return Math.round(x * 10) / 10; }

function sample(satrec, obs, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position.x !== 'number') return null;
  const gmst = satellite.gstime(date);
  const look = satellite.ecfToLookAngles(obs, satellite.eciToEcf(pv.position, gmst));
  return { date, eci: pv.position, gmst, elDeg: look.elevation * DEG, azDeg: ((look.azimuth * DEG) % 360 + 360) % 360 };
}

function sunElevationDeg(obs, date, gmst) {
  return satellite.ecfToLookAngles(obs, satellite.eciToEcf(sunEciKm(date), gmst)).elevation * DEG;
}

function point(s) {
  return { time: s.date.toISOString(), azDeg: round1(s.azDeg), direction: directionFr(s.azDeg), elDeg: round1(s.elDeg) };
}

function refineCrossing(satrec, obs, below, above) {
  let lo = below;
  let hi = above;
  while (Math.abs(hi.date - lo.date) > 1000) {
    const mid = sample(satrec, obs, new Date((lo.date.getTime() + hi.date.getTime()) / 2));
    if (!mid) break;
    if (mid.elDeg >= 0) hi = mid; else lo = mid;
  }
  return hi;
}

function refineMaximum(satrec, obs, around, stepMs) {
  let a = around.date.getTime() - stepMs;
  let b = around.date.getTime() + stepMs;
  let best = around;
  for (let k = 0; k < 30 && b - a > 500; k++) {
    const s1 = sample(satrec, obs, new Date(a + (b - a) / 3));
    const s2 = sample(satrec, obs, new Date(b - (b - a) / 3));
    if (!s1 || !s2) break;
    if (s1.elDeg < s2.elDeg) a = s1.date.getTime(); else b = s2.date.getTime();
    const s = s1.elDeg > s2.elDeg ? s1 : s2;
    if (s.elDeg > best.elDeg) best = s;
  }
  return best;
}

function describeVisibility(satrec, obs, rise, set, opts) {
  let first = null;
  let last = null;
  let top = null;
  let sawHigh = false;
  let sawDarkHigh = false;
  let minSunElHigh = Infinity;
  for (let t = rise.date.getTime(); t <= set.date.getTime(); t += 10000) {
    const s = sample(satrec, obs, new Date(t));
    if (!s || s.elDeg < opts.minObservableElevationDeg) continue;
    sawHigh = true;
    const sunEl = sunElevationDeg(obs, s.date, s.gmst);
    minSunElHigh = Math.min(minSunElHigh, sunEl);
    if (sunEl > opts.maxSunElevationDeg) continue;
    sawDarkHigh = true;
    if (!isSunlit(s.eci, sunEciKm(s.date))) continue;
    if (!first) first = s;
    last = s;
    if (!top || s.elDeg > top.elDeg) top = s;
  }
  if (first) {
    return {
      observable: true,
      reason: null,
      visible: { start: point(first), end: point(last), maxElDeg: round1(top.elDeg), durationSec: Math.round((last.date - first.date) / 1000) },
    };
  }
  let reason;
  if (!sawHigh) reason = { code: 'too_low', text: `trop basse sur l'horizon (moins de ${opts.minObservableElevationDeg}°)` };
  else if (!sawDarkHigh) reason = { code: 'daylight', text: `ciel trop clair (Soleil à ${Math.round(minSunElHigh)}° au mieux)` };
  else reason = { code: 'earth_shadow', text: "ISS dans l'ombre de la Terre, donc non éclairée" };
  return { observable: false, reason, visible: null };
}

/**
 * @param {{line1: string, line2: string}} tle
 * @param {{lat: number, lon: number, heightKm?: number}} observer
 * @param {{start?: Date, hours?: number, maxPasses?: number}} [options]
 */
function computePasses(tle, observer, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const start = options.start instanceof Date ? options.start : new Date();
  const satrec = satellite.twoline2satrec(String(tle.line1).trim(), String(tle.line2).trim());
  if (!satrec || satrec.error) throw new Error('unreadable TLE');
  const obs = { latitude: observer.lat * RAD, longitude: observer.lon * RAD, height: observer.heightKm || 0 };
  const stepMs = opts.stepSec * 1000;
  const endMs = start.getTime() + opts.hours * 3600000;

  const passes = [];
  let prev = sample(satrec, obs, start);
  if (!prev) throw new Error('TLE propagation failed');
  let rise = prev.elDeg >= 0 ? prev : null;
  let inProgressAtStart = prev.elDeg >= 0;
  let top = rise;

  for (let t = start.getTime() + stepMs; t <= endMs && passes.length < opts.maxPasses; t += stepMs) {
    const cur = sample(satrec, obs, new Date(t));
    if (!cur) throw new Error('TLE propagation failed');
    if (!rise && prev.elDeg < 0 && cur.elDeg >= 0) {
      rise = refineCrossing(satrec, obs, prev, cur);
      top = cur;
    } else if (rise && cur.elDeg >= 0) {
      if (!top || cur.elDeg > top.elDeg) top = cur;
    } else if (rise && cur.elDeg < 0) {
      const set = refineCrossing(satrec, obs, cur, prev);
      const max = refineMaximum(satrec, obs, top || prev, stepMs);
      passes.push({
        rise: point(rise),
        max: point(max),
        set: point(set),
        durationSec: Math.round((set.date - rise.date) / 1000),
        inProgressAtStart,
        ...describeVisibility(satrec, obs, rise, set, opts),
      });
      rise = null;
      top = null;
      inProgressAtStart = false;
    }
    prev = cur;
  }
  return {
    window: { start: start.toISOString(), end: new Date(endMs).toISOString() },
    rules: {
      geometric: 'au-dessus de l’horizon (0°)',
      observable: `au moins ${opts.minObservableElevationDeg}° de hauteur, ISS éclairée, Soleil à ${opts.maxSunElevationDeg}° ou plus bas chez l’observateur`,
      notConsidered: ['nuages et météo', 'obstacles', 'pollution lumineuse', 'éclat (magnitude)'],
    },
    passes,
  };
}

function tleEpoch(line1) {
  const field = String(line1).substring(18, 32).trim();
  const yy = parseInt(field.substring(0, 2), 10);
  const day = parseFloat(field.substring(2));
  if (!Number.isFinite(yy) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1) + (day - 1) * 86400000);
}

module.exports = { computePasses, directionFr, isSunlit, sunEciKm, tleEpoch, DEFAULTS };
