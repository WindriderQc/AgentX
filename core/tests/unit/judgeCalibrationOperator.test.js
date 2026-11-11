'use strict';
const { randomUUID } = require('node:crypto');
const Runtime = require('../../models/RuntimeCoordination');
const service = require('../../src/services/runtimeCoordinationService');
const operator = require('../../src/services/judgeCalibrationOperator');
const control = require('../../src/services/judgeCalibrationControl');
const HOST = 'http://judge-a:11434', OTHER = 'http://judge-b:11434';

async function fixture() {
  const a = await service.acquireWorkload({ principal: 'benchmark-service', requestId: randomUUID(),
    workloadId: 'judge-accuracy-calibration:' + randomUUID(), kind: 'judge', hosts: [HOST] });
  const armed = await service.armWorkloadRecovery({ id: a.admissionId, generation: a.generation,
    principal: a.principal, recoveryRequestId: a.recoveryRequestId });
  await service.transitionWorkloadRecovery({ recoveryId: armed.recoveryId,
    recoveryGeneration: armed.recoveryGeneration, principal: a.principal, expectedVersion: 0, state: 'MUTATING' });
  const input = { id: a.admissionId, workloadId: a.workloadId, requestId: randomUUID(), reason: 'Stop only this calibration.' };
  return { a, input };
}
async function child(a, origin = 'caller-abort') {
  const i = await service.acquireInference({ principal: a.principal, requestId: randomUUID(), host: HOST,
    model: 'synthetic-judge', workloadAdmissionId: a.admissionId, workloadGeneration: a.generation,
    runtimeOptions: { num_ctx: 8192 } });
  expect(i.acquired).toBe(true);
  await service.markInferenceUnknown({ id: i.admissionId, generation: i.generation, principal: a.principal,
    reason: 'Synthetic ambiguous request', origin });
  await Runtime.updateOne({ _id: 'runtime', 'inferences.admissionId': i.admissionId },
    { $set: { 'inferences.$.unknownAt': new Date(Date.now() - 11 * 60000) } });
  return i;
}
beforeEach(async () => { await Runtime.deleteMany({}); await Runtime.create({ _id: 'runtime' }); });

test('native legacy handoff expires only the cancelled owner and preserves all child quarantine', async () => {
  const { a, input } = await fixture();
  const i = await child(a);
  const b = await service.acquireWorkload({ principal: a.principal, requestId: randomUUID(),
    workloadId: 'judge-calibration:' + randomUUID(), kind: 'judge', hosts: [OTHER] });
  const before = await Runtime.findById('runtime').lean();
  const result = await operator.operate('cancel', input, 'operator-fixture');
  expect(result.handoff).toMatchObject({ transitioned: true, recoveryState: 'UNKNOWN' });
  const after = await Runtime.findById('runtime').lean();
  expect(after.inferences).toEqual(before.inferences);
  expect(after.workloads.find(w => w.admissionId === b.admissionId)).toEqual(before.workloads.find(w => w.admissionId === b.admissionId));
  const row = after.workloads.find(w => w.admissionId === a.admissionId);
  expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  expect(row.recoveryReceipt.requestId).toBe(input.requestId);
  expect(after.inferences[0].admissionId).toBe(i.admissionId);
  // This predicate is also used by the pre-cancellation Core heartbeat.
  expect(await Runtime.findOne({ _id: 'runtime', workloads: { $elemMatch: {
    admissionId: a.admissionId, generation: a.generation, expiresAt: { $gt: new Date() }
  } } })).toBeNull();
  const replay = await operator.operate('cancel', input, 'operator-fixture');
  expect(replay.idempotent).toBe(true);
  expect((await Runtime.findById('runtime').lean()).workloads.find(w => w.admissionId === a.admissionId).recoveryVersion).toBe(row.recoveryVersion);
});

test('settling uses two real-shaped residency samples, releases only the closed child, and keeps the parent', async () => {
  const { a, input } = await fixture(); const i = await child(a);
  await operator.operate('cancel', input, 'operator-fixture');
  const readPs = jest.fn().mockResolvedValue([]);
  const result = await operator.operate('settle', input, 'operator-fixture', { readPs, sleep: async () => {} });
  expect(result.recoveries[0].result.recovered).toBe(true); expect(readPs).toHaveBeenCalledTimes(2);
  const row = await Runtime.findById('runtime').select('+releaseReceipts').lean();
  expect(row.workloads).toHaveLength(1); expect(row.inferences).toHaveLength(0);
  expect(row.releaseReceipts.at(-1)).toMatchObject({ admissionId: i.admissionId, unknownOrigin: 'caller-abort',
    parentWorkload: { admissionId: a.admissionId } });
});

test('settle cannot create a cancellation, touch a different intent or settle a live owner', async () => {
  const { a, input } = await fixture(); await child(a);
  const before = await Runtime.findById('runtime').lean();
  await expect(operator.operate('settle', input, 'operator-fixture')).rejects.toThrow(/matching cancellation/);
  expect(await Runtime.findById('runtime').lean()).toEqual(before);
  await control.operate({ ...input, action: 'cancel' });
  const readPs = jest.fn();
  const result = await operator.operate('settle', input, 'operator-fixture', { readPs });
  expect(result.reason).toMatch(/live admission/); expect(readPs).not.toHaveBeenCalled();
  await expect(operator.operate('settle', { ...input, requestId: randomUUID() }, 'operator-fixture')).rejects.toThrow();
});

test('an ambiguous inference without a closed-connection origin remains quarantined', async () => {
  const origin = null;
  const { a, input } = await fixture(); await child(a, origin);
  await operator.operate('cancel', input, 'operator-fixture');
  const result = await operator.operate('settle', input, 'operator-fixture', { readPs: async () => [], sleep: async () => {} });
  expect(result.recoveries[0].result.recovered).toBe(false);
  expect((await Runtime.findById('runtime').lean()).inferences).toHaveLength(1);
});

test('a recent abort still waits the full settle window even after an accepted stop', async () => {
  const { a, input } = await fixture(); const i = await child(a);
  await Runtime.updateOne({ _id: 'runtime', 'inferences.admissionId': i.admissionId },
    { $set: { 'inferences.$.unknownAt': new Date() } });
  await operator.operate('cancel', input, 'operator-fixture');
  const readPs = jest.fn().mockResolvedValue([]);
  const result = await operator.operate('settle', input, 'operator-fixture', { readPs, sleep: async () => {} });
  expect(result.recoveries[0].result.recovered).toBe(false); expect(readPs).not.toHaveBeenCalled();
  expect((await Runtime.findById('runtime').lean()).inferences).toHaveLength(1);
});

test('other native inference on the host prevents settlement and is preserved', async () => {
  const { a, input } = await fixture(); await child(a);
  await operator.operate('cancel', input, 'operator-fixture');
  const before = await Runtime.findById('runtime').lean();
  const extra = { ...before.inferences[0], admissionId: randomUUID(), generation: randomUUID(),
    principal: 'another-native-owner', state: 'ACTIVE' };
  await Runtime.updateOne({ _id: 'runtime' }, { $push: { inferences: extra } });
  const result = await operator.operate('settle', input, 'operator-fixture', { readPs: async () => [], sleep: async () => {} });
  expect(result.recoveries[0].result.recovered).toBe(false);
  expect((await Runtime.findById('runtime').lean()).inferences).toHaveLength(2);
});

test('a changed cancellation during the two runtime reads cannot release its old child proof', async () => {
  const { a, input } = await fixture(); await child(a);
  await operator.operate('cancel', input, 'operator-fixture');
  let reads = 0;
  const readPs = async () => {
    if (++reads === 2) await Runtime.updateOne({ _id: 'runtime', 'workloads.admissionId': a.admissionId },
      { $set: { 'workloads.$.cancellation.requestId': randomUUID() } });
    return [];
  };
  const result = await operator.operate('settle', input, 'operator-fixture', { readPs, sleep: async () => {} });
  expect(result.recoveries[0].result.recovered).toBe(false);
  expect((await Runtime.findById('runtime').lean()).inferences).toHaveLength(1);
});

test('legacy native release is observed without fabricating its lost cancellation metadata', async () => {
  const { a, input } = await fixture();
  await Runtime.updateOne({ _id: 'runtime' }, { $pull: { workloads: { admissionId: a.admissionId } },
    $push: { releaseReceipts: { coordinationKind: 'workload', released: true, admissionId: a.admissionId,
      workloadId: a.workloadId, generation: a.generation, principal: a.principal, kind: 'judge', hosts: [HOST], releasedAt: new Date() } } });
  const result = await operator.operate('settle', input, 'operator-fixture');
  expect(result).toMatchObject({ alreadyReleased: true, cancellationConfirmed: false });
});
