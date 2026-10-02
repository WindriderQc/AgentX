/**
 * Route tests for the uniform consumption API:
 * /feeds, /:feed/latest, /:feed/history, + the 404 path.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

// Self-contained service mock (no out-of-scope refs in the factory).
jest.mock('../../services/liveData', () => {
  const feeds = [
    {
      id: 'iss', label: 'ISS Position', category: 'space', kind: 'http',
      enabled: true, intervalMs: 60000, geo: true,
      store: { collection: 'isses', mode: 'append', tsField: 'timeStamp' },
      health: { lastFetchAt: new Date('2026-06-20T00:00:00Z'), lastError: null, lastCount: 1 }
    },
    {
      id: 'air_quality', label: 'Air Quality', category: 'air', kind: 'http',
      enabled: false, intervalMs: 600000, geo: true,
      store: { collection: 'livedata_points', mode: 'points' },
      health: null
    }
  ];
  return {
    getFeeds: () => feeds,
    getFeedById: (id) => feeds.find(f => f.id === id) || null,
    getState: () => ({ liveDataEnabled: true, iss: true }),
    reloadConfig: jest.fn()
  };
});

const livedataRoutes = require('../../routes/livedata.routes');
const errorHandler = require('../../middleware/errorHandler');

function makeCol(docs = []) {
  return {
    find: jest.fn(() => {
      let r = [...docs];
      const cur = {
        sort: jest.fn(() => cur),
        limit: jest.fn((n) => { r = r.slice(0, n); return cur; }),
        toArray: jest.fn(async () => r)
      };
      return cur;
    }),
    countDocuments: jest.fn(async () => docs.length)
  };
}

function buildApp(collections = {}) {
  const app = express();
  app.use(express.json());
  const cols = {};
  for (const [k, v] of Object.entries(collections)) cols[k] = makeCol(v);
  app.locals.db = { collection: (name) => (cols[name] = cols[name] || makeCol()) };
  app.use('/api/v1/livedata', livedataRoutes);
  app.use(errorHandler);
  return app;
}

describe('GET /api/v1/livedata/feeds', () => {
  test('lists feeds with health + per-feed count', async () => {
    const app = buildApp({ isses: [{ a: 1 }, { a: 2 }], livedata_points: [{ feedId: 'air_quality' }] });
    const res = await request(app).get('/api/v1/livedata/feeds').expect(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(2);
    const iss = res.body.data.find(f => f.id === 'iss');
    expect(iss).toMatchObject({ enabled: true, category: 'space' });
    expect(iss.count).toBe(2);
    expect(iss.lastFetchAt).toBeTruthy();
    expect(typeof iss.ageMs).toBe('number');
  });
});

describe('GET /api/v1/livedata/:feed/latest', () => {
  test('returns newest doc(s) for a typed feed', async () => {
    const app = buildApp({ isses: [{ latitude: 1, longitude: 2, timeStamp: new Date() }] });
    const res = await request(app).get('/api/v1/livedata/iss/latest').expect(200);
    expect(res.body.feed).toBe('iss');
    expect(res.body.data).toHaveLength(1);
  });

  test('routes a points feed to livedata_points', async () => {
    const app = buildApp({ livedata_points: [{ feedId: 'air_quality', payload: { pm2_5: 9 } }] });
    const res = await request(app).get('/api/v1/livedata/air_quality/latest').expect(200);
    expect(res.body.feed).toBe('air_quality');
    expect(res.body.data[0].payload.pm2_5).toBe(9);
  });

  test('404 for an unknown feed, with the valid list', async () => {
    const res = await request(buildApp()).get('/api/v1/livedata/bogus/latest').expect(404);
    expect(res.body.status).toBe('error');
    expect(res.body.validFeeds).toEqual(['iss', 'air_quality']);
  });
});

describe('GET /api/v1/livedata/:feed/history', () => {
  test('returns a bounded series', async () => {
    const app = buildApp({ isses: [{ timeStamp: new Date(1) }, { timeStamp: new Date(2) }] });
    const res = await request(app).get('/api/v1/livedata/iss/history?limit=10').expect(200);
    expect(res.body.feed).toBe('iss');
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('legacy aliases still work', () => {
  test('GET /iss returns positions', async () => {
    const app = buildApp({ isses: [{ latitude: 1, longitude: 2, timeStamp: new Date() }] });
    const res = await request(app).get('/api/v1/livedata/iss').expect(200);
    expect(res.body.count).toBe(1);
  });
  test('GET /pressure (new alias) returns pressure readings', async () => {
    const app = buildApp({ pressures: [{ pressure: 1013, timeStamp: new Date() }] });
    const res = await request(app).get('/api/v1/livedata/pressure').expect(200);
    expect(res.body.data[0].pressure).toBe(1013);
  });
});
