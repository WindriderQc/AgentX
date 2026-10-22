'use strict';

const { loadBrowserModule } = require('../../helpers/browserModule');
const { projectReadinessEntry } = require('../../../src/services/profiler/profilerReadinessProjectionService');

const ARTIFACT = {
  model: 'owner/model:8b', hostId: 'host-a', hostUrl: 'http://host-a:11434',
  digest: 'sha256:a', runtimeFingerprint: 'runtime-a', registryQualified: true
};

function project({ measured, installed, identityMatches = true }) {
  const readiness = {
    evidenceId: 'e1', benchmarkQualified: true, stage: 'profiled',
    artifact: { ...ARTIFACT, ...(measured !== undefined && { runtime: { ollamaVersion: measured } }) }
  };
  const evidence = { _id: 'e1', artifact: readiness.artifact, profile: { benchmarkQualified: true } };
  return projectReadinessEntry('owner/model:8b', 'host-a', readiness, new Map([['e1', evidence]]), {
    verifyReceipt: () => true,
    resolveIdentity: async () => ({ ...ARTIFACT, runtime: { ollamaVersion: installed } }),
    matchIdentities: () => identityMatches,
    now: () => new Date('2026-10-21T22:00:00Z')
  });
}

describe('Profiler readiness Ollama version drift (#908)', () => {
  it('keeps a profile qualified on another Ollama version and reports the drift', async () => {
    const entry = await project({ measured: '0.34.4', installed: '0.40.8' });
    expect(entry.authorityVerified).toBe(true);
    expect(entry.benchmarkQualified).toBe(true);
    expect(entry.runtimeDrift).toEqual({ measured: '0.34.4', installed: '0.40.8' });
    expect(entry.measuredRuntime).toMatchObject({ ollamaVersion: '0.34.4' });
    expect(entry.authority.liveRuntimeVersion).toBe('0.40.8');
  });

  it('reports no drift on the same version, and unrecorded drift for older evidence', async () => {
    expect((await project({ measured: '0.40.8', installed: '0.40.8' })).runtimeDrift).toBeNull();
    expect((await project({ installed: '0.40.8' })).runtimeDrift).toEqual({ measured: null, installed: '0.40.8' });
  });

  it('leaves a physical identity change to the fingerprint: no drift, not verified', async () => {
    const entry = await project({ measured: '0.34.4', installed: '0.40.8', identityMatches: false });
    expect(entry.authorityVerified).toBe(false);
    expect(entry.runtimeDrift).toBeNull();
  });
});

describe('Profiler model badge for Ollama version drift', () => {
  const escAttr = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const helpers = loadBrowserModule('model-profiler/models-helpers.js', 'runtimeDriftByHost', {});
  const render = loadBrowserModule('model-profiler/models-render.js', 'renderRuntimeDriftBadge', { ...helpers, escAttr });

  it('names the measured and installed versions', () => {
    const html = render.renderRuntimeDriftBadge({ readiness: { alien: { runtimeDrift: { measured: '0.34.4', installed: '0.40.8' } } } });
    expect(html).toContain('Ollama 0.34.4 → 0.40.8');
    expect(html).toContain('still used');
    expect(render.renderRuntimeDriftBadge({ readiness: { alien: { runtimeDrift: null } } })).toBe('');
  });
});
