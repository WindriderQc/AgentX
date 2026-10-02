'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const coordination = require('../../src/services/runtimeCoordinationService');
const priority = require('../../src/services/interactivePriorityService');

const HOST = 'http://host-a:11434';

async function workload() {
  return coordination.acquireWorkload({ principal: 'benchmark-service', requestId: 'batch-a',
    workloadId: 'batch-a', kind: 'benchmark', hosts: [HOST], ttl: 60_000 });
}

function ordinary(requestId, mode = 'shared') {
  return coordination.acquireInference({ principal: 'core-trusted-runtime', requestId, host: HOST,
    model: 'nestor-model', mode });
}

function proof(admission) {
  return { admissionId: admission.admissionId, generation: admission.generation, principal: 'benchmark-service' };
}

describe('household priority over evaluation workloads (#62)', () => {
  beforeEach(async () => {
    await RuntimeCoordination.deleteMany({});
    await RuntimeCoordination.create({ _id: 'runtime', maintenance: null, workloads: [], inferences: [] });
    Object.assign(priority._state, { activeTurns: 0, lastTurnEndedAt: 0, lastBusyAt: 0 });
  });

  afterEach(async () => {
    await RuntimeCoordination.deleteMany({});
  });

  test('a workload keeps the host until it yields at its own prompt boundary', async () => {
    const admission = await workload();
    await expect(ordinary('turn-1')).resolves.toMatchObject({ acquired: false,
      failure: { cause: 'workload_reserved', retryable: true } });
    await expect(priority.yieldPoint({ ...proof(admission), inFlight: 0 }))
      .resolves.toMatchObject({ yield: false, yielded: false });

    await expect(priority.requestYield(HOST)).resolves.toEqual({ requested: true });
    // Core only records the request; a busy owner does not yield yet.
    await expect(priority.yieldPoint({ ...proof(admission), inFlight: 1 }))
      .resolves.toMatchObject({ yield: true, yielded: false });
    await expect(ordinary('turn-2')).resolves.toMatchObject({ acquired: false });

    await expect(priority.yieldPoint({ ...proof(admission), inFlight: 0 }))
      .resolves.toMatchObject({ yield: true, yielded: true, retryAfterMs: 2000 });
    await expect(ordinary('turn-3')).resolves.toMatchObject({ acquired: true });
    await expect(ordinary('exclusive-turn', 'exclusive')).resolves.toMatchObject({ acquired: false });
    await expect(coordination.acquireInference({ principal: 'benchmark-service', requestId: 'prompt-1',
      host: HOST, model: 'nestor-model', workloadAdmissionId: admission.admissionId,
      workloadGeneration: admission.generation })).resolves.toMatchObject({ acquired: false,
      failure: { cause: 'workload_yielded', retryable: true } });
  });

  test('an owner with an admitted request of its own never yields', async () => {
    const admission = await workload();
    await expect(coordination.acquireInference({ principal: 'benchmark-service', requestId: 'prompt-1',
      host: HOST, model: 'candidate', workloadAdmissionId: admission.admissionId,
      workloadGeneration: admission.generation })).resolves.toMatchObject({ acquired: true });
    await priority.requestYield(HOST);
    await expect(priority.yieldPoint({ ...proof(admission), inFlight: 0 }))
      .resolves.toMatchObject({ yield: true, yielded: false });
  });

  test('the workload resumes once household demand is over and the request went stale', async () => {
    const admission = await workload();
    await priority.requestYield(HOST, new Date(Date.now() - 60_000));
    await priority.yieldPoint({ ...proof(admission), inFlight: 0 }, new Date(Date.now() - 59_000));

    // A turn in progress keeps the host even with a stale request.
    const endTurn = priority.beginHouseholdTurn(() => Date.now() - 60_000);
    await expect(priority.yieldPoint({ ...proof(admission), inFlight: 0 }))
      .resolves.toMatchObject({ yield: true, yielded: true });
    endTurn();

    await expect(priority.yieldPoint({ ...proof(admission), inFlight: 0 }))
      .resolves.toMatchObject({ yield: false, yielded: false });
    const stored = (await RuntimeCoordination.findById('runtime').lean()).workloads[0];
    expect(stored).toMatchObject({ yieldRequestedAt: null, yieldedAt: null });
    await expect(ordinary('after-resume')).resolves.toMatchObject({ acquired: false,
      failure: { cause: 'workload_reserved' } });
  });

  test('a yield renews the workload admission and requires its exact proof', async () => {
    const admission = await workload();
    await priority.requestYield(HOST);
    await expect(priority.yieldPoint({ ...proof(admission), generation: 'forged', inFlight: 0 }))
      .resolves.toMatchObject({ yield: false, reason: expect.any(String) });
    const result = await priority.yieldPoint({ ...proof(admission), inFlight: 0, ttl: 600_000 });
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(new Date(admission.expiresAt).getTime());
    await expect(priority.claimYielded({ admissionId: admission.admissionId,
      admissionGeneration: admission.generation })).resolves.toBe(true);
    await expect(priority.claimYielded({ admissionId: admission.admissionId,
      admissionGeneration: 'other' })).resolves.toBe(false);
  });

  test('a turn records busy only after its own start', () => {
    const startedAt = Date.now();
    expect(priority.busySince(startedAt)).toBe(false);
    priority.noteBusy(startedAt + 1);
    expect(priority.busySince(startedAt)).toBe(true);
    expect(priority.householdBusyError(new Error('x'))).toMatchObject({
      code: 'HOUSEHOLD_NESTOR_BUSY', statusCode: 503, message: expect.stringMatching(/^Nestor est occupé/)
    });
  });
});
