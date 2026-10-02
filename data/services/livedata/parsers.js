/**
 * Live Data parsers — raw input → array of docs to store.
 *
 * Each feed's `parser` field names one of these functions. HTTP parsers receive
 * the already-fetched `res` (so timeout/retry stays uniform in the engine); the
 * MQTT parser receives `{ topic, payloadStr }`. Both also get a `ctx` of
 * { feed, location?, topic? }.
 */

const asNumber = (v) => { const n = Number(v); return Number.isFinite(n) ? n : v; };

// ── seeded feeds ─────────────────────────────────────────────────

// ISS — tolerate wheretheiss.at (top-level numeric) and open-notify (nested) shapes.
async function iss(res) {
  const data = await res.json();
  if (data.message && data.message !== 'success') return []; // legacy open-notify error guard
  const lat = Number(data.latitude ?? data.iss_position?.latitude ?? data.iss_position?.lat);
  const lon = Number(data.longitude ?? data.iss_position?.longitude ?? data.iss_position?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const ts = data.timestamp
    ? (Number(data.timestamp) > 1e12 ? new Date(Number(data.timestamp)) : new Date(Number(data.timestamp) * 1000))
    : new Date();
  return [{ latitude: lat, longitude: lon, timeStamp: ts }];
}

// Earthquakes — USGS CSV → full array (stored via the atomic replace swap).
async function quakesCsv(res) {
  const csv = await res.text();
  const CSVToJSON = require('csvtojson'); // lazy — only loaded when this feed runs
  return CSVToJSON().fromString(csv);
}

// OpenWeather — one location's response → one pressure doc.
async function openWeather(res, ctx = {}) {
  const data = await res.json();
  const loc = ctx.location || {};
  return [{ pressure: data.main.pressure, timeStamp: new Date(), lat: loc.lat, lon: loc.lon }];
}

// ── new feeds ────────────────────────────────────────────────────

// CelesTrak GP in TLE format → one livedata_point per satellite
// { name, noradId, tle1, tle2 }. Sub-satellite lat/lon is propagated in-browser
// (satellite.js) in the UI — server stores the raw elements.
async function celestrakTle(res) {
  const text = await res.text();
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    const name = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1 || !l2 || !l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
    const noradId = l1.slice(2, 7).trim();
    out.push({ ts: new Date(), payload: { name: (name || '').trim(), noradId, tle1: l1, tle2: l2 } });
  }
  return out;
}

// Open-Meteo air quality (keyless) — one location's `current` block → one point.
async function openMeteoAqi(res, ctx = {}) {
  const data = await res.json();
  const cur = data.current || {};
  const loc = ctx.location || {};
  const lat = loc.lat != null ? loc.lat : data.latitude;
  const lon = loc.lon != null ? loc.lon : data.longitude;
  return [{
    ts: cur.time ? new Date(cur.time) : new Date(),
    lat, lon,
    payload: { pm2_5: cur.pm2_5, pm10: cur.pm10, us_aqi: cur.us_aqi, european_aqi: cur.european_aqi }
  }];
}

// MQTT sensor push-in — one broker message → one point. JSON payloads are spread
// into the payload; scalar payloads become { value }. lat/lon lift to geo.
async function mqttSensor(input = {}) {
  const { topic, payloadStr } = input;
  let parsed;
  try { parsed = JSON.parse(payloadStr); } catch { parsed = payloadStr; }
  const payload = (parsed && typeof parsed === 'object')
    ? { topic, ...parsed }
    : { topic, value: asNumber(parsed) };
  const doc = { ts: new Date(), payload };
  if (Number.isFinite(payload.lat) && Number.isFinite(payload.lon)) { doc.lat = payload.lat; doc.lon = payload.lon; }
  return [doc];
}

module.exports = { iss, quakesCsv, openWeather, celestrakTle, openMeteoAqi, mqttSensor };
