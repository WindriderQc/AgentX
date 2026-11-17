'use strict';
const express = require('express');
const request = require('supertest');
const { createPhotoRoutes } = require('../../routes/photos');
const { createPhotoFrameService, loadFrameConfig } = require('../../src/services/photos/photoFrameService');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const source = '/external/frame';
const asset = () => ({ id: ID, type: 'IMAGE', visibility: 'timeline', originalPath: source + '/nested/example.jpg' });
test('reviewed album membership adds imported images and is checked again before serving pixels', async () => {
  const albumId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', imported = { ...asset(), originalPath: '/imports/new.jpg' };
  let selected = true;
  const client = { settings: () => ({ enabled: true }), image: jest.fn(async () => ({ bytes: Buffer.from('preview'), contentType: 'image/jpeg' })),
    json: jest.fn(async p => p === '/search/random' ? [imported] : p === '/search/metadata' ? { assets: { items: selected ? [imported] : [] } } : imported) };
  const frame = createPhotoFrameService({ client, config: () => ({ prefix: source, albumId }) });
  expect((await frame.next()).id).toBe(ID);
  expect(client.json.mock.calls[0][1].body.filter.or).toEqual([{ originalPath: { startsWith: source+'/' } }, { albumIds: { any: [albumId] } }]);
  selected = false;
  await expect(frame.image(ID)).rejects.toMatchObject({ code: 'PHOTOS_NOT_FOUND' });
  expect(client.image).not.toHaveBeenCalled();
});
test('album selection excludes the legacy directory, and removed members cannot use a cached image URL', async () => {
  const albumId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let member = true;
  const client = { settings: () => ({ enabled: true }), image: jest.fn(async () => ({ bytes: Buffer.from('preview'), contentType: 'image/jpeg' })),
    json: jest.fn(async p => p === '/search/random' ? [asset()] : p === '/search/metadata' ? { assets: { items: member ? [asset()] : [] } } : asset()) };
  const frame = createPhotoFrameService({ client, config: () => ({ prefix: source, albumId, source: 'album' }) });
  expect((await frame.next()).id).toBe(ID);
  expect(client.json.mock.calls[0][1].body.filter).toMatchObject({ albumIds: { any: [albumId] } });
  expect(client.json.mock.calls[0][1].body.filter).not.toHaveProperty('or');
  expect(client.json.mock.calls[0][1].body.filter).not.toHaveProperty('originalPath');
  member = false;
  await expect(frame.image(ID)).rejects.toMatchObject({ code: 'PHOTOS_NOT_FOUND' });
  await expect(frame.next()).rejects.toMatchObject({ code: 'PHOTO_FRAME_INVALID_RESULT' });
  expect(client.image).not.toHaveBeenCalled();
});
function fixture({ row = asset(), configured = true, rows } = {}) {
  const client = {
    settings: () => ({ enabled: true }),
    json: jest.fn(async url => url === '/search/random' ? (rows || [row]) : row),
    image: jest.fn(async () => ({ bytes: Buffer.from('fixture-image'), contentType: 'image/jpeg' }))
  };
  const frame = createPhotoFrameService({ client, config: () => configured ? { prefix: source, idleSeconds: 120, intervalSeconds: 30 } : null });
  const app = express(); app.use('/api/photos', createPhotoRoutes({ frame, service: {} }));
  return { app, client, frame };
}
test('disabled frame makes no upstream call and leaks no configured path', async () => {
  const { app, client } = fixture({ configured: false });
  expect((await request(app).get('/api/photos/frame/status')).body.data).toEqual({ enabled: false });
  expect((await request(app).get('/api/photos/frame/next')).status).toBe(503);
  expect(client.json).not.toHaveBeenCalled();
});
test('one native random request is confined to the configured directory and timeline images', async () => {
  const { app, client } = fixture();
  const result = await request(app).get('/api/photos/frame/next?originalPathPrefix=/other&audience=owner');
  expect(result.status).toBe(200);
  expect(result.body.data).toEqual({ id: ID, src: '/api/photos/frame/' + ID + '/image' });
  expect(result.text).not.toContain(source);
  expect(client.json).toHaveBeenCalledTimes(1);
  expect(client.json).toHaveBeenCalledWith('/search/random', { method: 'POST', body: { size: 1, filter: {
    originalPath: { startsWith: source + '/' }, type: { eq: 'IMAGE' }, visibility: { eq: 'timeline' },
    isOffline: { eq: false }, trashedAt: { eq: null }
  } } });
  expect(result.headers['cache-control']).toBe('private, no-store');
});
test('previous image is excluded upstream without another draw', async () => {
  const { app, client } = fixture({ rows: [] });
  expect((await request(app).get('/api/photos/frame/next?exclude=' + ID)).body.data).toBeNull();
  expect(client.json.mock.calls[0][1].body.filter.id).toEqual({ ne: ID });
  expect(client.json).toHaveBeenCalledTimes(1);
});
test.each([
  { originalPath: source + '-private/example.jpg' }, { originalPath: source + '/../other/a.jpg' },
  { visibility: 'hidden' }, { visibility: 'locked' }, { type: 'VIDEO' }, { isTrashed: true }, { isOffline: true }
])('unexpected upstream result is refused: %j', async override => {
  const { app, client } = fixture({ row: { ...asset(), ...override } });
  expect((await request(app).get('/api/photos/frame/next')).status).toBe(502);
  expect((await request(app).get('/api/photos/frame/' + ID + '/image')).status).toBe(404);
  expect(client.image).not.toHaveBeenCalled();
});
test('image proxy rechecks membership and serves only the preview', async () => {
  const { app, client } = fixture();
  const result = await request(app).get('/api/photos/frame/' + ID + '/image');
  expect(result.status).toBe(200);
  expect(result.headers['content-type']).toMatch(/^image\/jpeg/);
  expect(client.json).toHaveBeenCalledWith('/assets/' + ID);
  expect(client.image).toHaveBeenCalledWith('/assets/' + ID + '/thumbnail?size=preview');
});
test('invalid ids are refused before any upstream operation', async () => {
  const { app, client } = fixture();
  expect((await request(app).get('/api/photos/frame/next?exclude=invalid')).status).toBe(400);
  expect((await request(app).get('/api/photos/frame/invalid/image')).status).toBe(400);
  expect(client.json).not.toHaveBeenCalled();
});
test('an oversized random answer is refused without publishing its items', async () => {
  const { app } = fixture({ rows: [asset(), asset()] });
  const result = await request(app).get('/api/photos/frame/next');
  expect(result.status).toBe(502); expect(result.body.data).toBeUndefined();
});
test('instance configuration is bounded and rejects unconfined or malformed directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-frame-config-'));
  fs.mkdirSync(path.join(dir, 'config'));
  const file = path.join(dir, 'config/photo-frame.json'), env = { AGENTX_INSTANCE_ROOT: dir };
  try {
    expect(loadFrameConfig({})).toBeNull(); expect(loadFrameConfig(env)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 1, originalPathPrefix: source }));
    expect(loadFrameConfig(env)).toEqual({ prefix: source, idleSeconds: 120, intervalSeconds: 30 });
    const albumId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    fs.writeFileSync(file, JSON.stringify({ version: 1, originalPathPrefix: source, source: 'album', albumId }));
    expect(loadFrameConfig(env)).toMatchObject({ source: 'album', albumId });
    for (const extra of [{ source: 'album' }, { source: 'unknown', albumId }, { source: {}, albumId }]) {
      fs.writeFileSync(file, JSON.stringify({ version: 1, originalPathPrefix: source, ...extra }));
      expect(() => loadFrameConfig(env)).toThrow('not configured');
    }
    for (const prefix of ['/', 'relative', source + '/', source + '/../other', '/a\\b']) {
      fs.writeFileSync(file, JSON.stringify({ version: 1, originalPathPrefix: prefix }));
      expect(() => loadFrameConfig(env)).toThrow('not configured');
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, originalPathPrefix: source, idleSeconds: 1 }));
    expect(() => loadFrameConfig(env)).toThrow('not configured');
    fs.writeFileSync(file, 'null');
    expect(() => loadFrameConfig(env)).toThrow('not configured');
    fs.writeFileSync(file, ' '.repeat(4097));
    expect(() => loadFrameConfig(env)).toThrow('not configured');
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('recent window chooses unseen or least-recent image without altering scope',async()=>{
 const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
 const {frame,client}=fixture({rows:ids.map(id=>({...asset(),id}))});
 expect((await frame.next(undefined,ids.slice(0,2).join(','))).id).toBe(ids[2]);
 expect(client.json.mock.calls[0][1].body.size).toBe(3);
 expect((await frame.next(undefined,[ids[1],ids[2],ids[0]].join(','))).id).toBe(ids[1]);
 expect(client.json.mock.calls[0][1].body.filter.originalPath).toEqual({startsWith:source+'/'});
});
test.each(['bad',Array(201).fill(ID).join(','),{id:ID}])('invalid history rejects before I/O %j',async recent=>{
 const {frame,client}=fixture();await expect(frame.next(undefined,recent)).rejects.toMatchObject({code:'PHOTOS_BAD_REQUEST'});expect(client.json).not.toHaveBeenCalled();
});
test('duplicate upstream records and ignored immediate exclusion fail closed',async()=>{
 await expect(fixture({rows:[asset(),asset()]}).frame.next(undefined,ID)).rejects.toMatchObject({code:'PHOTO_FRAME_INVALID_RESULT'});
 await expect(fixture().frame.next(ID)).rejects.toMatchObject({code:'PHOTO_FRAME_INVALID_RESULT'});
});
test('history cannot make an out-of-scope image eligible',async()=>{
 const {frame}=fixture({row:{...asset(),originalPath:'/private/other.jpg'}});
 await expect(frame.next(undefined,ID)).rejects.toMatchObject({code:'PHOTO_FRAME_INVALID_RESULT'});
});
test('bounded history does not create global shared state',async()=>{
 const ids=Array.from({length:200},(_,i)=>i.toString(16).padStart(8,'0')+'-1111-4111-8111-111111111111');const {frame,client}=fixture();
 expect((await frame.next(undefined,ids.join(','))).id).toBe(ID);expect(client.json.mock.calls[0][1].body.size).toBe(201);
 await frame.next();expect(client.json.mock.calls[1][1].body.size).toBe(1);
});
test('route forwards the recent window and rejects structured query injection',async()=>{
 const {app,client}=fixture();const r=await request(app).get('/api/photos/frame/next').query({recent:ID});expect(r.status).toBe(200);expect(client.json.mock.calls[0][1].body.size).toBe(2);
 expect((await request(app).get('/api/photos/frame/next?recent[id]=bad')).status).toBe(400);
});

test('structured previous ID rejects as400 and structured upstream ID rejects as502',async()=>{
 const {app,client}=fixture();expect((await request(app).get('/api/photos/frame/next?exclude[]='+ID)).status).toBe(400);expect(client.json).not.toHaveBeenCalled();
 await expect(fixture({row:{...asset(),id:[ID]}}).frame.next()).rejects.toMatchObject({code:'PHOTO_FRAME_INVALID_RESULT'});
});

test('empty pool stays empty and changed membership can introduce new unseen images',async()=>{
 const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
 const rows=[];const {frame}=fixture({rows});
 expect(await frame.next(undefined,a)).toBeNull();
 rows.push({...asset(),id:b});
 expect((await frame.next(undefined,a)).id).toBe(b);
 rows.length=0;
 expect(await frame.next(undefined,[a,b].join(','))).toBeNull();
});
