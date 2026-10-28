'use strict';
const express = require('express');
const request = require('supertest');
const { createPhotoRoutes } = require('../../routes/photos');
const { createPhotoFrameService, loadFrameConfig } = require('../../src/services/photos/photoFrameService');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const source = '/external/frame';
const asset = () => ({ id: ID, type: 'IMAGE', visibility: 'timeline', originalPath: source + '/nested/example.jpg' });
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
test('instance configuration is bounded and rejects unconfined or malformed directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-frame-config-'));
  fs.mkdirSync(path.join(dir, 'config'));
  const file = path.join(dir, 'config/photo-frame.json'), env = { AGENTX_INSTANCE_ROOT: dir };
  try {
    expect(loadFrameConfig({})).toBeNull(); expect(loadFrameConfig(env)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 1, originalPathPrefix: source }));
    expect(loadFrameConfig(env)).toEqual({ prefix: source, idleSeconds: 120, intervalSeconds: 30 });
    for (const prefix of ['/', 'relative', source + '/', source + '/../other', '/a\\b']) {
      fs.writeFileSync(file, JSON.stringify({ version: 1, originalPathPrefix: prefix }));
      expect(() => loadFrameConfig(env)).toThrow('not configured');
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, originalPathPrefix: source, idleSeconds: 1 }));
    expect(() => loadFrameConfig(env)).toThrow('not configured');
    fs.writeFileSync(file, ' '.repeat(4097));
    expect(() => loadFrameConfig(env)).toThrow('not configured');
  } finally { fs.rmSync(dir, { recursive: true }); }
});
