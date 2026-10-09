'use strict';

const { buildContextProposal } = require('../../../src/services/profiler/contextProposal');

const GiB = 1024 ** 3;
const bgeFull = { model: 'bge-m3:latest', size: 1.2 * GiB, sizeVram: 1.2 * GiB, contextLength: 8192 };
const bgeSpilled = { ...bgeFull, sizeVram: 0.4 * GiB };

function sample({ ctx, coResidents = [bgeFull], modelVram = 20 * GiB, modelSize = 20 * GiB, vramUsedMiB = 24000 }) {
  return {
    passed: true, tokensPerSec: 60, gpuPercent: Number(((modelVram / modelSize) * 100).toFixed(1)),
    gpuSizeTotal: modelSize, gpuSizeVram: modelVram, ollamaContextLength: ctx,
    vramUsedMiB, vramTotalMiB: 49152, coResidents
  };
}

function step(ctx, options = {}) {
  const { passed = true, samples = 2, ...sampleOptions } = options;
  return {
    numCtx: ctx, tokPerSec: 60, passed,
    samples: Array.from({ length: samples }, () => sample({ ctx, ...sampleOptions }))
  };
}

function evidence(probeSteps, overrides = {}) {
  return {
    _id: 'evidence-1',
    authorityWriteId: 'write-1',
    profile: {
      profiledAt: '2026-09-27T10:00:00.000Z',
      maxVerifiedContext: Math.max(...probeSteps.filter(s => s.passed).map(s => s.numCtx), 0) || null,
      recommendedInteractiveContext: 32768,
      recommendedDocumentContext: 65536,
      probeSteps,
      ...overrides
    }
  };
}

const pins = (gemmaCtx = 65536, bgeCtx = 0) => ({
  hostUrl: 'http://gpu:11434',
  pinnedModels: [
    { model: 'gemma4:12b', contextSize: gemmaCtx, keepAlive: -1 },
    { model: 'bge-m3:latest', contextSize: bgeCtx, keepAlive: -1 }
  ]
});

const input = (extra) => ({ modelName: 'gemma4:12b', hostId: 'gpu', hostUrl: 'http://gpu:11434', ...extra });

describe('buildContextProposal', () => {
  it('proposes the largest context that passed with every other pin fully in VRAM', () => {
    const proposal = buildContextProposal(input({
      evidence: evidence([step(2048), step(65536), step(98304, { vramUsedMiB: 30500 }), step(131072, { coResidents: [bgeSpilled] })]),
      hostPreference: pins()
    }));
    expect(proposal).toMatchObject({
      status: 'proposed', offer: true, direction: 'increase',
      currentContext: 65536, proposedContext: 98304, soloVerifiedContext: 131072,
      proposalId: 'write-1', declined: false,
      expectedVram: { hostUsedMiB: 30500, hostTotalMiB: 49152, modelMiB: 20480 },
      proof: { numCtx: 98304, samples: 2, basis: 'co_resident_probe' },
      taskBudgets: { interactive: 32768, document: 65536 }
    });
    expect(proposal.coResidents).toEqual([{ model: 'bge-m3:latest', pinnedContext: 0, observedContext: 8192, vramMiB: 1229 }]);
  });

  it('offers nothing for a model that is not pinned on the host', () => {
    const proposal = buildContextProposal(input({ modelName: 'qwen3:8b', evidence: evidence([step(8192)]), hostPreference: pins() }));
    expect(proposal).toMatchObject({ status: 'not_pinned', offer: false });
    expect(proposal.proposedContext).toBeUndefined();
  });

  it('offers nothing when Core pins are unreadable', () => {
    expect(buildContextProposal(input({ evidence: evidence([step(8192)]), hostPreference: undefined })))
      .toMatchObject({ status: 'pins_unavailable', offer: false });
  });

  it('reports insufficient evidence for a profile without a context probe', () => {
    expect(buildContextProposal(input({ evidence: evidence([], { maxVerifiedContext: null }), hostPreference: pins() })))
      .toMatchObject({ status: 'insufficient_evidence', offer: false });
    expect(buildContextProposal(input({ evidence: null, hostPreference: pins() })).status).toBe('no_profile');
  });

  it('reports an unknown limit, not an estimate, when a co-resident spilled at every candidate', () => {
    const proposal = buildContextProposal(input({
      evidence: evidence([step(98304, { coResidents: [bgeSpilled] }), step(131072, { coResidents: [bgeSpilled] })]),
      hostPreference: pins()
    }));
    expect(proposal).toMatchObject({
      status: 'unknown_limit', offer: false,
      qualification: { missingResidents: ['bge-m3:latest'], candidates: [98304, 131072] }
    });
    expect(proposal.proposedContext).toBeUndefined();
  });

  it('treats a profile recorded before co-resident capture as unknown', () => {
    const legacy = step(131072);
    legacy.samples.forEach(item => { delete item.coResidents; });
    const proposal = buildContextProposal(input({ evidence: evidence([legacy]), hostPreference: pins() }));
    expect(proposal.status).toBe('unknown_limit');
    expect(proposal.reason).toMatch(/predates co-resident recording/);
  });

  it('does not count a co-resident loaded at a different context than its pin', () => {
    const proposal = buildContextProposal(input({
      evidence: evidence([step(98304)]),
      hostPreference: pins(65536, 4096)
    }));
    expect(proposal.status).toBe('unknown_limit');
    expect(proposal.qualification.missingResidents).toEqual(['bge-m3:latest']);
  });

  it('does not count a step where the profiled model itself spilled', () => {
    const proposal = buildContextProposal(input({
      evidence: evidence([step(98304, { modelVram: 19 * GiB })]),
      hostPreference: pins()
    }));
    expect(proposal.status).toBe('unknown_limit');
  });

  it('keeps a declined proposal visible until the pin matches or a newer profile replaces it', () => {
    const probe = evidence([step(98304)]);
    const decision = { proposalId: 'write-1', decision: 'keep_current', proposedContext: 98304, decidedAt: '2026-09-27T11:00:00Z' };
    expect(buildContextProposal(input({ evidence: probe, hostPreference: pins(), decision })))
      .toMatchObject({ status: 'proposed', offer: true, declined: true, declinedAt: decision.decidedAt });
    expect(buildContextProposal(input({ evidence: probe, hostPreference: pins(98304), decision })))
      .toMatchObject({ status: 'matches', offer: false });
    const newer = { ...evidence([step(98304)]), authorityWriteId: 'write-2' };
    expect(buildContextProposal(input({ evidence: newer, hostPreference: pins(), decision })))
      .toMatchObject({ status: 'proposed', declined: false, proposalId: 'write-2' });
  });

  it('proposes a decrease only after a capacity failure at or below the current pin', () => {
    const capacityFail = { ...step(98304, { passed: false }), failureKind: 'capacity' };
    const probe = evidence([step(65536), capacityFail]);
    expect(buildContextProposal(input({ evidence: probe, hostPreference: pins(131072) })))
      .toMatchObject({ status: 'proposed', direction: 'decrease', proposedContext: 65536 });
    expect(buildContextProposal(input({ evidence: probe, hostPreference: pins(98304) })))
      .toMatchObject({ status: 'proposed', direction: 'decrease', proposedContext: 65536 });
    // No failure at or below the pin (co-resident only missing): unknown.
    const noFailure = evidence([step(65536), step(98304, { coResidents: [bgeSpilled] })]);
    expect(buildContextProposal(input({ evidence: noFailure, hostPreference: pins(131072) })))
      .toMatchObject({ status: 'unknown_limit', offer: false });
  });

  it('never proposes a decrease from a timeout-terminated probe', () => {
    // Large-context host: pinned 196608, the probe timed out above 131072.
    const timeout = { ...step(196608, { passed: false }), failureKind: 'transport' };
    const probe = evidence([step(65536), step(131072), timeout], { contextCeilingFailureKind: 'transport' });
    const proposal = buildContextProposal(input({ evidence: probe, hostPreference: pins(196608) }));
    expect(proposal).toMatchObject({ status: 'unknown_limit', offer: false });
    expect(proposal.reason).toMatch(/timeout or lost connection/);
    expect(proposal.qualification.instruction).toMatch(/CONTEXT_PROBE_TIMEOUT_MS/);
    // Even with a capacity failure lower in the ladder, a transport ceiling stays a floor.
    const mixed = evidence([step(65536), { ...step(131072, { passed: false }), failureKind: 'capacity' }, timeout],
      { contextCeilingFailureKind: 'transport' });
    expect(buildContextProposal(input({ evidence: mixed, hostPreference: pins(196608) })).offer).toBe(false);
  });

  it('marks an ambiguous apply as outcome unknown rather than failed', () => {
    const decision = { proposalId: 'write-1', decision: 'apply_outcome_unknown', decidedAt: 'now', outcome: { code: 'CORE_NO_RESPONSE' } };
    expect(buildContextProposal(input({ evidence: evidence([step(98304)]), hostPreference: pins(), decision })).lastAttempt)
      .toEqual({ decidedAt: 'now', outcomeUnknown: true, outcome: { code: 'CORE_NO_RESPONSE' } });
  });

  it('uses the sole-resident proof when the model is the only pin', () => {
    const proposal = buildContextProposal(input({
      evidence: evidence([step(131072, { coResidents: [] })]),
      hostPreference: { pinnedModels: [{ model: 'gemma4:12b', contextSize: 0 }] }
    }));
    expect(proposal).toMatchObject({ status: 'proposed', currentContext: 0, proposedContext: 131072, proof: { basis: 'sole_resident_probe' } });
  });

  it('never proposes a context for an embedding pin', () => {
    const proposal = buildContextProposal(input({
      modelName: 'bge-m3:latest', evidence: evidence([step(8192)]), hostPreference: pins()
    }));
    expect(proposal).toMatchObject({ status: 'not_applicable', offer: false });
  });
});

describe('buildContextProposal on a CPU-resident host', () => {
  const hostConfig = require('../../../src/helpers/ollamaHostConfig');
  const CPU_URL = 'http://192.0.2.70:11435';
  beforeEach(() => hostConfig.setRegisteredHosts([{ id: 'cpu-host', url: CPU_URL, residency: 'cpu' }]));
  afterEach(() => hostConfig.setRegisteredHosts([]));

  it('reads samples saved without residency as CPU samples, so a lone CPU pin is not unknown_limit', () => {
    const cpuStep = ctx => step(ctx, { coResidents: [], modelVram: 0, modelSize: 15 * GiB });
    const proposal = buildContextProposal({
      modelName: 'gemma4:12b', hostId: 'cpu-host', hostUrl: CPU_URL,
      evidence: evidence([cpuStep(2048), cpuStep(16384), cpuStep(32768)]),
      hostPreference: { hostUrl: CPU_URL, pinnedModels: [{ model: 'gemma4:12b', contextSize: 32768, keepAlive: -1 }] }
    });
    expect(proposal.status).not.toBe('unknown_limit');
    expect(proposal.proof?.numCtx ?? proposal.currentContext).toBe(32768);
  });

  it('still refuses a CPU sample that used VRAM', () => {
    const leaked = ctx => step(ctx, { coResidents: [], modelVram: 2 * GiB, modelSize: 15 * GiB });
    const proposal = buildContextProposal({
      modelName: 'gemma4:12b', hostId: 'cpu-host', hostUrl: CPU_URL,
      evidence: evidence([leaked(2048), leaked(32768)]),
      hostPreference: { hostUrl: CPU_URL, pinnedModels: [{ model: 'gemma4:12b', contextSize: 32768, keepAlive: -1 }] }
    });
    expect(proposal.status).toBe('unknown_limit');
  });
});
