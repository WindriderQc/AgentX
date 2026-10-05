'use strict';
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { registerLegacyHumanAccess } = require('../../src/middleware/legacyHumanAccess');
const { app } = require('../../src/app');

const env = { CORE_PUBLIC_URL: 'https://home.example', BENCHMARK_PUBLIC_URL: 'https://home.example:3081',
  RAG_PUBLIC_URL: 'https://home.example:3082', DATAAPI_PUBLIC_URL: 'https://home.example:3083' };
function fixture() {
  const app = express(); app.use(cookieParser());
  registerLegacyHumanAccess({ app, env });
  app.get('/dad', (_req, res) => res.send('Nestor'));
  return app;
}

test('old bookmarks return directly to a bounded destination without a code', async () => {
  const gateway = fixture();
  for (const page of ['/unlock', '/access/code', '/access/face']) {
    await request(gateway).get(page).expect(302).expect('Location', '/dad');
    await request(gateway).get(page + '?next=%2Fpanel').expect(302).expect('Location', '/panel');
  }
  for (const target of ['/', '/dad?tab=notes#recent', ...Object.values(env).map(origin => origin + '/?tab=synthetic')]) {
    await request(gateway).get('/unlock').query({ next: target }).expect(302).expect('Location', target);
  }
});

test('old cookies are expired once when supplied and never create a session', async () => {
  const gateway = fixture();
  const response = await request(gateway).get('/dad').set('X-Forwarded-Proto', 'https')
    .set('Cookie', 'agentx_adult=expired; psyx_session=expired; dsh_studio=independent').expect(200);
  expect(response.headers['set-cookie']).toHaveLength(2);
  for (const cookie of response.headers['set-cookie']) {
    expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain('dsh_studio');
  }
  const fresh = await request(gateway).get('/dad').expect(200);
  expect(fresh.headers['set-cookie']).toBeUndefined();
});

test('retired code, face and forward-auth APIs are absent at the real Core app', async () => {
  for (const [method, path] of [
    ['get', '/api/access/session'], ['get', '/api/access/authorize'], ['post', '/api/access/unlock'],
    ['post', '/api/access/lock'], ['post', '/api/access/code/setup'], ['post', '/api/access/code/change'],
    ['get', '/api/access/face/status'], ['post', '/api/access/face/challenge'], ['post', '/api/access/face/frame'],
    ['get', '/api/access/face/enrollment'], ['post', '/api/access/face/enrollment/samples'], ['delete', '/api/access/face/enrollment'],
    ['get', '/api/psyx/auth/status'], ['post', '/api/psyx/auth/unlock'], ['post', '/api/psyx/auth/lock']
  ]) {
    const response = await request(app)[method](path).send({}).expect(404);
    expect(response.headers.location).toBeUndefined();
  }
  await request(app).get('/access-assets/client.js').expect(404);
});
