'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express'), request = require('supertest');
const { registerPhotoProcessing } = require('../photo-processing');
const { allowedForFamilyDevice } = require('../../household/family-device');
const { demoSurfaceDisabled } = require('../../../../shared/agentxRuntimeProfile');
test('photo processing is bounded, owner-only and accepts identities instead of upstream paths or credentials', async () => {
  const app = express(), calls = [];
  const service = Object.fromEntries(['page', 'enqueue', 'enqueueRun', 'review', 'frame'].map(op => [op, async value => { calls.push(value); return { accepted: true }; }]));
  service.status = () => ({ configured: true });
  registerPhotoProcessing({ app, express, service });
  await request(app).get('/api/phone-media/processing').expect(200);
  for (const extra of [{ albumId: 'arbitrary' }, { path: '/outside' }, { model: 'arbitrary' }, { key: 'secret' }])
    await request(app).post('/api/phone-media/processing').send({ op: 'enqueueRun', runId: 'synthetic', operationId: 'synthetic', ...extra }).expect(400);
  assert.equal(calls.length, 0);
  await request(app).post('/api/phone-media/processing').send({ op: 'enqueueRun', runId: 'synthetic', operationId: 'synthetic' }).expect(200);
  assert.equal(calls.length, 1);
  assert.equal(allowedForFamilyDevice({ path: '/api/phone-media/processing', method: 'POST' }), false);
  assert.equal(demoSurfaceDisabled('/api/phone-media/processing', 'demo'), true);
});

test('photo control operations keep the owner boundary and reject timed resumes or client-supplied principals', async () => {
  const app = express(), calls = [];
  const service = { status: () => ({ configured: true }),
    control: async () => ({ paused: true, revision: 1 }),
    pause: async (input, principal) => { calls.push({ input, principal }); return { paused: true, revision: 1 }; },
    resume: async (input, principal) => { calls.push({ input, principal }); return { paused: false, revision: 2 }; } };
  registerPhotoProcessing({ app, express, service });
  const publicStatus = await request(app).get('/api/phone-media/processing').expect(200);
  assert.deepEqual(publicStatus.body.data, { configured: true }); // No owner control receipt on the public GET.
  const state = await request(app).post('/api/phone-media/processing').send({ op: 'control' }).expect(200);
  assert.equal(state.body.data.paused, true);
  const body = { requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expectedRevision: 0 };
  for (const extra of [{ resumeAt: '2099-01-01' }, { principal: 'forged' }, { expiresAt: '2099-01-01' }])
    await request(app).post('/api/phone-media/processing').send({ op: 'pause', ...body, ...extra }).expect(400);
  assert.equal(calls.length, 0);
  await request(app).post('/api/phone-media/processing').set('x-service-caller', 'fixture-operator').send({ op: 'pause', ...body }).expect(200);
  assert.deepEqual(calls[0], { input: body, principal: 'fixture-operator' });
  assert.equal(allowedForFamilyDevice({ path: '/api/phone-media/processing', method: 'POST' }), false);
  assert.equal(demoSurfaceDisabled('/api/phone-media/processing', 'demo'), true);
});
