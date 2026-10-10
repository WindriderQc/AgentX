/**
 * Live Data feed registry.
 *
 * Seeded feed definitions (in code) describe every feed the data service
 * fetches/stores. A `livedatafeeds` collection may override definition fields
 * per feed; `livedataconfigs` carries the on/off toggles. Adding a feed = a
 * seed entry (or a `livedatafeeds` doc) + a parser in `parsers.js` — not a new
 * code path.
 *
 * Feed shape:
 *   { id, label, category, kind, sourceUrl, urlTemplate?, fanout?, apiKeyEnv?,
 *     parser, intervalMs, timeout, retries, geo, mqttPublish?, legacyToggle?,
 *     store: { collection, mode: 'append'|'replace'|'points'|'latest', tsField?, retention? },
 *     enabled }
 */

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

// Seeded feeds — behavior-preserving port of the original liveData `config`.
// Env is read at resolve time so URLs/intervals stay overridable at runtime.
function getSeedFeeds() {
  return [
    {
      id: 'iss',
      label: 'ISS Position',
      category: 'space',
      kind: 'http',
      // open-notify.org is a long-dead upstream; default to wheretheiss.at.
      sourceUrl: process.env.ISS_API_URL || 'https://api.wheretheiss.at/v1/satellites/25544',
      parser: 'iss',
      intervalMs: int(process.env.ISS_INTERVAL_MS, 60000), // raised from 10s → 60s
      timeout: 10000,
      retries: 2,
      geo: true,
      mqttPublish: process.env.MQTT_ISS_TOPIC || 'liveData/iss',
      legacyToggle: 'iss',
      store: {
        collection: 'isses',
        mode: 'append',
        tsField: 'timeStamp',
        retention: { maxDocs: int(process.env.ISS_MAX_LOGS, 8000) }
      }
    },
    {
      id: 'quakes',
      label: 'Earthquakes',
      category: 'seismic',
      kind: 'http',
      sourceUrl: process.env.QUAKES_API_URL || 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.csv',
      parser: 'quakesCsv',
      intervalMs: int(process.env.QUAKES_INTERVAL_MS, 86400000),
      timeout: 15000,
      retries: 2,
      geo: true,
      legacyToggle: 'quakes',
      // tsField 'time' (USGS ISO string) used only for latest/history ordering; replace-swap ignores it.
      store: { collection: 'quakes', mode: 'replace', tsField: 'time' }
    },
    {
      id: 'weather',
      label: 'Barometric Pressure',
      category: 'weather',
      kind: 'http',
      // OpenWeather when an instance holds a key; otherwise keyless Open-Meteo,
      // so the feed works without a credential. Both give sea-level hPa.
      ...(process.env.WEATHER_API_KEY ? {
        sourceUrl: process.env.WEATHER_API_URL || 'https://api.openweathermap.org/data/2.5/weather',
        parser: 'openWeather',
        intervalMs: int(process.env.WEATHER_INTERVAL_MS, 60000),
        urlTemplate: '${sourceUrl}?lat=${lat}&lon=${lon}&units=metric&appid=${apiKey}',
        apiKeyEnv: 'WEATHER_API_KEY'
      } : {
        sourceUrl: process.env.WEATHER_API_URL || 'https://api.open-meteo.com/v1/forecast',
        parser: 'openMeteoPressure',
        intervalMs: int(process.env.WEATHER_INTERVAL_MS, 900000), // Open-Meteo refreshes every 15 min
        urlTemplate: '${sourceUrl}?latitude=${lat}&longitude=${lon}&current=pressure_msl'
      }),
      timeout: 10000,
      retries: 2,
      geo: true,
      fanout: 'weatherLocations',
      mqttPublish: process.env.MQTT_PRESSURE_TOPIC || 'liveData/pressure',
      legacyToggle: 'weather',
      // Original `pressures` had no prune — preserve (omit retention).
      store: { collection: 'pressures', mode: 'append', tsField: 'timeStamp' }
    },
    // ── new feeds — all land in the generic livedata_points store ──
    {
      id: 'satellites',
      label: 'Satellites (TLE)',
      category: 'space',
      kind: 'http',
      sourceUrl: process.env.CELESTRAK_GP_URL || 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
      parser: 'celestrakTle',
      intervalMs: int(process.env.SATELLITES_INTERVAL_MS, 21600000), // 6h — TLEs update ~daily
      timeout: 15000,
      retries: 2,
      geo: true,
      legacyToggle: 'satellites',
      store: { collection: 'livedata_points', mode: 'points', retention: { maxAgeMs: int(process.env.SATELLITES_MAX_AGE_MS, 604800000) } } // 7d
    },
    {
      id: 'air_quality',
      label: 'Air Quality',
      category: 'air',
      kind: 'http',
      sourceUrl: process.env.OPEN_METEO_AQI_URL || 'https://air-quality-api.open-meteo.com/v1/air-quality',
      parser: 'openMeteoAqi',
      intervalMs: int(process.env.AQI_INTERVAL_MS, 3600000), // 1h
      timeout: 10000,
      retries: 2,
      geo: true,
      fanout: 'weatherLocations', // shares the location registry with weather
      urlTemplate: '${sourceUrl}?latitude=${lat}&longitude=${lon}&current=pm2_5,pm10,us_aqi,european_aqi',
      legacyToggle: 'air_quality',
      store: { collection: 'livedata_points', mode: 'points', retention: { maxAgeMs: int(process.env.AQI_MAX_AGE_MS, 2592000000) } } // 30d
    },
    {
      // Latest value per topic only (for the feed list and the map). Sensor
      // history is the IoT store's business (services/iot): storing one point
      // per message grew by about 100,000 documents a day for a single device.
      id: 'sensors',
      label: 'MQTT Sensors',
      category: 'sensor',
      kind: 'mqtt', // push-in: subscribed via mqttClient, not polled
      parser: 'mqttSensor',
      topicsEnv: 'LIVEDATA_MQTT_TOPICS', // comma-list, e.g. "sensors/#"
      geo: true,
      legacyToggle: 'sensors',
      store: { collection: 'livedata_points', mode: 'latest', retention: { maxAgeMs: int(process.env.SENSORS_MAX_AGE_MS, 2592000000) } } // a topic silent for 30d is dropped
    }
  ];
}

// Definition fields a `livedatafeeds` doc may override on a seeded feed.
const OVERRIDABLE = ['label', 'category', 'sourceUrl', 'urlTemplate', 'intervalMs', 'timeout', 'retries', 'enabledByDefault'];

// Merge `livedatafeeds` override docs (matched by id) onto the seeds. Toggle
// state is NOT taken from here — that lives in `livedataconfigs`. A doc whose id
// is not a seed and that carries its own `parser` + `store` becomes a new feed.
function mergeOverrides(seeds, overrideDocs = []) {
  const byId = new Map(overrideDocs.map(o => [o.id || o.feedId, o]));
  const seedIds = new Set(seeds.map(f => f.id));

  const merged = seeds.map(seed => {
    const o = byId.get(seed.id);
    if (!o) return { ...seed };
    const patch = {};
    for (const k of OVERRIDABLE) if (o[k] !== undefined) patch[k] = o[k];
    const store = o.store ? { ...seed.store, ...o.store } : seed.store;
    return { ...seed, ...patch, store };
  });

  for (const o of overrideDocs) {
    const id = o.id || o.feedId;
    if (id && !seedIds.has(id) && o.parser && o.store) {
      merged.push({ kind: 'http', timeout: 10000, retries: 2, ...o, id });
    }
  }
  return merged;
}

// Stamp each feed's `enabled` from the `livedataconfigs` toggle docs (by
// legacyToggle || id), falling back to the feed's own enabledByDefault.
function applyToggles(feeds, toggleDocs = []) {
  const enabledBy = new Map(toggleDocs.map(t => [t.service, !!t.enabled]));
  return feeds.map(f => {
    const key = f.legacyToggle || f.id;
    const enabled = enabledBy.has(key) ? enabledBy.get(key) : !!f.enabledByDefault;
    return { ...f, enabled };
  });
}

function resolveRegistry(overrideDocs = [], toggleDocs = []) {
  return applyToggles(mergeOverrides(getSeedFeeds(), overrideDocs), toggleDocs);
}

function isMasterEnabled(toggleDocs = []) {
  const m = toggleDocs.find(t => t.service === 'liveDataEnabled');
  return !!(m && m.enabled);
}

module.exports = { getSeedFeeds, mergeOverrides, applyToggles, resolveRegistry, isMasterEnabled, int };
