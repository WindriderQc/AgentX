const express = require('express');
const HostProfile = require('../../../models/HostProfile');
const router = require('../../../routes/profiler/evidence');
const { startTestHttpHarness } = require('../../helpers/testHttpServer');
const { buildRuntimeFingerprint } = require('../../../../shared/artifactIdentity');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

let mongo;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 30000);
afterAll(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test.each(['/host', '/inference/inventory-fixture'])('Core evidence %s preserves inventory through the actual contract consumer', async route => {
  const gpus = [0, 1].map(index => ({ index, uuid: `GPU-fixture-${index}`, busId: `0000:0${index}:00.0`,
    model: 'synthetic GPU', vramTotalMiB: 24576, computeCapability: '8.6', driver: 'test-driver' }));
  const stored = await HostProfile.create({ hostId: 'gpu-evidence-test', hostUrl: 'http://gpu-evidence.test:11434', gpus });
  const app = express(); app.use('/api/profiler/evidence', router);
  const http = await startTestHttpHarness(app);
  try {
    const response = await http.request.get('/api/profiler/evidence' + route).query({ hostUrl: stored.hostUrl });
    expect(response.status).toBe(200);
    const host = response.body.data.hostProfile;
    expect(host.gpus).toEqual(gpus);
    const before = buildRuntimeFingerprint({ ...host, gpus: undefined });
    expect(buildRuntimeFingerprint(host)).not.toBe(before);
    expect(buildRuntimeFingerprint({ ...host, gpus: [...gpus].reverse() })).toBe(buildRuntimeFingerprint(host));
    if (route.startsWith('/inference/')) {
      // The Benchmark CI job installs only this package. Run the real Core
      // consumer over HTTP with common dependencies resolved from Benchmark,
      // rather than relying on another service's local node_modules directory.
      const resolver = path.resolve(__dirname, '../../../../core/src/services/inferenceContractService');
      const script = `const { resolveCapabilities } = require(${JSON.stringify(resolver)});
        resolveCapabilities('inventory-fixture', ${JSON.stringify(stored.hostUrl)}, {
          includeArtifactIdentity: true,
          configuredHosts: [{ id: 'gpu-evidence-test', url: ${JSON.stringify(stored.hostUrl)} }],
          resolveArtifactDigest: async () => 'fixture-digest',
          registryEntry: { modelName: 'inventory-fixture', capabilities: { supportsThinking: false },
            installations: [{ hostUrl: ${JSON.stringify(stored.hostUrl)}, digest: 'fixture-digest', status: 'active' }] },
          toolQualificationEvidence: { state: 'unknown' }
        }).then(c => console.log(JSON.stringify(c.artifact))).catch(e => { console.error(e); process.exitCode = 1; });`;
      const address = http.server.address();
      const hostname = address.family === 'IPv6' ? `[${address.address}]` : address.address;
      const { stdout } = await promisify(execFile)(process.execPath, ['-e', script], {
        timeout: 10000,
        env: { ...process.env, NODE_PATH: path.resolve(__dirname, '../../../node_modules'),
          BENCHMARK_SERVICE_URL: `http://${hostname}:${address.port}`, NODE_ENV: 'test' }
      });
      const artifact = JSON.parse(stdout.trim().split('\n').pop());
      expect(artifact.identityQualified).toBe(true);
      expect(artifact.runtimeFingerprint).toBe(buildRuntimeFingerprint(host));
      expect(artifact.runtimeFingerprint).not.toBe(before);
    }
  } finally { await http.close(); await HostProfile.deleteOne({ _id: stored._id }); }
});
