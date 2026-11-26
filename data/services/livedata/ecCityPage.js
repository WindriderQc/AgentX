/**
 * On-demand Environment Canada city weather (MSC GeoMet `citypageweather-realtime`).
 *
 * Picks the city page nearest to a position (searching ±0.75°, then ±2.5°),
 * and returns its current conditions, period forecasts, hourly forecast,
 * warnings and sunrise/sunset in one language (fr or en). Keyless public data;
 * pages are cached 10 minutes per rounded position (0.01°) and language.
 */
const { fetchWithTimeoutAndRetry } = require('../../utils/fetch-utils');
const { createCache, SourceError } = require('./onDemandCache');
const { readPosition } = require('./observerPosition');
const { log } = require('../../utils/logger');

const CITYPAGE_URL = 'https://api.weather.gc.ca/collections/citypageweather-realtime/items';
const SEARCH_RADII_DEG = [0.75, 2.5];
const TTL_MS = 10 * 60_000;
const REFRESH_MS = 9 * 60_000;
const RETRY_MS = 60_000;
const cache = createCache({ ttlMs: TTL_MS, failureBackoffMs: RETRY_MS, maxEntries: 100 });

const round2 = (n) => Math.round(n * 100) / 100;

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Every GeoMet text or number is { en, fr }; take the asked language, else the other.
function pick(field, lang) {
  if (field === null || field === undefined) return null;
  if (typeof field !== 'object') return field;
  const v = field[lang] ?? field.en ?? field.fr;
  return v === undefined ? null : v;
}

const num = (field, lang) => {
  const raw = pick(field, lang);
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && !raw.trim()) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
};

function current(cc, lang) {
  if (!cc) return null;
  return {
    observedAt: pick(cc.timestamp, lang),
    station: pick(cc.station?.value, lang),
    condition: pick(cc.condition, lang),
    iconCode: cc.iconCode?.value ?? null,
    temperatureC: num(cc.temperature?.value, lang),
    dewpointC: num(cc.dewpoint?.value, lang),
    windChill: num(cc.windChill?.value, lang),
    humidex: num(cc.humidex?.value, lang),
    humidityPct: num(cc.relativeHumidity?.value, lang),
    pressureKPa: num(cc.pressure?.value, lang),
    pressureTendency: pick(cc.pressure?.tendency, lang),
    windKmh: num(cc.wind?.speed?.value, lang),
    gustKmh: num(cc.wind?.gust?.value, lang),
    windDirection: pick(cc.wind?.direction?.value, lang)
  };
}

function forecast(f, lang) {
  const temps = Array.isArray(f?.temperatures?.temperature) ? f.temperatures.temperature : [];
  return {
    period: pick(f?.period?.textForecastName, lang),
    summary: pick(f?.textSummary, lang),
    short: pick(f?.abbreviatedForecast?.textSummary, lang),
    iconCode: f?.abbreviatedForecast?.icon?.value ?? null,
    temperatures: temps.map(t => ({ class: pick(t.class, lang), valueC: num(t.value, lang) })),
    precipitationChancePct: num(f?.abbreviatedForecast?.pop?.value, lang)
  };
}

function hourly(h, lang) {
  return {
    time: typeof h?.timestamp === 'string' ? h.timestamp : pick(h?.timestamp, lang),
    condition: pick(h?.condition, lang),
    iconCode: h?.iconCode?.value ?? null,
    temperatureC: num(h?.temperature?.value, lang),
    precipitationChancePct: num(h?.lop?.value, lang),
    windKmh: num(h?.wind?.speed?.value, lang),
    windDirection: pick(h?.wind?.direction?.value, lang)
  };
}

function warning(w, lang) {
  return {
    description: pick(w?.description, lang),
    type: pick(w?.type, lang),
    colour: pick(w?.alertColourLevel, lang),
    issuedAt: pick(w?.eventIssue, lang),
    expiresAt: pick(w?.expiryTime, lang),
    url: pick(w?.url, lang)
  };
}

function normalize(feature, { lat, lon, lang }) {
  const p = feature.properties || {};
  const [fLon, fLat] = feature.geometry?.coordinates || [];
  const fg = p.forecastGroup || {};
  return {
    source: 'environment-canada',
    lang,
    identifier: p.identifier || null,
    name: pick(p.name, lang),
    region: pick(p.region, lang),
    url: pick(p.url, lang),
    distanceKm: Number.isFinite(fLat) ? Math.round(distanceKm(lat, lon, fLat, fLon) * 10) / 10 : null,
    lastUpdated: p.lastUpdated || null,
    current: current(p.currentConditions, lang),
    forecastIssuedAt: pick(fg.timestamp, lang),
    regionalNormals: pick(fg.regionalNormals?.textSummary, lang),
    forecasts: (Array.isArray(fg.forecasts) ? fg.forecasts : []).map(f => forecast(f, lang)),
    hourly: (Array.isArray(p.hourlyForecastGroup?.hourlyForecasts) ? p.hourlyForecastGroup.hourlyForecasts : []).map(h => hourly(h, lang)),
    warnings: Array.isArray(p.warnings) ? p.warnings.map(w => warning(w, lang)) : null,
    sunrise: pick(p.riseSet?.sunrise, lang),
    sunset: pick(p.riseSet?.sunset, lang)
  };
}

async function searchNearest(lat, lon) {
  for (const r of SEARCH_RADII_DEG) {
    const bbox = [lon - r, lat - r, lon + r, lat + r].map(v => v.toFixed(4)).join(',');
    let body;
    try {
      const res = await fetchWithTimeoutAndRetry(`${CITYPAGE_URL}?f=json&limit=50&bbox=${bbox}`, { timeout: 20000, retries: 1, name: 'Environment Canada city page' });
      body = await res.json();
    } catch (err) {
      throw new SourceError(`Environment Canada did not answer: ${String(err.message).split('\n')[0].slice(0, 160)}`);
    }
    const features = (Array.isArray(body?.features) ? body.features : []).filter(feature => {
      const point = feature?.geometry?.coordinates;
      return Array.isArray(point) && Number.isFinite(point[0]) && Math.abs(point[0]) <= 180
        && Number.isFinite(point[1]) && Math.abs(point[1]) <= 90;
    });
    if (features.length) {
      return features.reduce((best, f) => {
        const [fLon, fLat] = f.geometry.coordinates;
        const d = distanceKm(lat, lon, fLat, fLon);
        return !best || d < best.d ? { f, d } : best;
      }, null).f;
    }
  }
  throw new SourceError('No Environment Canada city page near this position (Canada only)', { status: 404, code: 'not_found' });
}

function cacheKey({ lat, lon, lang }) {
  return `${round2(lat)},${round2(lon)},${lang === 'en' ? 'en' : 'fr'}`;
}

async function getCityWeather(position, maxAgeMs = TTL_MS) {
  const lat = round2(position.lat);
  const lon = round2(position.lon);
  const lang = position.lang === 'en' ? 'en' : 'fr';
  const hit = await cache.get(cacheKey(position), async () =>
    normalize(await searchNearest(lat, lon), { lat, lon, lang }), maxAgeMs);
  // The existing screen expects an array. Prepared reads retain missing coverage as null.
  return { ...hit.value, warnings: hit.value.warnings ?? [], fetchedAt: hit.fetchedAt.toISOString(), cached: hit.cached };
}

function peekCityWeather(position) {
  const hit = cache.peek(cacheKey(position));
  if (!hit) return { preparedStatus: 'missing', cached: false, fetchedAt: null };
  const age = Date.now() - hit.fetchedAt.getTime();
  return { ...hit.value, preparedStatus: age >= 0 && age < TTL_MS ? 'fresh' : 'stale',
    cached: true, fetchedAt: hit.fetchedAt.toISOString() };
}

function startPreparation(db) {
  let stopped = false;
  let timer;
  async function refresh() {
    let delay = RETRY_MS;
    try {
      const position = await readPosition(db);
      if (stopped) return;
      const result = await getCityWeather(position, REFRESH_MS);
      delay = Math.min(REFRESH_MS, Math.max(1, Date.parse(result.fetchedAt) + REFRESH_MS - Date.now()));
    } catch (err) {
      log(`[liveData] City weather refresh failed (${err.code || 'unavailable'})`, 'warn');
    }
    if (!stopped) timer = setTimeout(refresh, delay);
  }
  refresh();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

module.exports = { getCityWeather, peekCityWeather, startPreparation, _normalize: normalize, _cache: cache };
