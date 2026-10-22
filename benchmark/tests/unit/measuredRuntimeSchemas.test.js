'use strict';

const ModelPerformanceProfile = require('../../models/ModelPerformanceProfile');
const ModelProfile = require('../../models/ModelProfile');
const ModelContextProfile = require('../../models/ModelContextProfile');
const ModelContextProbeSnapshot = require('../../models/ModelContextProbeSnapshot');

const RUNTIME = { ollamaVersion: '0.40.8', gpuDriver: '580.95.05', observedAt: '2026-10-21T22:00:00.000Z' };
const ARTIFACT = {
  model: 'owner/model:8b', hostId: 'host-a', hostUrl: 'http://host-a:11434',
  digest: 'sha256:a', runtimeFingerprint: 'runtime-a', registryQualified: true
};

describe('measured runtime persistence (#908)', () => {
  it('keeps the runtime on performance evidence and readiness artifacts', () => {
    const evidence = new ModelPerformanceProfile({
      modelName: 'owner/model:8b', hostId: 'host-a', artifact: { ...ARTIFACT, runtime: RUNTIME }, profile: {}
    }).toObject();
    expect(evidence.artifact.runtime).toEqual(RUNTIME);
    const legacy = new ModelPerformanceProfile({ modelName: 'm', hostId: 'h', artifact: ARTIFACT, profile: {} }).toObject();
    expect(legacy.artifact).not.toHaveProperty('runtime');

    const profile = new ModelProfile({ name: 'owner/model:8b', readiness: { 'host-a': { artifact: { ...ARTIFACT, runtime: RUNTIME } } } });
    expect(profile.readiness.get('host-a').artifact.toObject().runtime).toEqual(RUNTIME);
  });

  it('keeps the runtime on context profiles and probe snapshots', () => {
    const context = new ModelContextProfile({
      modelName: 'm', hostUrl: 'http://h:11434', artifactDigest: 'sha256:a', runtimeFingerprint: 'r', measuredRuntime: RUNTIME
    }).toObject();
    expect(context.measuredRuntime).toEqual(RUNTIME);
    const snapshot = new ModelContextProbeSnapshot({
      modelName: 'm', hostUrl: 'http://h:11434', hostId: 'h', artifactDigest: 'sha256:a', runtimeFingerprint: 'r', measuredRuntime: RUNTIME
    }).toObject();
    expect(snapshot.measuredRuntime).toEqual(RUNTIME);
  });
});
