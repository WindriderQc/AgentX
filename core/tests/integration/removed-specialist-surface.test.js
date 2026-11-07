'use strict';

const request = require('supertest');
const { app } = require('../../src/app');

// Negative boundary coverage only: the public product does not host this role.
test.each([
  ['get', '/psyx'],
  ['get', '/psyx/assets/app.js'],
  ['get', '/psyx/assets/voice-preferences.js'],
  ['get', '/api/psyx/status'],
  ['get', '/api/psyx/state'],
  ['get', '/api/psyx/sessions'],
  ['get', '/api/psyx/toolbox'],
  ['get', '/api/psyx/export'],
  ['get', '/api/psyx/review/status'],
  ['get', '/api/psyx/dream/status'],
  ['get', '/api/psyx/voice/catalog'],
  ['post', '/api/psyx/chat/stream'],
  ['post', '/api/psyx/state/assessments'],
  ['post', '/api/psyx/dream/run'],
])('retired specialist route is absent: %s %s', async (method, path) => {
  const response = await request(app)[method](path).send({}).expect(404);
  expect(response.headers.location).toBeUndefined();
});
