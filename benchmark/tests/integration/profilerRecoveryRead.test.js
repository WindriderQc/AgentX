'use strict';
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const HostProfile = require('../../models/HostProfile');
let mongo, http;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  const app = express(); app.use('/api/profiler/recovery', require('../../routes/profiler/recovery'));
  http = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
}, 120000);
afterAll(async () => { await http.close(); await mongoose.disconnect(); await mongo.stop(); }, 120000);
beforeEach(async () => { await HostProfile.deleteMany({}); });
test('recovery reads preserve the complete journal and exclude bearer identities', async () => {
  const host = await HostProfile.create({ hostId: 'synthetic', hostUrl: 'http://synthetic:11434', reconciliation: { state: 'unknown', operationId: 'op-1',
    admissionId: 'private-admission', admissionGeneration: 'private-generation', recoveryId: 'private-recovery',
    ownerEpoch: 'private-epoch', releaseReceipt: { token: 'private-token' }, pendingRequests: 1, serverTerminalObserved: false } });
  const before = await HostProfile.findById(host._id).lean();
  const response = await http.request.get('/api/profiler/recovery').expect(200);
  expect(response.body.data.operations[0]).toMatchObject({ code: 'terminal_unknown', operationId: 'op-1', authorization: 'not_granted' });
  expect(JSON.stringify(response.body)).not.toContain('private-');
  expect(await HostProfile.findById(host._id).lean()).toEqual(before);
  expect(response.headers['cache-control']).toBe('no-store');
});
test('old unresolved journals remain visible beside recent successful releases', async () => {
  await HostProfile.create([{ hostId: 'old', hostUrl: 'http://old:11434', reconciliation: { state: 'pending_reconciliation', startedAt: new Date('2020-01-01'), serverTerminalObserved: true } },
    { hostId: 'recent', hostUrl: 'http://recent:11434', reconciliation: { state: 'resolved', resolvedAt: new Date(), releaseReceipt: { released: true } } }]);
  const response = await http.request.get('/api/profiler/recovery').expect(200);
  expect(response.body.data.operations.map(item => item.code)).toEqual(['restore_pending', 'released']);
});
test('bounded views explicitly report unresolved overflow', async () => {
  await HostProfile.insertMany(Array.from({ length: 101 }, (_, index) => ({ hostId: `host-${index}`, hostUrl: `http://host-${index}:11434`, reconciliation: { state: 'unknown' } })));
  const response = await http.request.get('/api/profiler/recovery').expect(200);
  expect(response.body.data.truncated).toBe(true); expect(response.body.data.operations).toHaveLength(100);
});
