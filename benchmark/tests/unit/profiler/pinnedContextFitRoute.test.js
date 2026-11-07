'use strict';
const express = require('express');
const { startTestHttpHarness } = require('../../helpers/testHttpServer');
jest.mock('../../../src/services/profiler/pinnedContextFitService', () => ({
  get: jest.fn(), request: jest.fn(), start: jest.fn(), cancel: jest.fn(), reconcile: jest.fn()
}));
const fit = require('../../../src/services/profiler/pinnedContextFitService');
const app = express(); app.use(express.json()); app.use('/fit', require('../../../routes/profiler/pinnedContextFit'));
let http;
beforeAll(async () => { http = await startTestHttpHarness(app, { transport: 'tcp' }); });
afterAll(async () => { await http.close(); });
beforeEach(() => { jest.resetAllMocks(); });
test('GET is a receipt read and never calls a mutation', async () => {
  fit.get.mockResolvedValue({ id: 'original', state: 'unknown', runtimeReleased: false });
  expect((await http.request.get('/fit/original')).body.data.state).toBe('unknown');
  expect(fit.get).toHaveBeenCalledWith('original');
  for (const name of ['request', 'start', 'cancel', 'reconcile']) expect(fit[name]).not.toHaveBeenCalled();
});
test.each([
  ['/fit/request', { requestId: 'original', hostId: 'fixture', autoStart: true }],
  ['/fit/request', { requestId: 'original', hostId: 'fixture', model: 'untrusted:latest' }],
  ['/fit/start', { fitCheckId: 'original', force: true }],
  ['/fit/original/reconcile', { runtimeReleased: true }],
  ['/fit/original/reconcile', { nativeIdentity: { admissionId: 'incomplete' } }]
])('refuses unsupported authority in %s', async (url, body) => {
  expect((await http.request.post(url).send(body)).status).toBe(400);
  for (const name of ['request', 'start', 'cancel', 'reconcile']) expect(fit[name]).not.toHaveBeenCalled();
});
test('reconciliation passes only the original native identity to its read-back', async () => {
  const identity = { admissionId: 'original', generation: 'generation', principal: 'benchmark', recoveryId: 'recovery' };
  fit.reconcile.mockResolvedValue({ state: 'failed', runtimeReleased: true });
  const response = await http.request.post('/fit/original/reconcile').send({ nativeIdentity: identity });
  expect(response.status).toBe(200); expect(fit.reconcile).toHaveBeenCalledWith('original', identity);
  expect(fit.start).not.toHaveBeenCalled();
});
