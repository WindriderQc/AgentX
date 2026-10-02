'use strict';

// The full Core app without AGENTX_PARENTAL_CODE: the code set from the host
// opens the same adult session for Household and PsyX through the gateway.
delete process.env.AGENTX_PARENTAL_CODE;
delete process.env.PSYX_ACCESS_TOKEN;
process.env.PSYX_ACCESS_MODE = 'token';
process.env.PSYX_LOOPBACK_BYPASS = 'false';
const request = require('supertest');
const mongoose = require('mongoose');
const { app } = require('../../src/app');

const edge = pending => pending.set('X-AgentX-Entry', 'household');

test('a code set on the host unlocks the shared adult session, PsyX included', async () => {
  await mongoose.connection.collection('access_parental_code').deleteMany({});
  await edge(request(app).post('/api/psyx/auth/unlock')).send({ code: '4826' }).expect(503);
  await edge(request(app).post('/api/access/code/setup')).send({ code: '4826', confirm: '4826' }).expect(403);
  await request(app).post('/api/access/code/setup').send({ code: '4826', confirm: '4826' }).expect(200);

  const unlocked = await edge(request(app).post('/api/psyx/auth/unlock')).send({ code: '4826' }).expect(200);
  const cookie = unlocked.headers['set-cookie'][0].split(';')[0];
  const status = await edge(request(app).get('/api/psyx/auth/status')).set('Cookie', cookie).expect(200);
  expect(status.body.data).toMatchObject({ unlocked: true, configured: true });
  await edge(request(app).get('/dad')).set('Cookie', cookie).expect(200);
  await edge(request(app).get('/access/code')).set('Cookie', cookie).expect(200);
  // Bearer access stays with AGENTX_PARENTAL_CODE; the stored code opens sessions only.
  await request(app).get('/api/access/authorize').set('Authorization', 'Bearer 4826').expect(401);
});
