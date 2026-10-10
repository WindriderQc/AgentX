/**
 * Unit tests for the new feeds:
 * CelesTrak TLE, Open-Meteo air quality, MQTT sensor parsers + registry entries.
 */
const registry = require('../../services/livedata/registry');
const parsers = require('../../services/livedata/parsers');

describe('registry — new feeds registered', () => {
  test('satellites / air_quality / sensors exist with the right shape', () => {
    const feeds = registry.resolveRegistry([], []);
    const byId = Object.fromEntries(feeds.map(f => [f.id, f]));

    expect(byId.satellites).toMatchObject({ kind: 'http', parser: 'celestrakTle' });
    expect(byId.satellites.store).toMatchObject({ collection: 'livedata_points', mode: 'points' });

    expect(byId.air_quality).toMatchObject({ kind: 'http', parser: 'openMeteoAqi', fanout: 'weatherLocations' });
    expect(byId.air_quality.store.mode).toBe('points');

    expect(byId.sensors).toMatchObject({ kind: 'mqtt', parser: 'mqttSensor', topicsEnv: 'LIVEDATA_MQTT_TOPICS' });
    expect(byId.sensors.store.mode).toBe('latest');
  });

  test('all new feeds carry a maxAgeMs retention so livedata_points stays bounded', () => {
    const byId = Object.fromEntries(registry.resolveRegistry([], []).map(f => [f.id, f]));
    for (const id of ['satellites', 'air_quality', 'sensors']) {
      expect(byId[id].store.retention.maxAgeMs).toBeGreaterThan(0);
    }
  });
});

describe('parsers.celestrakTle', () => {
  const asRes = (text) => ({ text: async () => text });
  const TLE = [
    'ISS (ZARYA)',
    '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9000',
    '2 25544  51.6400 208.0000 0006703 130.0000 325.0000 15.50000000    07',
    'CSS (TIANHE)',
    '1 48274U 21035A   24001.50000000  .00012345  00000-0  10270-3 0  9001',
    '2 48274  41.4700 100.0000 0007000 100.0000 260.0000 15.60000000    08'
  ].join('\n');

  test('parses each 3-line TLE block into a point', async () => {
    const out = await parsers.celestrakTle(asRes(TLE));
    expect(out).toHaveLength(2);
    expect(out[0].payload).toMatchObject({ name: 'ISS (ZARYA)', noradId: '25544' });
    expect(out[0].payload.tle1).toMatch(/^1 25544/);
    expect(out[1].payload.noradId).toBe('48274');
  });

  test('tolerates trailing blank lines / CRLF', async () => {
    const out = await parsers.celestrakTle(asRes(TLE.replace(/\n/g, '\r\n') + '\r\n\r\n'));
    expect(out).toHaveLength(2);
  });
});

describe('parsers.openMeteoAqi', () => {
  test('maps the current block + geo for a location', async () => {
    const res = { json: async () => ({ latitude: 46.8, longitude: -71.2, current: { time: '2026-06-20T12:00', pm2_5: 8.3, pm10: 12, us_aqi: 34 } }) };
    const out = await parsers.openMeteoAqi(res, { location: { lat: 46.8, lon: -71.2 } });
    expect(out[0]).toMatchObject({ lat: 46.8, lon: -71.2 });
    expect(out[0].payload).toMatchObject({ pm2_5: 8.3, pm10: 12, us_aqi: 34 });
  });
});

describe('parsers.mqttSensor', () => {
  test('spreads a JSON payload and lifts lat/lon to geo', async () => {
    const out = await parsers.mqttSensor({ topic: 'sensors/garage', payloadStr: '{"temp":21.5,"lat":46.8,"lon":-71.2}' });
    expect(out[0].payload).toMatchObject({ topic: 'sensors/garage', temp: 21.5 });
    expect(out[0]).toMatchObject({ lat: 46.8, lon: -71.2 }); // store.writePoints turns this into geo
  });

  test('wraps a scalar payload as { value }', async () => {
    const out = await parsers.mqttSensor({ topic: 'sensors/temp', payloadStr: '42' });
    expect(out[0].payload).toEqual({ topic: 'sensors/temp', value: 42 });
  });

  test('keeps a non-numeric scalar as-is', async () => {
    const out = await parsers.mqttSensor({ topic: 'sensors/state', payloadStr: 'ON' });
    expect(out[0].payload).toEqual({ topic: 'sensors/state', value: 'ON' });
  });
});
