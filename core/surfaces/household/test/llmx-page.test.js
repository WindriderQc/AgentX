'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const page = require('../llmx-page');
const { allowedForFamilyDevice } = require('../family-device');
const { createBrowserOriginGuard } = require('../../../../shared/browserOriginGuard');
const { demoSurfaceDisabled } = require('../../../../shared/agentxRuntimeProfile');

const env = { HOUSEHOLD_AVATAR_MODULE_URL: 'https://graphics.example/embed/llmx-face.js' };
function app(fetcher = async () => new Response('export {}', { headers: { 'content-type': 'text/javascript' } })) {
  const app = express();
  app.use(createBrowserOriginGuard());
  app.use((_req, res, next) => { res.set('Content-Security-Policy', "script-src 'self'; connect-src 'self'"); next(); });
  page.register({ app, env, fetchWithTimeout: fetcher });
  return app;
}

test('Core hosts the existing Forge with only same-origin script and no inline code', async () => {
  for (const profile of ['', '?profile=family', '?profile=personal']) {
    const res = await request(app()).get('/llmx' + profile).expect(200);
    assert.match(res.text, /src="\/assets\/household\/llmx-entry.js"/);
    assert.doesNotMatch(res.text, /https?:|<script>/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['content-security-policy'], /'wasm-unsafe-eval'/);
    assert.doesNotMatch(res.headers['content-security-policy'], /'unsafe-eval'/);
  }
  for (const query of ['profile=owner', 'profile=family&profile=personal', 'url=https://evil.example', 'profile=family&run=1']) {
    await request(app()).get('/llmx?' + query).expect(400);
  }
});

test('module uses the configured avatar sibling; scripts reject HTML fallbacks', async () => {
  await request(app(async (url) => {
    assert.equal(url, 'https://graphics.example/embed/llmx-room.js');
    return new Response('export {}', { headers: { 'content-type': 'text/javascript' } });
  })).get('/api/household/llmx/room.js').expect(200);
  await request(app(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })))
    .get('/api/household/llmx/room.js').expect(502);
});

test('graphical asset relay is GET-only, bounded to configured static assets and never forwards credentials', async () => {
  const server = app(async (url, options) => {
    assert.equal(url, 'https://graphics.example/assets/hdri/vignaioli-night_1k.hdr');
    assert.deepEqual(options, { redirect: 'error' });
    return new Response('hdr', { headers: { 'content-type': 'application/octet-stream' } });
  });
  const res = await request(server).get('/api/household/llmx/assets/hdri/vignaioli-night_1k.hdr').set('Authorization', 'Bearer never-forward').expect(200);
  assert.match(res.headers['content-security-policy'], /sandbox/);
  await request(server).post('/api/household/llmx/assets/hdri/vignaioli-night_1k.hdr').expect(404);
  for (const relative of ['../private.json', 'sky/%2e%2e/private.json', 'https://evil.example/a.png', 'evil.js', 'x.svg?x=1']) {
    assert.throws(() => page.assetUrl(relative, env));
  }
  await request(server).get('/api/household/llmx/assets/a.png?url=x').expect(400);
  await assert.rejects(page.readAsset(new Response('x', { headers: { 'content-length': String(page.MAX_ASSET_BYTES + 1) } })), /too large/);
});

test('Family device can enter only the Family Forge and its existing scoped consumer', () => {
  for (const [path, query] of [['/llmx', { profile: 'family' }], ['/api/consumers/nestor/v1/llmx/family/config', {}], ['/api/household/llmx/room.js', {}]]) {
    assert.equal(allowedForFamilyDevice({ method: 'GET', path, query }), true, path);
  }
  for (const [path, query] of [['/llmx', {}], ['/llmx', { profile: 'personal' }], ['/api/consumers/nestor/v1/llmx/config', {}], ['/api/consumers/nestor/v1/llmx/family-other/config', {}], ['/api/diskx/presentation', {}]]) {
    assert.equal(allowedForFamilyDevice({ method: 'GET', path, query }), false, path);
  }
  assert.equal(allowedForFamilyDevice({ method: 'POST', path: '/api/consumers/nestor/v1/llmx/family/sessions', query: {} }), true);
  assert.equal(allowedForFamilyDevice({ method: 'POST', path: '/api/consumers/nestor/v1/llmx/sessions', query: {} }), false);
});

test('the foreign-site POST guard remains active for LLMx', async () => {
  assert.equal(demoSurfaceDisabled('/llmx', 'demo'), true);
  assert.equal(demoSurfaceDisabled('/api/household/llmx/room.js', 'demo'), true);
  await request(app()).post('/api/consumers/nestor/v1/llmx/sessions')
    .set('Origin', 'https://graphics.example').set('Sec-Fetch-Site', 'cross-site').expect(403);
});

test('the actual device middleware retains its pin on the same-origin Forge', async () => {
  const server = express();
  server.use(require('cookie-parser')());
  require('../family-device').register({ app: server,
    mongoose: { models: { AgentXHouseholdFamilyDevice: {
      findOneAndUpdate: () => ({ lean: async () => ({ label: 'Synthetic child device' }) })
    } } },
    ownerUnlock: { activeUntil: async () => null }, standardJsonParser: express.json(),
    envelope: (res, data) => res.json({ ok: true, data }),
    fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
  page.register({ app: server, env });
  server.post('/api/consumers/nestor/v1/llmx/family/sessions', (_req, res) => res.json({ family: true }));
  server.post('/api/consumers/nestor/v1/llmx/sessions', (_req, res) => res.json({ personal: true }));
  const cookie = 'agentx_family_device=synthetic-only';
  await request(server).get('/llmx?profile=family').set('Cookie', cookie).expect(200);
  await request(server).get('/llmx').set('Cookie', cookie).expect(302).expect('Location', '/panel');
  await request(server).post('/api/consumers/nestor/v1/llmx/family/sessions').set('Cookie', cookie).expect(200);
  await request(server).post('/api/consumers/nestor/v1/llmx/sessions').set('Cookie', cookie).expect(403);
});
