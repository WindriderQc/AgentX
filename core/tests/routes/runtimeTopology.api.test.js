'use strict';

jest.mock('../../src/services/runtimeTopologyService', () => ({ describeTopology: jest.fn() }));
const mockService = {
  request: jest.fn(), get: jest.fn(), recent: jest.fn(async () => []), present: record => record
};
jest.mock('../../src/services/runtimeTopologySwitchService', () => ({ getTopologySwitchService: () => mockService }));
jest.mock('../../src/services/runtimeTopologyActuator', () => ({
  createActuatorClient: () => ({ configured: groupId => groupId === 'dual-gpu' })
}));
jest.mock('../../src/services/runtimeTopologyParking', () => ({
  defaultParking: {
    intendedMode: () => 'pooled', switchInProgress: () => null,
    parkedHosts: () => [{ url: 'http://gpu:11437', groupId: 'dual-gpu', reason: 'inactive_topology_mode' }]
  }
}));

const express = require('express');
const request = require('supertest');
const { describeTopology } = require('../../src/services/runtimeTopologyService');
const router = require('../../routes/nerve-center-runtime-topology');

const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => {
  jest.clearAllMocks();
  mockService.recent.mockResolvedValue([]);
});

it('serves the observed topology with each group\'s switch state', async () => {
  describeTopology.mockResolvedValue({ configured: true, valid: true, groups: [{ id: 'dual-gpu', activeMode: 'pooled' }] });
  mockService.recent.mockResolvedValue([{ requestId: 'sw-1', state: 'active' }]);
  const response = await request(app).get('/runtime-topology').expect(200);
  expect(response.body.data.groups[0]).toEqual({ id: 'dual-gpu', activeMode: 'pooled', switch: {
    actuatorConfigured: true, intendedMode: 'pooled', inProgress: null, last: { requestId: 'sw-1', state: 'active' } } });
  expect(response.body.data.parkedHosts).toHaveLength(1);
});

it('leaves an undeclared topology as it was', async () => {
  describeTopology.mockResolvedValue({ configured: false, valid: true, groups: [] });
  const response = await request(app).get('/runtime-topology').expect(200);
  expect(response.body).toEqual({ status: 'success', data: { configured: false, valid: true, groups: [] } });
});

it('answers 500 without internal details when the read fails', async () => {
  describeTopology.mockRejectedValue(new Error('mongo down at private-host'));
  const response = await request(app).get('/runtime-topology').expect(500);
  expect(response.body).toEqual({ status: 'error', code: 'RUNTIME_TOPOLOGY_READ_FAILED', message: 'Runtime topology unavailable' });
});

it('accepts a switch request with 202 and returns the record', async () => {
  mockService.request.mockResolvedValue({ record: { requestId: 'sw-2', state: 'requested' }, idempotent: false });
  const response = await request(app).post('/runtime-topology/switch')
    .send({ groupId: 'dual-gpu', targetMode: 'lanes', expectedActiveMode: 'pooled', requestId: 'sw-2' }).expect(202);
  expect(response.body).toEqual({ status: 'success', idempotent: false, data: { requestId: 'sw-2', state: 'requested' } });
  expect(mockService.request).toHaveBeenCalledWith(expect.objectContaining({
    groupId: 'dual-gpu', targetMode: 'lanes', expectedActiveMode: 'pooled', requestId: 'sw-2', source: 'api' }));
});

it('answers 200 for a repeated request id', async () => {
  mockService.request.mockResolvedValue({ record: { requestId: 'sw-2', state: 'loading' }, idempotent: true });
  const response = await request(app).post('/runtime-topology/switch').send({ groupId: 'dual-gpu', targetMode: 'lanes', requestId: 'sw-2' }).expect(200);
  expect(response.body.idempotent).toBe(true);
});

it('returns typed refusals with their data', async () => {
  mockService.request.mockRejectedValue(Object.assign(new Error('Switch sw-1 is verifying'),
    { code: 'TOPOLOGY_SWITCH_IN_PROGRESS', statusCode: 409, data: { requestId: 'sw-1', state: 'verifying' } }));
  const response = await request(app).post('/runtime-topology/switch').send({ groupId: 'dual-gpu', targetMode: 'lanes', requestId: 'sw-3' }).expect(409);
  expect(response.body).toEqual({ status: 'error', code: 'TOPOLOGY_SWITCH_IN_PROGRESS', message: 'Switch sw-1 is verifying',
    data: { requestId: 'sw-1', state: 'verifying' } });
});

it('reads a switch by request id, 404 when unknown', async () => {
  mockService.get.mockResolvedValueOnce({ requestId: 'sw-2', state: 'active' });
  await request(app).get('/runtime-topology/switch/sw-2').expect(200);
  mockService.get.mockResolvedValueOnce(null);
  const missing = await request(app).get('/runtime-topology/switch/nope').expect(404);
  expect(missing.body.code).toBe('TOPOLOGY_SWITCH_NOT_FOUND');
});

it('lists recent switches for a group', async () => {
  mockService.recent.mockResolvedValue([{ requestId: 'sw-2' }]);
  const response = await request(app).get('/runtime-topology/switches?groupId=dual-gpu&limit=3').expect(200);
  expect(response.body.data).toEqual([{ requestId: 'sw-2' }]);
  expect(mockService.recent).toHaveBeenCalledWith('dual-gpu', '3');
});

it('offers no other way to change the topology', async () => {
  await request(app).put('/runtime-topology').send({}).expect(404);
  await request(app).post('/runtime-topology').send({}).expect(404);
});
