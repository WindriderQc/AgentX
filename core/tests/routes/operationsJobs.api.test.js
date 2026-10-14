'use strict';
const express = require('express');
const request = require('supertest');
const {createRouter} = require('../../routes/operations-jobs');
const {createOperationsService} = require('../../src/services/operationsJobsService');
const env = {AGENTX_OPERATIONS_SSH_TARGET: 'operator@server'};
const requestId = '12345678-1234-4234-8234-123456789012';
function setup(runner) {const app = express(); app.use('/api/operations/jobs', createRouter(createOperationsService({env, runner, mirror: async () => {}}))); return app;}
test('read-only status is safely available before an instance has an executor', async () => {
  const app = express(); app.use('/api/operations/jobs', createRouter(createOperationsService({env: {}})));
  const response = await request(app).get('/api/operations/jobs');
  expect(response.status).toBe(200);
  expect(response.body.data.available).toBe(false);
});
test('the same accepted run identity is returned through the API', async () => {
  const runner = jest.fn(async () => ({stdout: JSON.stringify({status: 'success', data: {requestId, jobId: 'usage', state: 'accepted'}})}));
  const response = await request(setup(runner)).post('/api/operations/jobs/usage/run').send({requestId, revision: 1});
  expect(response.status).toBe(200);
  expect(response.body.data.requestId).toBe(requestId);
  expect(runner).toHaveBeenCalledTimes(1);
});
test('a revision conflict refuses without silently overwriting native cadence', async () => {
  const runner = jest.fn(async () => ({stdout: JSON.stringify({status: 'error', error: {code: 'REVISION_CONFLICT', message: 'Refresh', status: 409}})}));
  const response = await request(setup(runner)).patch('/api/operations/jobs/usage').send({revision: 1, enabled: false});
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('REVISION_CONFLICT');
});
test('the API cannot install executable text or accept an identity-free run', async () => {
  const runner = jest.fn(); const app = setup(runner);
  expect((await request(app).patch('/api/operations/jobs/usage').send({revision: 1, command: 'anything'})).status).toBe(400);
  expect((await request(app).post('/api/operations/jobs/usage/run').send({revision: 1})).status).toBe(400);
  expect((await request(app).post('/api/operations/jobs/usage/run').send([])).status).toBe(400);
  expect(runner).not.toHaveBeenCalled();
});
