'use strict';

// Photos over a mocked Immich. All people, places and ids are synthetic.

const express = require('express');
const request = require('supertest');
const { createPhotoRoutes } = require('../../routes/photos');
const { createPhotoService, dateBound } = require('../../src/services/photos/photoService');
const { createImmichClient, readApiKey } = require('../../src/services/photos/immichClient');

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const UNNAMED = '33333333-3333-4333-8333-333333333333';
const PHOTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = 'synthetic-immich-key';

function asset(id = PHOTO) {
  return {
    id, type: 'IMAGE', originalFileName: 'IMG_0001.jpg', originalPath: '/library/private/path/IMG_0001.jpg',
    localDateTime: '2025-07-14T15:00:00.000Z', width: 4000, height: 3000, isFavorite: true, checksum: 'x',
    exifInfo: {
      dateTimeOriginal: '2025-07-14T19:00:00.000Z', timeZone: 'America/Toronto', city: 'Sampleton',
      state: 'Example State', country: 'Exampleland', latitude: 45.1234567, longitude: -73.7654321,
      description: 'Picnic at the beach', make: 'Synthetic', model: 'Cam 1',
    },
    people: [{ id: ALICE, name: 'Alice Example', isHidden: false }, { id: UNNAMED, name: '', isHidden: false }],
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeImmich({ statistics = 'forbidden', ocr = 'ok' } = {}) {
  const calls = [];
  const fetchImpl = jest.fn(async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, pathname, search: searchParams.toString(), body, headers: init.headers });
    if (init.headers['x-api-key'] !== KEY) return json({ message: 'Invalid API key' }, 401);
    if (pathname === '/api/people') {
      return json({ total: 3, hasNextPage: false, people: [
        { id: ALICE, name: 'Alice Example', isHidden: false },
        { id: BOB, name: 'Bérénice Test', isHidden: false },
        { id: UNNAMED, name: '', isHidden: false },
      ] });
    }
    if (pathname.endsWith('/statistics')) return statistics === 'forbidden' ? json({}, 403) : json({ assets: 12 });
    if (pathname === '/api/search/smart' || pathname === '/api/search/metadata') {
      return json({ albums: { total: 0, count: 0, items: [], facets: [] },
        assets: { total: 1, count: 1, items: [asset()], facets: [], nextPage: null, nextCursor: pathname.endsWith('metadata') ? 'next-1' : null } });
    }
    if (pathname === `/api/assets/${PHOTO}/ocr`) {
      if (ocr === 'missing') return json({}, 404);
      return json([{ text: 'BEACH', x1: 0.1, y1: 0.5 }, { text: 'WELCOME TO', x1: 0.1, y1: 0.2 }]);
    }
    if (pathname === `/api/assets/${PHOTO}` && init.method === 'PUT') return json(asset());
    if (pathname === `/api/assets/${PHOTO}`) return json(asset());
    if (pathname === `/api/assets/${PHOTO}/thumbnail`) {
      return new Response(Buffer.from('synthetic-jpeg'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return json({ message: 'Not found' }, 404);
  });
  return { fetchImpl, calls };
}

function appWith({ env = {}, immich = fakeImmich(), log = { info: jest.fn() } } = {}) {
  const fullEnv = { IMMICH_URL: 'http://immich.test:2283/', IMMICH_API_KEY_FILE: '/run/secrets/immich.json', ...env };
  const readFile = jest.fn(() => JSON.stringify({ url: 'ignored', key: KEY, permissions: ['asset.read'] }));
  const client = createImmichClient({ env: fullEnv, fetchImpl: immich.fetchImpl, readFile });
  const app = express();
  app.use(express.json());
  app.use('/api/photos', createPhotoRoutes({ service: createPhotoService({ client }), log }));
  return { app, immich, readFile, log };
}

describe('photo routes', () => {
  test('are off, without any upstream call, when Immich is not configured', async () => {
    const immich = fakeImmich();
    const { app } = appWith({ env: { IMMICH_URL: '' }, immich });
    const status = await request(app).get('/api/photos/status').expect(200);
    expect(status.body.data).toEqual({ enabled: false, descriptionWriteEnabled: false });
    const response = await request(app).get('/api/photos/search/smart?q=beach').expect(503);
    expect(response.body.code).toBe('PHOTOS_NOT_CONFIGURED');
    expect(immich.fetchImpl).not.toHaveBeenCalled();
  });

  test('smart search resolves a person name, a year and a city into an Immich filter', async () => {
    const { app, immich, readFile } = appWith();
    const response = await request(app)
      .get('/api/photos/search/smart?q=at%20the%20beach&person=alice%20example&year=2025&city=Sampleton&limit=500')
      .set('x-service-caller', 'test-agent').expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const smart = immich.calls.find((call) => call.pathname === '/api/search/smart');
    expect(smart.body).toEqual({
      query: 'at the beach', size: 50, withExif: true,
      filter: {
        personIds: { all: [ALICE] }, city: { eq: 'Sampleton' },
        takenAt: { gte: '2025-01-01T00:00:00.000Z', lt: '2026-01-01T00:00:00.000Z' },
      },
    });
    expect(smart.headers['x-api-key']).toBe(KEY);
    expect(readFile).toHaveBeenCalledWith('/run/secrets/immich.json', 'utf8');
    expect(response.body.data).toEqual({ query: 'at the beach', ranked: true, count: 1, items: [{
      id: PHOTO, type: 'image', takenAt: '2025-07-14T19:00:00.000Z', fileName: 'IMG_0001.jpg',
      city: 'Sampleton', country: 'Exampleland', people: ['Alice Example'], description: 'Picnic at the beach',
      thumbnail: `/api/photos/assets/${PHOTO}/thumbnail`,
    }] });
    expect(JSON.stringify(response.body)).not.toContain('/library/private');
    expect(JSON.stringify(response.body)).not.toContain(KEY);
  });

  test('person names match without accents or case, and an unknown name is refused', async () => {
    const { app, immich } = appWith();
    await request(app).get('/api/photos/search/smart?q=snow&person=berenice%20TEST').expect(200);
    expect(immich.calls.find((call) => call.pathname === '/api/search/smart').body.filter.personIds).toEqual({ all: [BOB] });
    const unknown = await request(app).get('/api/photos/search/smart?q=snow&person=Nobody').expect(404);
    expect(unknown.body.code).toBe('PHOTOS_PERSON_UNKNOWN');
  });

  test('smart search requires words and refuses malformed bounds', async () => {
    const { app, immich } = appWith();
    expect((await request(app).get('/api/photos/search/smart').expect(400)).body.code).toBe('PHOTOS_BAD_REQUEST');
    await request(app).get('/api/photos/search/smart?q=x&from=2025-02-30').expect(400);
    await request(app).get('/api/photos/search/smart?q=x&personId=../../admin').expect(400);
    expect(immich.fetchImpl).not.toHaveBeenCalled();
  });

  test('metadata search maps text, OCR, order and cursor', async () => {
    const { app, immich } = appWith();
    const response = await request(app)
      .get('/api/photos/search?text=picnic&ocr=welcome&from=2024-06&to=2024-08&order=asc&cursor=abc&limit=5').expect(200);
    const call = immich.calls.find((entry) => entry.pathname === '/api/search/metadata');
    expect(call.body).toEqual({
      size: 5, withExif: true, withPeople: true, orderBy: { direction: 'asc' }, cursor: 'abc',
      filter: {
        description: { like: 'picnic' }, ocr: { matches: 'welcome' },
        takenAt: { gte: '2024-06-01T00:00:00.000Z', lt: '2024-09-01T00:00:00.000Z' },
      },
    });
    expect(response.body.data.nextCursor).toBe('next-1');
  });

  test('people lists named people and says why photo counts are missing', async () => {
    const { app } = appWith();
    const plain = await request(app).get('/api/photos/people').expect(200);
    expect(plain.body.data).toEqual({ count: 2, unnamed: 1, people: [
      { id: ALICE, name: 'Alice Example' }, { id: BOB, name: 'Bérénice Test' },
    ] });
    const counted = await request(app).get('/api/photos/people?counts=true').expect(200);
    expect(counted.body.data.countsAvailable).toBe(false);
    expect(counted.body.data.countsUnavailableReason).toMatch(/person\.statistics/);
    expect(counted.body.data.people.every((person) => person.photoCount === null)).toBe(true);
  });

  test('people counts come from Immich statistics when the key allows it', async () => {
    const { app } = appWith({ immich: fakeImmich({ statistics: 'ok' }) });
    const counted = await request(app).get('/api/photos/people?counts=true&includeUnnamed=true').expect(200);
    expect(counted.body.data.countsAvailable).toBe(true);
    expect(counted.body.data.people.map((person) => person.photoCount)).toEqual([12, 12, 12]);
  });

  test('assets of a person filter by that person id', async () => {
    const { app, immich } = appWith();
    await request(app).get(`/api/photos/people/${ALICE}/assets?year=2025`).expect(200);
    expect(immich.calls.at(-1).body.filter.personIds).toEqual({ all: [ALICE] });
  });

  test('asset details are compact and carry place, people, description and OCR text', async () => {
    const { app } = appWith();
    const response = await request(app).get(`/api/photos/assets/${PHOTO}`).expect(200);
    expect(response.body.data).toEqual({
      id: PHOTO, type: 'image', takenAt: '2025-07-14T19:00:00.000Z', timeZone: 'America/Toronto',
      fileName: 'IMG_0001.jpg',
      place: { city: 'Sampleton', state: 'Example State', country: 'Exampleland', coordinates: { latitude: 45.12346, longitude: -73.76543 } },
      people: [{ id: ALICE, name: 'Alice Example' }, { id: UNNAMED, name: null }],
      description: 'Picnic at the beach', ocrText: 'WELCOME TO\nBEACH', camera: 'Synthetic Cam 1',
      width: 4000, height: 3000, favorite: true,
      thumbnail: `/api/photos/assets/${PHOTO}/thumbnail`, preview: `/api/photos/assets/${PHOTO}/thumbnail?size=preview`,
    });
  });

  test('asset details still answer when OCR is absent', async () => {
    const { app } = appWith({ immich: fakeImmich({ ocr: 'missing' }) });
    const response = await request(app).get(`/api/photos/assets/${PHOTO}`).expect(200);
    expect(response.body.data.ocrText).toBeNull();
  });

  test('thumbnail proxy returns the image bytes without exposing the key', async () => {
    const { app, immich } = appWith();
    const response = await request(app).get(`/api/photos/assets/${PHOTO}/thumbnail?size=preview`).expect(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(response.body).toString()).toBe('synthetic-jpeg');
    expect(immich.calls.at(-1).search).toBe('size=preview');
    await request(app).get(`/api/photos/assets/${PHOTO}/thumbnail?size=original`).expect(400);
  });

  test('an unknown asset is a 404 and a missing scope is named', async () => {
    const { app } = appWith();
    const missing = await request(app).get('/api/photos/assets/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb').expect(404);
    expect(missing.body.code).toBe('PHOTOS_NOT_FOUND');
  });

  test('a wrong key surfaces as an upstream permission error', async () => {
    const immich = fakeImmich();
    const client = createImmichClient({ env: { IMMICH_URL: 'http://immich.test', IMMICH_API_KEY_FILE: '/k' },
      fetchImpl: immich.fetchImpl, readFile: () => 'wrong-key' });
    const app = express();
    app.use('/api/photos', createPhotoRoutes({ service: createPhotoService({ client }) }));
    const response = await request(app).get('/api/photos/people').expect(502);
    expect(response.body.code).toBe('PHOTOS_UPSTREAM_FORBIDDEN');
  });

  test('a slow Immich becomes a timeout, not a hang', async () => {
    const fetchImpl = jest.fn(async () => { throw Object.assign(new Error('late'), { name: 'TimeoutError' }); });
    const client = createImmichClient({ env: { IMMICH_URL: 'http://immich.test', IMMICH_API_KEY_FILE: '/k' },
      fetchImpl, readFile: () => KEY });
    const app = express();
    app.use('/api/photos', createPhotoRoutes({ service: createPhotoService({ client }) }));
    expect((await request(app).get('/api/photos/people').expect(504)).body.code).toBe('PHOTOS_UPSTREAM_TIMEOUT');
  });

  test('setting a description is refused while the write flag is off', async () => {
    const { app, immich } = appWith();
    const response = await request(app).put(`/api/photos/assets/${PHOTO}/description`).send({ description: 'x' }).expect(403);
    expect(response.body.code).toBe('PHOTOS_WRITE_DISABLED');
    expect(immich.fetchImpl).not.toHaveBeenCalled();
  });

  test('setting a description writes only the description when the flag is on', async () => {
    const { app, immich, log } = appWith({ env: { IMMICH_DESCRIPTION_WRITE_ENABLED: 'true' } });
    await request(app).put(`/api/photos/assets/${PHOTO}/description`).set('x-service-caller', 'test-agent')
      .send({ description: '  Family picnic  ' }).expect(200);
    const write = immich.calls.find((call) => call.method === 'PUT');
    expect(write.pathname).toBe(`/api/assets/${PHOTO}`);
    expect(write.body).toEqual({ description: 'Family picnic' });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('test-agent'));
    await request(app).put(`/api/photos/assets/${PHOTO}/description`).send({ description: 'x'.repeat(2001) }).expect(400);
  });
});

describe('photo helpers', () => {
  test('date bounds cover whole periods', () => {
    expect(dateBound('2025-02', 'to')).toEqual({ lt: '2025-03-01T00:00:00.000Z' });
    expect(dateBound('2025-12-31', 'to')).toEqual({ lt: '2026-01-01T00:00:00.000Z' });
    expect(dateBound('2025-03-04T10:00:00Z', 'from')).toEqual({ gte: '2025-03-04T10:00:00.000Z' });
  });

  test('the key file accepts a bare key or JSON, and never an empty one', () => {
    expect(readApiKey('/k', () => ' bare-key \n')).toBe('bare-key');
    expect(readApiKey('/k', () => '{"key":"json-key"}')).toBe('json-key');
    expect(() => readApiKey('/k', () => '{"url":"x"}')).toThrow(expect.objectContaining({ code: 'PHOTOS_KEY_UNAVAILABLE' }));
    expect(() => readApiKey('/k', () => { throw new Error('ENOENT'); })).toThrow(expect.objectContaining({ code: 'PHOTOS_KEY_UNAVAILABLE' }));
  });
});
