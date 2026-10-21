'use strict';

// Photos over a mocked Immich that applies the v3 filters to a small
// synthetic library. All people, places, tags and ids are synthetic.

const express = require('express');
const request = require('supertest');
const { createPhotoRoutes } = require('../../routes/photos');
const { createPhotoService } = require('../../src/services/photos/photoService');
const { createImmichClient, readApiKey } = require('../../src/services/photos/immichClient');
const { dateBound, zonedMidnight } = require('../../src/services/photos/photoFilters');

const KEY = 'synthetic-immich-key';
const id = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const P = { alice: id(1), bob: id(2), unnamed: id(3), jordan: id(4), jordan2: id(5), alice2: id(6) };
const A = { beach: id('a'), city: id('b'), hidden: id('c'), pending: id('d') };
const T = { root: id(7), season: id(8), summer: id(9), review: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };

function person(pid, name) { return { id: pid, name, isHidden: false }; }

function library() {
  return [
    { id: A.beach, type: 'IMAGE', originalFileName: 'IMG_0001.jpg', originalPath: '/library/private/IMG_0001.jpg',
      localDateTime: '2025-07-14T15:00:00.000Z', width: 4000, height: 3000, isFavorite: true, visibility: 'timeline',
      exifInfo: { dateTimeOriginal: '2025-07-14T19:00:00.000Z', timeZone: 'America/Toronto', city: 'Sampleton',
        state: 'Example State', country: 'Exampleland', latitude: 45.1234567, longitude: -73.7654321,
        description: 'Picnic at the beach', make: 'Synthetic', model: 'Cam 1' },
      people: [person(P.alice, 'Alice Example'), person(P.unnamed, '')],
      tags: [{ id: T.summer, value: 'AgentX/Saison/été' }] },
    { id: A.city, type: 'IMAGE', originalFileName: 'IMG_0002.jpg', localDateTime: '2025-12-31T21:00:00.000Z',
      visibility: 'timeline',
      exifInfo: { dateTimeOriginal: '2026-01-01T02:00:00.000Z', city: 'Saint-Élan–Nord', state: 'Example State',
        country: 'Exampleland', description: '' },
      people: [person(P.alice2, 'Alice Example'), person(P.bob, 'Bérénice Test')], tags: [] },
    { id: A.hidden, type: 'VIDEO', originalFileName: 'IMG_0003.mov', visibility: 'hidden',
      exifInfo: { dateTimeOriginal: '2024-01-01T12:00:00.000Z' }, people: [], tags: [] },
    { id: A.pending, type: 'IMAGE', originalFileName: 'IMG_0004.jpg', visibility: 'timeline',
      exifInfo: { dateTimeOriginal: '2024-05-01T12:00:00.000Z', description: 'Generated: kids at a fair' },
      people: [person(P.bob, 'Bérénice Test')],
      tags: [{ id: T.review, value: 'AgentX/Relecture/à relire' }, { id: T.summer, value: 'AgentX/Saison/été' },
        { id: id(9).replace(/^9/, 'f'), value: 'Famille' }] },
  ];
}

function matches(asset, filter = {}) {
  const exif = asset.exifInfo || {};
  const branch = (f) => Object.entries(f).every(([key, cond]) => {
    if (key === 'or') return cond.some(branch);
    if (key === 'id') return asset.id === cond.eq;
    if (key === 'personIds') return cond.all.every((pid) => (asset.people || []).some((p) => p.id === pid));
    if (key === 'tagIds') return cond.all.every((tid) => (asset.tags || []).some((t) => t.id === tid));
    if (key === 'visibility') return asset.visibility === cond.eq;
    if (key === 'isFavorite') return Boolean(asset.isFavorite) === cond.eq;
    if (['city', 'state', 'country'].includes(key)) {
      if ('ne' in cond) return exif[key] != cond.ne; // eslint-disable-line eqeqeq
      return cond.eq !== undefined ? exif[key] === cond.eq : cond.in.includes(exif[key]);
    }
    if (key === 'takenAt') {
      const t = Date.parse(exif.dateTimeOriginal);
      return (!cond.gte || t >= Date.parse(cond.gte)) && (!cond.lt || t < Date.parse(cond.lt)) && (!cond.lte || t <= Date.parse(cond.lte));
    }
    if (key === 'description') return String(exif.description || '').includes(cond.like);
    return true;
  });
  return branch(filter);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeImmich({ statistics = 'forbidden', personStatistics = 'forbidden', ocr = 'ok', smartPeople = false } = {}) {
  const assets = library();
  const calls = [];
  const fetchImpl = jest.fn(async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, pathname, search: searchParams.toString(), body, headers: init.headers });
    if (init.headers['x-api-key'] !== KEY) return json({ message: 'Invalid API key' }, 401);
    const asset = assets.find((item) => pathname.startsWith(`/api/assets/${item.id}`));
    if (pathname === '/api/people') {
      return json({ total: 6, hasNextPage: false, people: [
        person(P.alice, 'Alice Example'), person(P.alice2, 'Alice Example'), person(P.bob, 'Bérénice Test'),
        person(P.unnamed, ''), person(P.jordan, 'Jordan Example'), person(P.jordan2, 'Jordan Sample'),
      ] });
    }
    if (pathname.endsWith('/statistics') && pathname.startsWith('/api/people/')) {
      return personStatistics === 'forbidden' ? json({}, 403) : json({ assets: 12 });
    }
    if (pathname === '/api/tags') {
      return json([{ id: T.root, name: 'AgentX', value: 'AgentX' }, { id: T.season, name: 'Saison', value: 'AgentX/Saison' },
        { id: T.summer, name: 'été', value: 'AgentX/Saison/été' }, { id: T.review, name: 'à relire', value: 'AgentX/Relecture/à relire' }]);
    }
    if (pathname === '/api/search/suggestions') {
      const values = { city: ['Sampleton', 'Saint-Élan–Nord', 'Saint-Élan', 'Example State'], state: ['Example State'], country: ['Exampleland'] };
      return json(values[searchParams.get('type')] || []);
    }
    if (pathname === '/api/search/statistics') {
      if (statistics === 'forbidden') return json({}, 403);
      return json({ total: assets.filter((item) => matches(item, body.filter)).length });
    }
    if (pathname === '/api/search/smart' || pathname === '/api/search/metadata') {
      const found = assets.filter((item) => matches(item, body.filter));
      const smart = pathname.endsWith('smart');
      const items = found.slice(0, body.size).map((item) => {
        const copy = { ...item };
        if (smart && !smartPeople) copy.people = []; // Immich v3 smart search never fills people
        if (!body.withPeople && !smart) delete copy.people;
        return copy;
      });
      return json({ albums: { total: 0, count: 0, items: [], facets: [] },
        assets: { total: items.length, count: items.length, items, facets: [], nextPage: null,
          nextCursor: !smart && found.length > body.size ? 'next-1' : null } });
    }
    if (asset && pathname.endsWith('/ocr')) {
      if (ocr === 'missing') return json({}, 404);
      return json([{ text: 'BEACH', x1: 0.1, y1: 0.5 }, { text: 'WELCOME TO', x1: 0.1, y1: 0.2 }]);
    }
    if (asset && pathname.endsWith('/thumbnail')) {
      return new Response(Buffer.from('synthetic-jpeg'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (asset && pathname === `/api/assets/${asset.id}`) return json(asset);
    return json({ message: 'Not found' }, 404);
  });
  return { fetchImpl, calls };
}

function appWith({ env = {}, immich = fakeImmich(), log = { info: jest.fn() }, timeZone = 'America/Toronto' } = {}) {
  const fullEnv = { IMMICH_URL: 'http://immich.test:2283/', IMMICH_API_KEY_FILE: '/run/secrets/immich.json', ...env };
  const readFile = jest.fn(() => JSON.stringify({ url: 'ignored', key: KEY, permissions: ['asset.read'] }));
  const client = createImmichClient({ env: fullEnv, fetchImpl: immich.fetchImpl, readFile });
  const app = express();
  app.use(express.json());
  app.use('/api/photos', createPhotoRoutes({ service: createPhotoService({ client, timeZone }), log }));
  return { app, immich, readFile, log };
}

// The caller's own search: the last one asking for EXIF (helper lookups do not).
const last = (immich, path) => immich.calls.filter((call) => call.pathname === path && (call.body?.withExif || path.endsWith('smart'))).at(-1);

describe('photo routes', () => {
  test('are off, without any upstream call, when Immich is not configured', async () => {
    const immich = fakeImmich();
    const { app } = appWith({ env: { IMMICH_URL: '' }, immich });
    const status = await request(app).get('/api/photos/status').expect(200);
    expect(status.body.data).toEqual({ enabled: false, descriptionWriteEnabled: false });
    expect((await request(app).get('/api/photos/search/smart?q=beach').expect(503)).body.code).toBe('PHOTOS_NOT_CONFIGURED');
    expect(immich.fetchImpl).not.toHaveBeenCalled();
  });

  test('smart search fills the people Immich leaves out and keeps paths and key private', async () => {
    const { app, immich } = appWith();
    const response = await request(app).get('/api/photos/search/smart?q=at%20the%20beach&person=berenice&limit=500')
      .set('x-service-caller', 'test-agent').expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(last(immich, '/api/search/smart').body).toMatchObject({ query: 'at the beach', size: 50, withExif: true });
    const items = response.body.data.items;
    expect(items.map((item) => item.id)).toEqual([A.city, A.pending]);
    expect(items[0].people).toEqual(['Alice Example', 'Bérénice Test']);
    expect(items[0]).toMatchObject({ city: 'Saint-Élan–Nord', state: 'Example State', thumbnail: `/api/photos/assets/${A.city}/thumbnail` });
    expect(JSON.stringify(response.body)).not.toContain('/library/private');
    expect(JSON.stringify(response.body)).not.toContain(KEY);
  });

  test('a person with two face groups under one name matches either group', async () => {
    const { app, immich } = appWith();
    const response = await request(app).get('/api/photos/search?person=alice%20example').expect(200);
    expect(last(immich, '/api/search/metadata').body.filter.or).toEqual([
      { personIds: { all: [P.alice] } }, { personIds: { all: [P.alice2] } },
    ]);
    expect(response.body.data.items.map((item) => item.id).sort()).toEqual([A.beach, A.city].sort());
    const both = await request(app).get('/api/photos/search?person=alice,berenice%20test').expect(200);
    expect(both.body.data.items.map((item) => item.id)).toEqual([A.city]);
  });

  test('a first name finds the one person it designates, and asks back when several share it', async () => {
    const { app } = appWith();
    const bob = await request(app).get('/api/photos/search?person=BERENICE').expect(200);
    expect(bob.body.data.items.map((item) => item.id).sort()).toEqual([A.city, A.pending].sort());
    const ambiguous = await request(app).get('/api/photos/search?person=jordan').expect(409);
    expect(ambiguous.body.code).toBe('PHOTOS_PERSON_AMBIGUOUS');
    expect(ambiguous.body.error.details.candidates).toEqual(['Jordan Example', 'Jordan Sample']);
    await request(app).get('/api/photos/search?person=jordan%20example').expect(200);
    const unknown = await request(app).get('/api/photos/search?person=Nobody').expect(404);
    expect(unknown.body.code).toBe('PHOTOS_PERSON_UNKNOWN');
  });

  test('places match without accents, case or dash variants, and an unknown place proposes close names', async () => {
    const { app, immich } = appWith();
    const response = await request(app).get('/api/photos/search?city=saint-elan-nord').expect(200);
    expect(last(immich, '/api/search/metadata').body.filter.city).toEqual({ eq: 'Saint-Élan–Nord' });
    expect(response.body.data.items.map((item) => item.id)).toEqual([A.city]);
    expect(response.body.data.placeCoverage).toEqual({ photosWithPlace: 2, photos: 4,
      note: 'Photos without GPS have no place and never match a place filter.' });
    const state = await request(app).get('/api/photos/search?state=example%20STATE').expect(200);
    expect(state.body.data.count).toBe(2);
    const sameName = await request(app).get('/api/photos/count?city=example%20state').expect(200);
    expect(sameName.body.data.notes).toEqual(['"Example State" is also a state or province; use state=Example State for the whole region.']);
    const unknown = await request(app).get('/api/photos/search?city=Saint-Elmo').expect(404);
    expect(unknown.body.code).toBe('PHOTOS_PLACE_UNKNOWN');
    expect(unknown.body.error.details.candidates).toEqual(expect.arrayContaining(['Saint-Élan–Nord', 'Saint-Élan']));
  });

  test('tags match by full path or last part', async () => {
    const { app, immich } = appWith();
    const response = await request(app).get('/api/photos/search?tag=ETE').expect(200);
    expect(last(immich, '/api/search/metadata').body.filter.tagIds).toEqual({ all: [T.summer] });
    expect(response.body.data.items.map((item) => item.id).sort()).toEqual([A.beach, A.pending].sort());
    await request(app).get('/api/photos/search?tag=AgentX/Saison/été').expect(200);
    expect((await request(app).get('/api/photos/search?tag=hiver').expect(404)).body.code).toBe('PHOTOS_TAG_UNKNOWN');
  });

  test('years follow the household calendar, not UTC', async () => {
    const { app, immich } = appWith();
    const response = await request(app).get('/api/photos/search?year=2025').expect(200);
    expect(last(immich, '/api/search/metadata').body.filter.takenAt)
      .toEqual({ gte: '2025-01-01T05:00:00.000Z', lt: '2026-01-01T05:00:00.000Z' });
    // Taken on Dec 31 at 21:00 in Toronto, which is already January 1 in UTC.
    expect(response.body.data.items.map((item) => item.id).sort()).toEqual([A.beach, A.city].sort());
  });

  test('count uses Immich statistics when allowed', async () => {
    const { app } = appWith({ immich: fakeImmich({ statistics: 'ok' }) });
    const response = await request(app).get('/api/photos/count?person=berenice').expect(200);
    expect(response.body.data).toEqual({ total: 2, exact: true });
  });

  test('count never calls a full page without a cursor exact', async () => {
    const fetchImpl = jest.fn(async (url) => (new URL(url).pathname === '/api/search/statistics' ? json({}, 403)
      : json({ assets: { items: Array.from({ length: 1000 }, (_, n) => ({ id: n })), nextCursor: null } })));
    const client = createImmichClient({ env: { IMMICH_URL: 'http://immich.test', IMMICH_API_KEY_FILE: '/k' }, fetchImpl, readFile: () => KEY });
    const app = express();
    app.use('/api/photos', createPhotoRoutes({ service: createPhotoService({ client }) }));
    expect((await request(app).get('/api/photos/count').expect(200)).body.data).toEqual({ total: 1000, exact: false });
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)[1].body).orderBy).toEqual({ direction: 'desc' });
  });

  test('count pages through the search when the key lacks asset.statistics', async () => {
    const { app, immich } = appWith();
    const response = await request(app).get('/api/photos/count?year=2025').expect(200);
    expect(response.body.data).toEqual({ total: 2, exact: true });
    expect(immich.calls.some((call) => call.pathname === '/api/search/metadata' && call.body.size === 1000)).toBe(true);
  });

  test('metadata search maps text, OCR, order and cursor', async () => {
    const { app, immich } = appWith();
    const response = await request(app)
      .get('/api/photos/search?text=Picnic&ocr=welcome&from=2024-06&to=2025-08&order=asc&cursor=abc&limit=5').expect(200);
    expect(last(immich, '/api/search/metadata').body).toEqual({
      size: 5, withExif: true, withPeople: true, orderBy: { direction: 'asc' }, cursor: 'abc',
      filter: { description: { like: 'Picnic' }, ocr: { matches: 'welcome' },
        takenAt: { gte: '2024-06-01T04:00:00.000Z', lt: '2025-09-01T04:00:00.000Z' } },
    });
    expect(response.body.data.nextCursor).toBeNull();
  });

  test('the family audience sees timeline photos only and no unreviewed generated text', async () => {
    const { app, immich } = appWith();
    const owner = await request(app).get('/api/photos/search').expect(200);
    expect(owner.body.data.items.map((item) => item.id)).toContain(A.hidden);
    expect(owner.body.data.items.find((item) => item.id === A.pending).description).toBe('Generated: kids at a fair');
    const family = await request(app).get('/api/photos/search?audience=family').expect(200);
    expect(last(immich, '/api/search/metadata').body.filter).toEqual({ visibility: { eq: 'timeline' } });
    expect(family.body.data.items.map((item) => item.id)).not.toContain(A.hidden);
    expect(family.body.data.items.find((item) => item.id === A.pending).description).toBeNull();
    expect(family.body.data.items.find((item) => item.id === A.beach).description).toBe('Picnic at the beach');

    const detail = await request(app).get(`/api/photos/assets/${A.pending}?audience=family`).expect(200);
    expect(detail.body.data).toMatchObject({ description: null, reviewPending: true, tags: ['Famille'] });
    const ownerDetail = await request(app).get(`/api/photos/assets/${A.pending}`).expect(200);
    expect(ownerDetail.body.data.tags).toEqual(['AgentX/Relecture/à relire', 'AgentX/Saison/été', 'Famille']);
    await request(app).get(`/api/photos/assets/${A.hidden}?audience=family`).expect(404);
    await request(app).get(`/api/photos/assets/${A.hidden}/thumbnail?audience=family`).expect(404);
    const tags = await request(app).get('/api/photos/tags?audience=family').expect(200);
    expect(tags.body.data.tags).not.toContain('AgentX/Relecture/à relire');
    await request(app).get('/api/photos/search?audience=kids').expect(400);
  });

  test('people lists named people and says why photo counts are missing', async () => {
    const { app } = appWith();
    const plain = await request(app).get('/api/photos/people').expect(200);
    expect(plain.body.data).toMatchObject({ count: 5, unnamed: 1 });
    const counted = await request(app).get('/api/photos/people?counts=true').expect(200);
    expect(counted.body.data.countsAvailable).toBe(false);
    expect(counted.body.data.countsUnavailableReason).toMatch(/person\.statistics/);
  });

  test('people counts come from Immich statistics when the key allows it', async () => {
    const { app } = appWith({ immich: fakeImmich({ personStatistics: 'ok' }) });
    const counted = await request(app).get('/api/photos/people?counts=true').expect(200);
    expect(counted.body.data.countsAvailable).toBe(true);
    expect(counted.body.data.people.every((p) => p.photoCount === 12)).toBe(true);
  });

  test('places lists what Immich geocoded', async () => {
    const { app } = appWith();
    const response = await request(app).get('/api/photos/places').expect(200);
    expect(response.body.data).toEqual({ cities: ['Sampleton', 'Saint-Élan–Nord', 'Saint-Élan', 'Example State'],
      states: ['Example State'], countries: ['Exampleland'] });
  });

  test('assets of a person filter by that person id', async () => {
    const { app, immich } = appWith();
    await request(app).get(`/api/photos/people/${P.bob}/assets?year=2025`).expect(200);
    expect(last(immich, '/api/search/metadata').body.filter.personIds).toEqual({ all: [P.bob] });
  });

  test('asset details are compact and carry place, people, tags, description and OCR text', async () => {
    const { app } = appWith();
    const response = await request(app).get(`/api/photos/assets/${A.beach}`).expect(200);
    expect(response.body.data).toEqual({
      id: A.beach, type: 'image', takenAt: '2025-07-14T19:00:00.000Z', timeZone: 'America/Toronto',
      fileName: 'IMG_0001.jpg',
      place: { city: 'Sampleton', state: 'Example State', country: 'Exampleland', coordinates: { latitude: 45.12346, longitude: -73.76543 } },
      people: [{ id: P.alice, name: 'Alice Example' }, { id: P.unnamed, name: null }],
      description: 'Picnic at the beach', reviewPending: false, tags: ['AgentX/Saison/été'],
      ocrText: 'WELCOME TO\nBEACH', camera: 'Synthetic Cam 1', width: 4000, height: 3000, favorite: true,
      thumbnail: `/api/photos/assets/${A.beach}/thumbnail`, preview: `/api/photos/assets/${A.beach}/thumbnail?size=preview`,
    });
  });

  test('asset details still answer when OCR is absent', async () => {
    const { app } = appWith({ immich: fakeImmich({ ocr: 'missing' }) });
    expect((await request(app).get(`/api/photos/assets/${A.beach}`).expect(200)).body.data.ocrText).toBeNull();
  });

  test('thumbnail proxy returns the image bytes', async () => {
    const { app, immich } = appWith();
    const response = await request(app).get(`/api/photos/assets/${A.beach}/thumbnail?size=preview`).expect(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(response.body).toString()).toBe('synthetic-jpeg');
    expect(immich.calls.at(-1).search).toBe('size=preview');
    await request(app).get(`/api/photos/assets/${A.beach}/thumbnail?size=original`).expect(400);
  });

  test('an unknown asset is a 404 and malformed input never reaches Immich', async () => {
    const { app, immich } = appWith();
    expect((await request(app).get(`/api/photos/assets/${id('f')}`).expect(404)).body.code).toBe('PHOTOS_NOT_FOUND');
    const before = immich.calls.length;
    await request(app).get('/api/photos/search/smart').expect(400);
    await request(app).get('/api/photos/search/smart?q=x&from=2025-02-30').expect(400);
    await request(app).get('/api/photos/search/smart?q=x&personId=../../admin').expect(400);
    expect(immich.calls.length).toBe(before);
  });

  test('a wrong key surfaces as an upstream permission error', async () => {
    const immich = fakeImmich();
    const client = createImmichClient({ env: { IMMICH_URL: 'http://immich.test', IMMICH_API_KEY_FILE: '/k' },
      fetchImpl: immich.fetchImpl, readFile: () => 'wrong-key' });
    const app = express();
    app.use('/api/photos', createPhotoRoutes({ service: createPhotoService({ client }) }));
    expect((await request(app).get('/api/photos/people').expect(502)).body.code).toBe('PHOTOS_UPSTREAM_FORBIDDEN');
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
    expect((await request(app).put(`/api/photos/assets/${A.beach}/description`).send({ description: 'x' }).expect(403)).body.code)
      .toBe('PHOTOS_WRITE_DISABLED');
    expect(immich.fetchImpl).not.toHaveBeenCalled();
  });

  test('setting a description writes only the description when the flag is on', async () => {
    const { app, immich, log } = appWith({ env: { IMMICH_DESCRIPTION_WRITE_ENABLED: 'true' } });
    await request(app).put(`/api/photos/assets/${A.beach}/description`).set('x-service-caller', 'test-agent')
      .send({ description: '  Family picnic  ' }).expect(200);
    const write = immich.calls.find((call) => call.method === 'PUT');
    expect(write.pathname).toBe(`/api/assets/${A.beach}`);
    expect(write.body).toEqual({ description: 'Family picnic' });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('test-agent'));
    await request(app).put(`/api/photos/assets/${A.beach}/description`).send({ description: 'x'.repeat(2001) }).expect(400);
  });
});

describe('photo helpers', () => {
  test('date bounds cover whole periods of the household calendar, across time changes', () => {
    expect(dateBound('2025-02', 'to', 'America/Toronto')).toEqual({ lt: '2025-03-01T05:00:00.000Z' });
    expect(dateBound('2025-07-14', 'from', 'America/Toronto')).toEqual({ gte: '2025-07-14T04:00:00.000Z' });
    expect(dateBound('2025-12-31', 'to', 'UTC')).toEqual({ lt: '2026-01-01T00:00:00.000Z' });
    expect(dateBound('2025-03-04T10:00:00Z', 'from')).toEqual({ gte: '2025-03-04T10:00:00.000Z' });
    expect(zonedMidnight(2025, 2, 9, 'America/Toronto').toISOString()).toBe('2025-03-09T05:00:00.000Z');
    expect(zonedMidnight(2025, 2, 10, 'America/Toronto').toISOString()).toBe('2025-03-10T04:00:00.000Z');
  });

  test('the key file accepts a bare key or JSON, and never an empty one', () => {
    expect(readApiKey('/k', () => ' bare-key \n')).toBe('bare-key');
    expect(readApiKey('/k', () => '{"key":"json-key"}')).toBe('json-key');
    expect(() => readApiKey('/k', () => '{"url":"x"}')).toThrow(expect.objectContaining({ code: 'PHOTOS_KEY_UNAVAILABLE' }));
    expect(() => readApiKey('/k', () => { throw new Error('ENOENT'); })).toThrow(expect.objectContaining({ code: 'PHOTOS_KEY_UNAVAILABLE' }));
  });
});
