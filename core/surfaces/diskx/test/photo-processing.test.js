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
