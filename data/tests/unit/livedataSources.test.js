/**
 * On-demand live sources: TLE, WorldTides tides, Environment Canada city weather.
 * global.fetch is mocked; nothing leaves the process.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

const livedataRoutes = require('../../routes/livedata.routes');
const errorHandler = require('../../middleware/errorHandler');
const tle = require('../../services/livedata/tle');
const tides = require('../../services/livedata/tides');
const ecCityPage = require('../../services/livedata/ecCityPage');
const { checksumOk, epochOf, parseTleText } = require('../../services/livedata/tleText');

const ISS_NAME = 'ISS (ZARYA)';
const ISS_L1 = '1 25544U 98067A   26297.20915682  .00007800  00000+0  14938-3 0  9991';
const ISS_L2 = '2 25544  51.6335  21.6229 0006884 302.9098  57.1228 15.49030149591752';
const ISS_TEXT = `${ISS_NAME}\n${ISS_L1}\n${ISS_L2}\n`;
const EPOCH_MS = Date.UTC(2026, 0, 1) + (297.20915682 - 1) * 86_400_000;

function response(body, { status = 200, json = true } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => (json ? body : JSON.parse(body)),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

function buildApp(feedPoints = []) {
  const app = express();
  app.use(express.json());
  const toArray = jest.fn().mockResolvedValue(feedPoints);
  const col = { find: jest.fn(() => ({ sort: () => ({ limit: () => ({ toArray }) }) })) };
  app.locals.db = { collection: jest.fn(() => col) };
  app.use('/api/v1/livedata', livedataRoutes);
  app.use(errorHandler);
  return app;
}

const realFetch = global.fetch;
let nowSpy;

beforeEach(() => {
  global.fetch = jest.fn();
  tle._cache.clear();
  ecCityPage._cache.clear();
  tides._resetCache();
  delete process.env.WORLDTIDES_API_KEY;
  delete process.env.WORLDTIDES_CACHE_MS;
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(EPOCH_MS + 6 * 3_600_000);
});

afterEach(() => {
  nowSpy.mockRestore();
});

afterAll(() => {
  global.fetch = realFetch;
});

describe('TLE text helpers', () => {
  test('validate the checksum and read the epoch of a real ISS element set', () => {
    expect(checksumOk(ISS_L1)).toBe(true);
    expect(checksumOk(ISS_L2)).toBe(true);
    expect(checksumOk(ISS_L1.slice(0, 68) + '0')).toBe(false);
    expect(epochOf(ISS_L1).toISOString()).toBe(new Date(EPOCH_MS).toISOString());
    expect(parseTleText(ISS_TEXT)).toEqual([{ name: ISS_NAME, noradId: '25544', tle1: ISS_L1, tle2: ISS_L2 }]);
  });
});

describe('GET /api/v1/livedata/tle', () => {
  test('uses a fresh satellites feed point without calling CelesTrak', async () => {
    const point = { feedId: 'satellites', ts: new Date(EPOCH_MS + 3_600_000), payload: { name: ISS_NAME, noradId: '25544', tle1: ISS_L1, tle2: ISS_L2 } };
    const res = await request(buildApp([point])).get('/api/v1/livedata/tle').expect(200);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(res.body.data).toMatchObject({ noradId: '25544', source: 'feed', line1: ISS_L1, line2: ISS_L2, stale: false, epochAgeHours: 6 });
  });

  test('fetches one catalog number from CelesTrak, then answers from the cache', async () => {
    global.fetch.mockResolvedValue(response(ISS_TEXT));
    const app = buildApp();
    const first = await request(app).get('/api/v1/livedata/tle?norad=25544').expect(200);
    const second = await request(app).get('/api/v1/livedata/tle').expect(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe('https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle');
    expect(first.body.data).toMatchObject({ source: 'celestrak', cached: false, epoch: new Date(EPOCH_MS).toISOString() });
    expect(second.body.data.cached).toBe(true);
  });

  test('format=tle returns the three lines with epoch and source headers', async () => {
    global.fetch.mockResolvedValue(response(ISS_TEXT));
    const res = await request(buildApp()).get('/api/v1/livedata/tle?format=tle').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['x-tle-epoch']).toBe(new Date(EPOCH_MS).toISOString());
    expect(res.headers['x-tle-source']).toBe('celestrak');
    expect(res.text).toBe(ISS_TEXT);
  });

  test('falls back to the last known element set, marked stale, when CelesTrak fails', async () => {
    global.fetch.mockResolvedValueOnce(response(ISS_TEXT));
    const app = buildApp();
    await request(app).get('/api/v1/livedata/tle').expect(200);
    nowSpy.mockReturnValue(EPOCH_MS + 9 * 3_600_000); // past the 2 h cache
    global.fetch.mockResolvedValueOnce(response('busy', { status: 503 }));
    const res = await request(app).get('/api/v1/livedata/tle').expect(200);
    expect(res.body.data).toMatchObject({ source: 'celestrak', stale: true });
    expect(res.body.data.note).toMatch(/CelesTrak did not answer/);
  });

  test('answers 502 when CelesTrak fails and nothing is known, and 400 for a bad catalog number', async () => {
    global.fetch.mockResolvedValue(response('No GP data found', { status: 200 }));
    const res = await request(buildApp()).get('/api/v1/livedata/tle').expect(502);
    expect(res.body).toMatchObject({ status: 'error', code: 'upstream_error' });
    await request(buildApp()).get('/api/v1/livedata/tle?norad=ISS').expect(400);
    await request(buildApp()).get('/api/v1/livedata/tle?format=xml').expect(400);
  });
});

describe('GET /api/v1/livedata/tides', () => {
  const body = {
    status: 200, callCount: 2, station: 'Vieux-québec', atlas: 'Canada',
    responseLat: 46.8111, responseLon: -71.2019, responseDatum: 'LAT', copyright: 'WorldTides',
    extremes: [{ dt: 1792859880, type: 'Low', height: -2.056 }, { dt: 1792879080, type: 'High', height: 2.245 }],
    heights: [{ dt: 1792800000, height: 0.5 }]
  };

  test('says the key is missing (503) and calls nothing', async () => {
    const res = await request(buildApp()).get('/api/v1/livedata/tides?lat=46.8139&lon=-71.2082').expect(503);
    expect(res.body).toMatchObject({ status: 'error', code: 'not_configured' });
    expect(res.body.message).toMatch(/WORLDTIDES_API_KEY/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('requests the UTC day at a rounded position, normalizes, and caches per day', async () => {
    process.env.WORLDTIDES_API_KEY = 'test-key-123';
    global.fetch.mockResolvedValue(response(body));
    const app = buildApp();
    const res = await request(app).get('/api/v1/livedata/tides?lat=46.81392&lon=-71.20821&days=1').expect(200);
    await request(app).get('/api/v1/livedata/tides?lat=46.8141&lon=-71.2079&days=1').expect(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const url = new URL(global.fetch.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://www.worldtides.info/api/v3');
    expect(url.search.startsWith('?heights&extremes&')).toBe(true);
    const dayStart = new Date(Date.now()); dayStart.setUTCHours(0, 0, 0, 0);
    expect(url.searchParams.get('start')).toBe(String(dayStart.getTime() / 1000));
    expect(url.searchParams.get('lat')).toBe('46.81');
    expect(url.searchParams.get('lon')).toBe('-71.21');
    expect(url.searchParams.get('days')).toBe('1');

    expect(res.body.data).toMatchObject({
      source: 'worldtides', station: 'Vieux-québec', datum: 'LAT', days: 1, cached: false,
      extremes: [
        { time: new Date(1792859880000).toISOString(), type: 'low', heightM: -2.056 },
        { time: new Date(1792879080000).toISOString(), type: 'high', heightM: 2.245 }
      ]
    });
    expect(JSON.stringify(res.body)).not.toContain('test-key-123');
  });

  test('reports a WorldTides refusal as 502 without the key', async () => {
    process.env.WORLDTIDES_API_KEY = 'test-key-123';
    global.fetch.mockResolvedValue(response({ status: 400, error: 'No credits remaining' }));
    const res = await request(buildApp()).get('/api/v1/livedata/tides?lat=46.8&lon=-71.2').expect(502);
    expect(res.body.message).toMatch(/No credits remaining/);
    expect(JSON.stringify(res.body)).not.toContain('test-key-123');
  });

  test('rejects a missing position or an out-of-range day count', async () => {
    process.env.WORLDTIDES_API_KEY = 'test-key-123';
    await request(buildApp()).get('/api/v1/livedata/tides?lat=46.8').expect(400);
    await request(buildApp()).get('/api/v1/livedata/tides?lat=99&lon=0').expect(400);
    await request(buildApp()).get('/api/v1/livedata/tides?lat=46.8&lon=-71.2&days=30').expect(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/livedata/ec-weather', () => {
  const t = (en, fr = en) => ({ en, fr });
  const feature = (identifier, lon, lat, nameFr) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      lastUpdated: '2026-10-25T13:02:56Z',
      identifier,
      name: t(nameFr, nameFr),
      region: t('Québec area', 'secteur de Québec'),
      url: t('https://weather.gc.ca/en/x', 'https://meteo.gc.ca/fr/x'),
      currentConditions: {
        timestamp: t('2026-10-25T13:00:00Z'),
        condition: t('Mainly Sunny', 'Généralement ensoleillé'),
        iconCode: { value: 1 },
        temperature: { value: t(2.9) },
        dewpoint: { value: t(-0.3) },
        windChill: { value: t(-3) },
        relativeHumidity: { value: t(79) },
        pressure: { value: t(103.4), tendency: t('rising', 'à la hausse') },
        wind: { speed: { value: t(2) }, gust: { value: t(28) }, direction: { value: t('N') } },
        station: { value: t("Quebec Lesage Int'l Airport", 'Aéroport int. Lesage de Québec') }
      },
      forecastGroup: {
        timestamp: t('2026-10-25T09:00:00Z'),
        regionalNormals: { textSummary: t('Low zero. High 8.', 'Minimum zéro. Maximum 8.') },
        forecasts: [{
          period: { textForecastName: t('Today', "Aujourd'hui") },
          textSummary: t('Sunny. High 13.', 'Ensoleillé. Maximum 13.'),
          abbreviatedForecast: { icon: { value: 0 }, textSummary: t('Sunny', 'Ensoleillé') },
          temperatures: { temperature: [{ class: t('high'), value: t(13) }] }
        }]
      },
      hourlyForecastGroup: {
        hourlyForecasts: [{
          timestamp: '2026-10-25T14:00:00Z', condition: t('Sunny', 'Ensoleillé'), iconCode: { value: 0 },
          temperature: { value: t(6) }, lop: { value: t(0) },
          wind: { speed: { value: t(10) }, direction: { value: t('SW', 'SO') } }
        }]
      },
      warnings: [{
        description: t('YELLOW ADVISORY - FOG', 'AVIS JAUNE - BROUILLARD'), type: t('advisory'),
        alertColourLevel: t('yellow'), eventIssue: t('2026-10-25T12:32:15Z'), expiryTime: t('2026-10-25T16:00:15Z'),
        url: t('https://weather.gc.ca/w', 'https://meteo.gc.ca/w')
      }],
      riseSet: { sunrise: t('2026-10-25T11:17:00Z'), sunset: t('2026-10-25T21:41:00Z') }
    }
  });

  test('picks the nearest city page and returns it in French', async () => {
    global.fetch.mockResolvedValue(response({ features: [feature('qc-999', -70.5, 46.9, 'Loin'), feature('qc-133', -71.21, 46.81, 'Québec')] }));
    const res = await request(buildApp()).get('/api/v1/livedata/ec-weather?lat=46.8139&lon=-71.2082').expect(200);
    expect(global.fetch.mock.calls[0][0]).toMatch(/^https:\/\/api\.weather\.gc\.ca\/collections\/citypageweather-realtime\/items\?f=json&limit=50&bbox=/);
    const d = res.body.data;
    expect(d).toMatchObject({
      source: 'environment-canada', lang: 'fr', identifier: 'qc-133', name: 'Québec',
      current: { condition: 'Généralement ensoleillé', temperatureC: 2.9, windChill: -3, pressureKPa: 103.4, pressureTendency: 'à la hausse', gustKmh: 28, station: 'Aéroport int. Lesage de Québec' },
      forecasts: [{ period: "Aujourd'hui", summary: 'Ensoleillé. Maximum 13.', temperatures: [{ class: 'high', valueC: 13 }] }],
      hourly: [{ time: '2026-10-25T14:00:00Z', temperatureC: 6, windDirection: 'SO' }],
      warnings: [{ description: 'AVIS JAUNE - BROUILLARD', colour: 'yellow' }],
      sunrise: '2026-10-25T11:17:00Z', regionalNormals: 'Minimum zéro. Maximum 8.'
    });
    expect(d.distanceKm).toBeLessThan(1);
  });

  test('widens the search once, then answers 404 outside Canada', async () => {
    global.fetch.mockResolvedValue(response({ features: [] }));
    const res = await request(buildApp()).get('/api/v1/livedata/ec-weather?lat=48.85&lon=2.35').expect(404);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(res.body.code).toBe('not_found');
  });

  test('serves English on request and caches per position and language', async () => {
    global.fetch.mockResolvedValue(response({ features: [feature('qc-133', -71.21, 46.81, 'Québec')] }));
    const app = buildApp();
    const en = await request(app).get('/api/v1/livedata/ec-weather?lat=46.81&lon=-71.21&lang=en').expect(200);
    await request(app).get('/api/v1/livedata/ec-weather?lat=46.81&lon=-71.21&lang=en').expect(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(en.body.data.current.condition).toBe('Mainly Sunny');
    await request(app).get('/api/v1/livedata/ec-weather?lat=46.81&lon=-71.21&lang=de').expect(400);
  });
});
