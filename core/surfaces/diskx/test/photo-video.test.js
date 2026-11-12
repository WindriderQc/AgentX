'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express'), request = require('supertest');
const { createPhotoRoutes } = require('../../../routes/photos');
const { createPhotoService } = require('../../../src/services/photos/photoService');
const { createImmichClient } = require('../../../src/services/photos/immichClient');
const { allowedForFamilyDevice } = require('../../household/family-device');
const { demoSurfaceDisabled } = require('../../../../shared/agentxRuntimeProfile');
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture({ asset = { type: 'VIDEO', visibility: 'timeline', libraryId: 'imports' }, status = 206, mime = 'video/mp4' } = {}) {
  const calls = [];
  const client = createImmichClient({
    env: { IMMICH_URL: 'http://gallery.test', IMMICH_API_KEY_FILE: '/synthetic-key' },
    readFile: () => 'synthetic-key',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/video/playback')) return new Response('video', { status, headers: {
        'content-type': mime, 'content-length': '5', 'content-range': 'bytes 0-4/100', 'accept-ranges': 'bytes',
      } });
      return new Response(JSON.stringify(asset), { headers: { 'content-type': 'application/json' } });
    },
  });
  const service = createPhotoService({ client, processingConfig: () => ({ libraryId: 'imports' }) });
  const app = express(); app.use('/api/photos', createPhotoRoutes({ service }));
  return { app, calls };
}
test('video playback forwards a single range, streams bytes and keeps credentials in Core', async () => {
  const { app, calls } = fixture();
  const response = await request(app).get(`/api/photos/assets/${id}/video`).set('Range', 'bytes=0-4').expect(206);
  assert.equal(response.headers['content-range'], 'bytes 0-4/100');
  assert.equal(response.headers['content-type'], 'video/mp4');
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['x-api-key'], undefined);
  assert.equal(calls[1].init.headers.range, 'bytes=0-4');
  assert.equal(calls[1].init.headers['x-api-key'], 'synthetic-key');
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(calls[1].init.signal.aborted, true, 'response close releases the upstream stream');
  assert.equal(Buffer.from(response.body).toString(), 'video');
});
test('family reads exclude private imports and hidden videos; pinned/demo devices cannot use playback', async () => {
  for (const asset of [{ type: 'VIDEO', visibility: 'hidden' }, { type: 'VIDEO', visibility: 'timeline', libraryId: 'imports' }, { type: 'IMAGE', visibility: 'timeline' }]) {
    const { app, calls } = fixture({ asset });
    await request(app).get(`/api/photos/assets/${id}/video?audience=family`).expect(404);
    assert.equal(calls.length, 1);
  }
  assert.equal(allowedForFamilyDevice({ path: `/api/photos/assets/${id}/video`, method: 'GET' }), false);
  assert.equal(demoSurfaceDisabled(`/api/photos/assets/${id}/video`, 'demo'), true);
  const { app } = fixture({ asset: { type: 'VIDEO', visibility: 'timeline' } });
  await request(app).get(`/api/photos/assets/${id}/video?audience=family`).expect(206);
});
test('malformed identity, multiple ranges, upstream errors and non-video bodies refuse safely', async () => {
  const { app, calls } = fixture();
  await request(app).get('/api/photos/assets/not-an-id/video').expect(400);
  assert.equal(calls.length, 0);
  await request(app).get(`/api/photos/assets/${id}/video`).set('Range', 'bytes=0-4,10-20').expect(400);
  assert.equal(calls.length, 1, 'invalid range never reaches playback');
  for (const options of [{ status: 404 }, { mime: 'text/html' }])
    await request(fixture(options).app).get(`/api/photos/assets/${id}/video`).expect(502);
  await request(fixture({ status: 416 }).app).get(`/api/photos/assets/${id}/video`).expect(416);
});
