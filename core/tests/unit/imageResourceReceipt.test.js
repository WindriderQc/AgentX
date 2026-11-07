'use strict';
// Synthetic worker receipts only: no driver, GPU, model or host measurement.
const { normalize, phaseDurations } = require('../../src/services/images/resourceReceipt');

const JOB = '0d7c9a52-58f8-4b4f-9a3e-5d0f0c2b8e11';
const OTHER = '6a1f9c3e-2b4d-4e8f-9c1a-7b3d5e6f8a90';
const receipt = (changes = {}) => ({ resources: {
  contract: 'agentx.image-worker-resources/v1',
  child: { spawnedAtMs: 1_000, readyAtMs: 21_000, releasedAtMs: 141_000, reserveVramGiB: 1.2, jobIds: [JOB] },
  ram: { method: 'linux-proc-vmhwm', scope: 'cuda-child-process', status: 'measured', peakKiB: 31_457_280 },
  vram: { method: 'nvidia-smi-compute-apps', scope: 'cuda-child-process', intervalMs: 1000, status: 'sampled', bound: 'lower',
    samples: { attempted: 120, matched: 118, absent: 1, failed: 1, invalid: 0 },
    observedMaxMiB: 15_360, observedMaxAtMs: 90_000, firstMatchedAtMs: 22_000, lastMatchedAtMs: 140_000 },
  jobs: [{ jobId: JOB, executionMs: 95_000 }],
  ...changes } });
const withChild = changes => receipt({ child: { ...receipt().resources.child, ...changes } });
const withVram = changes => receipt({ vram: { ...receipt().resources.vram, ...changes } });

describe('image resource receipt', () => {
  test('an exclusive receipt keeps measured RAM, a sampled VRAM lower bound and per-case times with their scope', () => {
    expect(normalize(receipt(), JOB)).toEqual({
      contract: 'agentx.image-resources/v1', status: 'recorded', attribution: 'exclusive',
      child: { jobCount: 1, startupMs: 20_000, lifetimeMs: 140_000, reserveVramGiB: 1.2 }, executionMs: 95_000,
      ram: { scope: 'cuda-child-process', method: 'linux-proc-vmhwm', status: 'measured', peakKiB: 31_457_280 },
      vram: { scope: 'cuda-child-process', method: 'nvidia-smi-compute-apps', intervalMs: 1000,
        samples: { attempted: 120, matched: 118, absent: 1, failed: 1, invalid: 0 },
        status: 'sampled-lower-bound', observedMaxMiB: 15_360, observedMaxAfterSpawnMs: 89_000, sampledSpanMs: 118_000 },
    });
  });

  test('a missing, foreign or malformed answer records unavailability, never a figure', () => {
    for (const answer of [undefined, null, {}, { resources: 'garbage' }, { resources: { contract: 'other/v9' } }]) {
      const result = normalize(answer, JOB);
      expect(result.status).toBe('unavailable');
      expect(result).not.toHaveProperty('ram');
    }
  });

  test('a receipt of another child lifetime is stale and attributes nothing to this operation', () => {
    expect(normalize(withChild({ jobIds: [OTHER] }), JOB)).toEqual({ contract: 'agentx.image-resources/v1', status: 'stale',
      reason: 'receipt belongs to another worker child' });
    expect(normalize(receipt(), undefined).status).toBe('stale');
    expect(normalize(withChild({ jobIds: 'x' }), JOB).status).toBe('stale');
  });

  test('a child that also ran another prompt is labelled shared', () => {
    const result = normalize(withChild({ jobIds: [OTHER, JOB] }), JOB);
    expect(result).toMatchObject({ attribution: 'shared-child', child: { jobCount: 2 } });
  });

  test('an inconsistent child lifetime keeps no figures', () => {
    for (const child of [{ releasedAtMs: 500 }, { readyAtMs: 0 }, { spawnedAtMs: -1 }, { readyAtMs: 1.5 }, { releasedAtMs: Number.NaN },
      { releasedAtMs: '141000' }, { releasedAtMs: 1_000 + 8 * 86_400_000 }]) {
      const result = normalize(withChild(child), JOB);
      expect(result.status).toBe('invalid');
      expect(result).not.toHaveProperty('ram');
    }
  });

  test('invalid RAM values are refused without discarding valid VRAM samples', () => {
    for (const peakKiB of [-1, 0, 1.5, Number.POSITIVE_INFINITY, 2 ** 35, '2048', null]) {
      const result = normalize(receipt({ ram: { status: 'measured', peakKiB } }), JOB);
      expect(result.ram.status).toBe('invalid');
      expect(result.ram).not.toHaveProperty('peakKiB');
      expect(result.vram.status).toBe('sampled-lower-bound');
    }
    expect(normalize(receipt({ ram: { status: 'unavailable', reason: 'x'.repeat(500) } }), JOB).ram).toEqual({
      scope: 'cuda-child-process', method: 'linux-proc-vmhwm', status: 'unavailable', reason: 'x'.repeat(120) });
    expect(normalize(receipt({ ram: undefined }), JOB).ram.status).toBe('unavailable');
  });

  test('VRAM samples outside their own child lifetime, out of range or without a lower bound are refused', () => {
    const cases = [{ firstMatchedAtMs: 20_999 }, { lastMatchedAtMs: 141_001 }, { observedMaxAtMs: 10_000 }, { observedMaxAtMs: 141_000 },
      { observedMaxMiB: -1 }, { observedMaxMiB: 2 ** 21 }, { observedMaxMiB: 1.5 }, { bound: undefined }, { bound: 'exact' },
      { samples: { attempted: 1, matched: 0, absent: 1, failed: 0, invalid: 0 } }];
    for (const change of cases) {
      const result = normalize(withVram(change), JOB);
      expect(result.vram.status).toBe('invalid');
      expect(result.vram).not.toHaveProperty('observedMaxMiB');
      expect(result.ram.status).toBe('measured');
    }
  });

  test('inconsistent sample counts or intervals are refused and unavailable sampling keeps its reason', () => {
    for (const change of [{ samples: { attempted: 5, matched: 1, absent: 1, failed: 1, invalid: 1 } }, { samples: undefined },
      { samples: { attempted: -1, matched: 0, absent: 0, failed: 0, invalid: -1 } }, { intervalMs: -5 }, { intervalMs: 3_600_000 }]) {
      expect(normalize(withVram(change), JOB).vram.status).toBe('invalid');
    }
    const unavailable = normalize(receipt({ vram: { status: 'unavailable', reason: 'driver query failed', intervalMs: 1000,
      samples: { attempted: 3, matched: 0, absent: 0, failed: 3, invalid: 0 } } }), JOB).vram;
    expect(unavailable).toMatchObject({ status: 'unavailable', reason: 'driver query failed', samples: { failed: 3 } });
    expect(unavailable).not.toHaveProperty('observedMaxMiB');
  });

  test('a missing or invalid execution time stays unknown and a bad reserve is dropped', () => {
    for (const jobs of [undefined, [], [{ jobId: OTHER, executionMs: 5 }], [{ jobId: JOB, executionMs: -3 }], [{ jobId: JOB, executionMs: '9' }]]) {
      expect(normalize(receipt({ jobs }), JOB).executionMs).toBeNull();
    }
    expect(normalize(withChild({ reserveVramGiB: Number.NaN }), JOB).child).not.toHaveProperty('reserveVramGiB');
  });

  test('phases last until the next phase or the end of the operation', () => {
    expect(phaseDurations([['reserving', 100], ['generating', 400], ['archiving', 900], ['restoring', 950]], 1_200))
      .toEqual({ reserving: 300, generating: 500, archiving: 50, restoring: 250 });
    expect(phaseDurations([['reserving', 100]], 160)).toEqual({ reserving: 60 });
    expect(phaseDurations([], 5)).toEqual({});
  });
});
