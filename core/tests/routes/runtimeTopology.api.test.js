'use strict';

jest.mock('../../src/services/runtimeTopologyService', () => ({ describeTopology: jest.fn() }));

const express = require('express');
const request = require('supertest');
const { describeTopology } = require('../../src/services/runtimeTopologyService');
const router = require('../../routes/nerve-center-runtime-topology');

const app = express();
app.use(router);

it('serves the observed topology read-only', async () => {
  describeTopology.mockResolvedValue({ configured: true, valid: true, groups: [{ id: 'dual-gpu', activeMode: 'pooled' }] });
  const response = await request(app).get('/runtime-topology').expect(200);
  expect(response.body).toEqual({ status: 'success', data: { configured: true, valid: true, groups: [{ id: 'dual-gpu', activeMode: 'pooled' }] } });
});

it('answers 500 without internal details when the read fails', async () => {
  describeTopology.mockRejectedValue(new Error('mongo down at private-host'));
  const response = await request(app).get('/runtime-topology').expect(500);
  expect(response.body).toEqual({ status: 'error', code: 'RUNTIME_TOPOLOGY_READ_FAILED', message: 'Runtime topology unavailable' });
});

it('offers no way to change the topology', async () => {
  await request(app).put('/runtime-topology').send({}).expect(404);
  await request(app).post('/runtime-topology').send({}).expect(404);
});
