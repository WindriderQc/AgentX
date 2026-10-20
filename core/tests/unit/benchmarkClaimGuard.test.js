'use strict';

jest.mock('../../src/services/hostPreferenceService', () => ({
  getByHost: jest.fn(),
  hasActiveBenchmarkClaim: jest.fn(pref => Boolean(pref?.benchmarkClaim))
}));
jest.mock('../../config/logger', () => ({ info: jest.fn() }));
jest.mock('../../src/services/runtimeCoordinationService', () => ({
  assertWorkloadAdmission: jest.fn(async () => ({ admitted: true }))
}));

jest.mock('../../src/services/interactivePriorityService', () => ({ claimYielded: jest.fn(async () => false) }));

const hostPreferenceService = require('../../src/services/hostPreferenceService');
const interactivePriority = require('../../src/services/interactivePriorityService');
const { assertHostAvailableForConsumer, workloadReservesHost } = require('../../src/services/benchmarkClaimGuard');

describe('benchmarkClaimGuard session hold', () => {
  const hold = {
    holdId: 'hold-1',
    owner: 'extension/open',
    model: 'held-model:27b',
    expiresAt: new Date(Date.now() + 60_000)
  };

  beforeEach(() => {
    jest.clearAllMocks();
    hostPreferenceService.getByHost.mockResolvedValue({ benchmarkClaim: null, sessionHold: hold });
  });

  it('refuses other models on a held host with a retry hint', async () => {
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      callerDetail: 'proxy',
      model: 'everyday-model:27b'
    })).rejects.toMatchObject({
      code: 'HOST_SESSION_HOLD_ACTIVE',
      statusCode: 503,
      holdOwner: 'extension/open',
      retryAfterMs: expect.any(Number)
    });
  });

  it('admits the held model itself', async () => {
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      callerDetail: 'extension/open',
      model: 'held-model:27b'
    })).resolves.toBeNull();
  });

  it('is transparent when the hold has expired', async () => {
    hostPreferenceService.getByHost.mockResolvedValue({
      benchmarkClaim: null,
      sessionHold: { ...hold, expiresAt: new Date(Date.now() - 1_000) }
    });
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      model: 'everyday-model:27b'
    })).resolves.toBeNull();
  });
});

describe('benchmarkClaimGuard claim proof', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hostPreferenceService.getByHost.mockResolvedValue({
      benchmarkClaim: {
        batchId: 'batch-1',
        claimGeneration: 'generation-1',
        admissionId: 'admission-1',
        admissionGeneration: 'admission-generation-1',
        admissionPrincipal: 'benchmark-service'
      }
    });
  });

  it('admits consumer inference only while the claim workload has yielded to a household turn', async () => {
    interactivePriority.claimYielded.mockResolvedValueOnce(true);
    await expect(assertHostAvailableForConsumer('http://host:11434', { callerDetail: 'openclaw-runtime-bridge' }))
      .resolves.toBeNull();
    await expect(assertHostAvailableForConsumer('http://host:11434', { callerDetail: 'openclaw-runtime-bridge' }))
      .rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE' });
  });

  it('does not authorize a caller-controlled benchmark prefix', async () => {
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      callerDetail: 'benchmark-spoofed'
    })).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE', batchId: 'batch-1' });
  });

  it('authorizes only the exact active batch and generation', async () => {
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      callerDetail: 'benchmark-batch-1',
      claimBatchId: 'batch-1',
      claimGeneration: 'generation-1',
      workloadAdmissionId: 'admission-1',
      workloadGeneration: 'admission-generation-1',
      benchmarkAuthorized: true
    })).resolves.toMatchObject({ batchId: 'batch-1' });

    await expect(assertHostAvailableForConsumer('http://host:11434', {
      claimBatchId: 'batch-1',
      claimGeneration: 'generation-stale',
      workloadAdmissionId: 'admission-1',
      workloadGeneration: 'admission-generation-1',
      benchmarkAuthorized: true
    })).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE' });
  });

  it('rejects replay of an exact proof without authenticated Benchmark principal', async () => {
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      callerDetail: 'benchmark-batch-1',
      claimBatchId: 'batch-1',
      claimGeneration: 'generation-1',
      workloadAdmissionId: 'admission-1',
      workloadGeneration: 'admission-generation-1',
      benchmarkAuthorized: false
    })).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE' });
  });

  it('rejects an authenticated claim after its linked workload admission expires', async () => {
    const runtimeCoordinationService = require('../../src/services/runtimeCoordinationService');
    runtimeCoordinationService.assertWorkloadAdmission.mockResolvedValueOnce({
      admitted: false,
      reason: 'expired'
    });
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      claimBatchId: 'batch-1',
      claimGeneration: 'generation-1',
      workloadAdmissionId: 'admission-1',
      workloadGeneration: 'admission-generation-1',
      benchmarkAuthorized: true
    })).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE' });
  });

  it('rejects stale proof when no claim is active', async () => {
    hostPreferenceService.getByHost.mockResolvedValue(null);
    await expect(assertHostAvailableForConsumer('http://host:11434', {
      claimBatchId: 'batch-1',
      claimGeneration: 'generation-1'
    })).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_PROOF_INVALID' });
  });
});

describe('workloadReservesHost', () => {
  const proof = { workloadAdmissionId: 'admission-1', workloadGeneration: 'generation-1' };

  it('owns a host the workload reserves', async () => {
    const sharesHost = jest.fn(async () => false);
    await expect(workloadReservesHost('http://exec:11434', proof, true, { sharesHost })).resolves.toBe(true);
    expect(sharesHost).toHaveBeenCalledWith({ id: 'admission-1', generation: 'generation-1', host: 'http://exec:11434' });
  });

  it('leaves a shared judge host to its pin', async () => {
    await expect(workloadReservesHost('http://judge:11434', proof, true, { sharesHost: async () => true }))
      .resolves.toBe(false);
  });

  it('needs a Benchmark caller and a complete string proof', async () => {
    const sharesHost = jest.fn(async () => false);
    await expect(workloadReservesHost('http://exec:11434', proof, false, { sharesHost })).resolves.toBe(false);
    await expect(workloadReservesHost('http://exec:11434', { workloadAdmissionId: 'admission-1' }, true, { sharesHost }))
      .resolves.toBe(false);
    await expect(workloadReservesHost('http://exec:11434', { workloadAdmissionId: {}, workloadGeneration: 'g' }, true,
      { sharesHost })).resolves.toBe(false);
    expect(sharesHost).not.toHaveBeenCalled();
  });
});
