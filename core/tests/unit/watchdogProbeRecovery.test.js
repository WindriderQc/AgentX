'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const service = require('../../src/services/runtimeCoordinationService');
const {
  DEFAULT_CALLER_ABORT_SETTLE_MS,
  DEFAULT_SETTLE_MS,
  collectRecoveryRequired,
  recoverSettledWatchdogProbes,
} = require('../../src/services/watchdogProbeRecovery');

const HOST = 'http://host-a:11434';
const LATER = () => Date.now() + DEFAULT_SETTLE_MS + 60_000;
const noSleep = async () => {};
const residentAt = (ctx) => [{ name: 'model-a', digest: 'd1', size_vram: 100, context_length: ctx, expires_at: '2318-01-01T00:00:00Z' }];

async function quarantine({ kind = 'watchdog-probe', principal = 'core-watchdog', numCtx = 8192, requestId = 'probe-1',
  origin = null, reason = 'The outbound request exceeded its deadline.' } = {}) {
  const admission = await service.acquireInference({ principal, requestId, host: HOST, model: 'model-a', kind,
    runtimeOptions: { num_ctx: numCtx } });
  await service.markInferenceUnknown({ id: admission.admissionId, generation: admission.generation,
    principal, reason, origin });
  return admission;
}

const callerAbort = () => quarantine({ kind: 'trusted-runtime', principal: 'core-trusted-runtime',
  requestId: 'turn-1', origin: 'caller-abort', reason: 'The user aborted a request.' });
const AFTER_ABORT_WINDOW = () => Date.now() + DEFAULT_CALLER_ABORT_SETTLE_MS + 1_000;

async function inferences() {
  return (await RuntimeCoordination.findById('runtime').lean()).inferences;
}

describe('watchdog probe recovery without a runtime restart', () => {
  beforeEach(async () => {
    await RuntimeCoordination.deleteMany({});
    await RuntimeCoordination.create({ _id: 'runtime', maintenance: null, workloads: [], inferences: [] });
  });

  afterEach(async () => {
    await RuntimeCoordination.deleteMany({});
  });

  test('releases a settled probe on a stable runtime and keeps the evidence', async () => {
    const probe = await quarantine();
    const readPs = jest.fn().mockResolvedValue(residentAt(8192));

    const result = await recoverSettledWatchdogProbes(HOST, { readPs, sleep: noSleep, now: LATER });

    expect(result).toMatchObject({ recovered: true });
    expect(readPs).toHaveBeenCalledTimes(2);
    expect(await inferences()).toEqual([]);
    const { releaseReceipts } = await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean();
    expect(releaseReceipts.at(-1)).toMatchObject({
      contract: 'agentx.watchdog-probe-recovery/v1', admissionId: probe.admissionId,
      unknownReason: 'The outbound request exceeded its deadline.',
      evidence: { settleMs: DEFAULT_SETTLE_MS }
    });
    await expect(service.acquireInference({ principal: 'worker', requestId: 'after', host: HOST,
      model: 'model-a', runtimeOptions: { num_ctx: 8192 } })).resolves.toMatchObject({ acquired: true });
  });

  test('keeps an expired probe quarantined until the settle window has elapsed', async () => {
    await quarantine();
    const result = await recoverSettledWatchdogProbes(HOST, { readPs: jest.fn(), sleep: noSleep });
    expect(result).toEqual({ recovered: false, reason: 'settle window not elapsed' });
    expect(await inferences()).toHaveLength(1);
  });

  test('keeps the probe when the runtime changes between samples or runs another context', async () => {
    await quarantine();
    const changing = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(residentAt(8192));
    await expect(recoverSettledWatchdogProbes(HOST, { readPs: changing, sleep: noSleep, now: LATER }))
      .resolves.toEqual({ recovered: false, reason: 'runtime not stable' });
    await expect(recoverSettledWatchdogProbes(HOST, { readPs: jest.fn().mockResolvedValue(residentAt(4096)),
      sleep: noSleep, now: LATER })).resolves.toEqual({ recovered: false, reason: 'probe residency mismatch' });
    expect(await inferences()).toHaveLength(1);
  });

  test('never releases next to a real generation, quarantined or active', async () => {
    await quarantine();
    // A quarantined host refuses new admissions, so seed the generation directly.
    await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $push: { inferences: {
      admissionId: 'generation-1', generation: 'g1', principal: 'benchmark-service', requestId: 'r1',
      host: HOST, model: 'model-a', kind: 'inference-direct', mode: 'shared', state: 'UNKNOWN',
      acquiredAt: new Date(0), heartbeatAt: new Date(0), expiresAt: new Date(0), unknownAt: new Date(0)
    } } });
    const readPs = jest.fn().mockResolvedValue(residentAt(8192));
    await expect(recoverSettledWatchdogProbes(HOST, { readPs, sleep: noSleep, now: LATER }))
      .resolves.toEqual({ recovered: false, reason: 'other inference on host' });
    expect(readPs).not.toHaveBeenCalled();
    expect(await inferences()).toHaveLength(2);
  });

  test('never releases while a workload covers the host', async () => {
    await quarantine();
    await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $push: { workloads: { admissionId: 'w', hosts: [HOST] } } });
    await expect(recoverSettledWatchdogProbes(HOST, { readPs: jest.fn(), sleep: noSleep, now: LATER }))
      .resolves.toEqual({ recovered: false, reason: 'workload covers host' });
  });

  test('the cycle view keeps an unsettled probe host in recovery', async () => {
    await quarantine();
    const host = { id: 'primary', name: 'A', url: HOST };
    const coordination = await service.listActive();
    const target = new Map();
    const recordEvent = jest.fn();

    await collectRecoveryRequired({ hosts: [host], coordination, previous: new Map(), target, recordEvent,
      readPs: jest.fn().mockResolvedValue(residentAt(8192)) });

    // Within the settle window the host still requires recovery.
    expect(target.get(HOST)).toMatchObject({ reason: 'inference_outcome_unknown', models: ['model-a'] });
    expect(recordEvent).toHaveBeenCalledWith('recovery_required', host, expect.any(Object));
  });

  test('the cycle view releases a settled probe and records it instead of requiring recovery', async () => {
    await quarantine();
    const host = { id: 'primary', name: 'A', url: HOST };
    const target = new Map();
    const recordEvent = jest.fn();

    await collectRecoveryRequired({ hosts: [host], coordination: await service.listActive(), previous: new Map(),
      target, recordEvent, readPs: jest.fn().mockResolvedValue(residentAt(8192)), now: LATER, sleep: noSleep });

    expect(target.has(HOST)).toBe(false);
    expect(recordEvent).toHaveBeenCalledWith('probe_recovered', host, { models: ['model-a'] });
    expect(await inferences()).toEqual([]);
  });
});

describe('caller-aborted inference recovery without a runtime restart (#35)', () => {
  beforeEach(async () => {
    await RuntimeCoordination.deleteMany({});
    await RuntimeCoordination.create({ _id: 'runtime', maintenance: null, workloads: [], inferences: [] });
  });

  afterEach(async () => {
    await RuntimeCoordination.deleteMany({});
  });

  test('records the caller-abort origin on the quarantine', async () => {
    await callerAbort();
    expect(await inferences()).toEqual([expect.objectContaining({ state: 'UNKNOWN', unknownOrigin: 'caller-abort' })]);
    const listed = await service.listActive();
    expect(listed.inferences).toEqual([expect.objectContaining({ quarantined: true, unknownOrigin: 'caller-abort' })]);
  });

  test('releases a caller abort after the short window when its model is resident at its context', async () => {
    const turn = await callerAbort();
    const readPs = jest.fn().mockResolvedValue(residentAt(8192));

    const result = await recoverSettledWatchdogProbes(HOST, { readPs, sleep: noSleep, now: AFTER_ABORT_WINDOW });

    expect(result).toMatchObject({ recovered: true });
    expect(await inferences()).toEqual([]);
    const { releaseReceipts } = await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean();
    expect(releaseReceipts.at(-1)).toMatchObject({
      contract: 'agentx.caller-abort-recovery/v1', admissionId: turn.admissionId, unknownOrigin: 'caller-abort',
      unknownReason: 'The user aborted a request.', residentAtRequest: true
    });
    await expect(service.acquireInference({ principal: 'core-trusted-runtime', requestId: 'next', host: HOST,
      model: 'model-a', runtimeOptions: { num_ctx: 8192 } })).resolves.toMatchObject({ acquired: true });
  });

  test('keeps a caller abort quarantined within the short window', async () => {
    await callerAbort();
    await expect(recoverSettledWatchdogProbes(HOST, { readPs: jest.fn(), sleep: noSleep }))
      .resolves.toEqual({ recovered: false, reason: 'settle window not elapsed' });
    expect(await inferences()).toHaveLength(1);
  });

  test('a caller abort whose model may still be loading waits for the full settle window', async () => {
    await callerAbort();
    const absent = jest.fn().mockResolvedValue([]);
    await expect(recoverSettledWatchdogProbes(HOST, { readPs: absent, sleep: noSleep, now: AFTER_ABORT_WINDOW }))
      .resolves.toEqual({ recovered: false, reason: 'settle window not elapsed' });
    expect(await inferences()).toHaveLength(1);
    await expect(recoverSettledWatchdogProbes(HOST, { readPs: absent, sleep: noSleep, now: LATER }))
      .resolves.toMatchObject({ recovered: true });
  });

  test('keeps a caller abort when the runtime changes between samples or runs another context', async () => {
    await callerAbort();
    const changing = jest.fn().mockResolvedValueOnce(residentAt(8192))
      .mockResolvedValueOnce([{ ...residentAt(8192)[0], expires_at: '2318-01-02T00:00:00Z' }]);
    await expect(recoverSettledWatchdogProbes(HOST, { readPs: changing, sleep: noSleep, now: AFTER_ABORT_WINDOW }))
      .resolves.toEqual({ recovered: false, reason: 'runtime not stable' });
    await expect(recoverSettledWatchdogProbes(HOST, { readPs: jest.fn().mockResolvedValue(residentAt(4096)),
      sleep: noSleep, now: LATER })).resolves.toEqual({ recovered: false, reason: 'probe residency mismatch' });
    expect(await inferences()).toHaveLength(1);
  });

  test('never releases an UNKNOWN inference without the caller-abort origin', async () => {
    await quarantine({ kind: 'trusted-runtime', principal: 'core-trusted-runtime', requestId: 'lost-1',
      reason: 'socket hang up' });
    await expect(recoverSettledWatchdogProbes(HOST, { readPs: jest.fn().mockResolvedValue(residentAt(8192)),
      sleep: noSleep, now: LATER })).resolves.toEqual({ recovered: false, reason: 'no quarantined watchdog probe or caller abort' });
    expect(await inferences()).toHaveLength(1);
  });

  test('the cycle view releases a settled caller abort and records it', async () => {
    await callerAbort();
    const host = { id: 'primary', name: 'A', url: HOST };
    const target = new Map();
    const recordEvent = jest.fn();

    await collectRecoveryRequired({ hosts: [host], coordination: await service.listActive(), previous: new Map(),
      target, recordEvent, readPs: jest.fn().mockResolvedValue(residentAt(8192)), now: AFTER_ABORT_WINDOW, sleep: noSleep });

    expect(target.has(HOST)).toBe(false);
    expect(recordEvent).toHaveBeenCalledWith('caller_abort_recovered', host, { models: ['model-a'] });
    expect(await inferences()).toEqual([]);
  });
});
