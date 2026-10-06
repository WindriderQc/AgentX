const express = require('express');
const HostProfile = require('../../../models/HostProfile');
const router = require('../../../routes/profiler/evidence');
const { startTestHttpHarness } = require('../../helpers/testHttpServer');
const { buildRuntimeFingerprint } = require('../../../../shared/artifactIdentity');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 30000);
afterAll(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test('Core host evidence receives the persisted GPU inventory that defines runtime identity', async () => {
  const gpus = [0, 1].map(index => ({ index, uuid: `GPU-fixture-${index}`, busId: `0000:0${index}:00.0`,
    model: 'synthetic GPU', vramTotalMiB: 24576, computeCapability: '8.6', driver: 'test-driver' }));
  const stored = await HostProfile.create({ hostId: 'gpu-evidence-test', hostUrl: 'http://gpu-evidence.test:11434', gpus });
  const app = express(); app.use('/evidence', router);
  const http = await startTestHttpHarness(app);
  try {
    const response = await http.request.get('/evidence/host').query({ hostUrl: stored.hostUrl });
    expect(response.status).toBe(200);
    const host = response.body.data.hostProfile;
    expect(host.gpus).toEqual(gpus);
    const before = buildRuntimeFingerprint({ ...host, gpus: undefined });
    expect(buildRuntimeFingerprint(host)).not.toBe(before);
    expect(buildRuntimeFingerprint({ ...host, gpus: [...gpus].reverse() })).toBe(buildRuntimeFingerprint(host));
  } finally { await http.close(); await HostProfile.deleteOne({ _id: stored._id }); }
});
