'use strict';

const { randomUUID } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const Runtime = require('../../models/RuntimeCoordination');
const coordination = require('../../src/services/runtimeCoordinationService');
const control = require('../../src/services/judgeCalibrationControl');
const { handleOwnerMcp } = require('../../src/services/mcpOwnerTools');
const A = 'http://judge-a:11434';
const B = 'http://judge-b:11434';

async function acquire(host = A, extra = {}) {
  const workloadId = `judge-accuracy-calibration:${randomUUID()}`;
  const item = await coordination.acquireWorkload({ principal: 'benchmark-service', requestId: randomUUID(),
    workloadId, kind: 'judge', hosts: [host], ttl: 60_000, ...extra });
  expect(item.acquired).toBe(true);
  return item;
}
const proof = item => ({ id: item.admissionId, generation: item.generation, principal: item.principal });
const cancelInput = item => ({ action: 'cancel', id: item.admissionId, workloadId: item.workloadId,
  requestId: randomUUID(), reason: 'Owner requested this calibration to stop.' });
const app = express();
app.use(express.json());
app.use('/api/nerve-center', require('../../routes/nerve-center-judge-calibrations'));

beforeEach(async () => {
  await Runtime.deleteMany({});
  await Runtime.create({ _id: 'runtime' });
});
afterEach(() => jest.restoreAllMocks());

test('read-only discovery exposes identities and native state without ownership secrets', async () => {
  const item = await acquire();
  await acquire(B, { kind: 'benchmark', batchId: 'batch-other', workloadId: 'other-batch' });
  const before = await Runtime.findById('runtime').lean();
  const result = await control.operate({ action: 'list' });
  expect(result.calibrations).toEqual([expect.objectContaining({ admissionId: item.admissionId,
    workloadId: item.workloadId, state: 'owned', released: false })]);
  expect(JSON.stringify(result)).not.toContain(item.generation);
  expect(JSON.stringify(result)).not.toContain(item.recoveryGeneration);
  expect(await Runtime.findById('runtime').lean()).toEqual(before);
});

test('rejects ambiguous identities, invalid arguments and non-calibration owners before writing', async () => {
  const item = await acquire();
  const input = cancelInput(item);
  const before = await Runtime.findById('runtime').lean();
  for (const change of [{ id: randomUUID() }, { workloadId: `judge-calibration:${randomUUID()}` },
    { requestId: 'unstable' }, { reason: '' }, { reason: 'x'.repeat(301) }, { restart: true }]) {
    await expect(control.operate({ ...input, ...change })).rejects.toHaveProperty('code');
  }
  await expect(control.operate({ action: 'list', id: item.admissionId })).rejects.toHaveProperty('code');
  await expect(control.operate({ action: 'show', id: item.admissionId, requestId: randomUUID() })).rejects.toHaveProperty('code');
  expect(await Runtime.findById('runtime').lean()).toEqual(before);
  const other = await acquire(B, { kind: 'benchmark', workloadId: 'batch-other' });
  await expect(control.operate(cancelInput(other))).rejects.toHaveProperty('code', 'CALIBRATION_NOT_FOUND');
});

test('an accepted stop fences only the exact admission, preserving other hosts and every quarantine', async () => {
  const target = await acquire();
  const other = await acquire(B);
  const inference = await coordination.acquireInference({ principal: target.principal, requestId: randomUUID(),
    host: A, model: 'synthetic-judge', workloadAdmissionId: target.admissionId, workloadGeneration: target.generation });
  expect(inference.acquired).toBe(true);
  await coordination.markInferenceUnknown({ id: inference.admissionId, generation: inference.generation,
    principal: target.principal, reason: 'fixture uncertain native result' });
  const before = await Runtime.findById('runtime').lean();
  const result = await control.operate(cancelInput(target));
  expect(result).toMatchObject({ accepted: true, calibration: { state: 'cancellation_requested',
    released: false, recoveryRequired: true } });
  await expect(coordination.heartbeat('workload', proof(target))).resolves.toMatchObject({
    heartbeat: false, code: 'WORKLOAD_CANCEL_REQUESTED' });
  await expect(coordination.heartbeat('workload', proof(other))).resolves.toMatchObject({ heartbeat: true });
  await expect(coordination.assertWorkloadAdmission({ ...proof(target), workloadId: target.workloadId, host: A }))
    .resolves.toMatchObject({ admitted: false });
  await expect(coordination.acquireInference({ principal: target.principal, requestId: randomUUID(), host: A,
    model: 'synthetic-judge', workloadAdmissionId: target.admissionId, workloadGeneration: target.generation }))
    .resolves.toMatchObject({ acquired: false });
  await expect(coordination.acquireInference({ principal: other.principal, requestId: randomUUID(), host: B,
    model: 'synthetic-judge', workloadAdmissionId: other.admissionId, workloadGeneration: other.generation }))
    .resolves.toMatchObject({ acquired: true });
  const after = await Runtime.findById('runtime').lean();
  expect(after.workloads.find(w => w.admissionId === target.admissionId).expiresAt)
    .toEqual(before.workloads.find(w => w.admissionId === target.admissionId).expiresAt);
  expect(after.inferences.find(i => i.admissionId === inference.admissionId))
    .toEqual(before.inferences.find(i => i.admissionId === inference.admissionId));
  await expect(coordination.release('workload', proof(target))).resolves.toMatchObject({ released: false });
  await expect(coordination.acquireMaintenance({ principal: 'operator', requestId: randomUUID(), scope: 'runtime-deploy' }))
    .resolves.toMatchObject({ acquired: false });
});

test('a cancelled owner cannot dispatch another inference even with no prior inference', async () => {
  const target = await acquire();
  await control.operate(cancelInput(target));
  await expect(coordination.acquireInference({ principal: target.principal, requestId: randomUUID(), host: A,
    model: 'synthetic-judge', workloadAdmissionId: target.admissionId, workloadGeneration: target.generation }))
    .resolves.toMatchObject({ acquired: false });
  expect((await Runtime.findById('runtime').lean()).inferences).toHaveLength(0);
});

test('concurrent stop requests commit one immutable intent; a lost response reuses it', async () => {
  const target = await acquire();
  const inputs = [cancelInput(target), cancelInput(target)];
  const results = await Promise.allSettled(inputs.map(input => control.operate(input)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const winner = inputs[results.findIndex(r => r.status === 'fulfilled')];
  const first = await control.operate(winner);
  const repeated = await control.operate(winner);
  expect(first).toMatchObject({ accepted: true, idempotent: true });
  expect(repeated.calibration.cancellation).toEqual(first.calibration.cancellation);
  await expect(control.operate({ ...winner, reason: 'Different intent' }))
    .rejects.toHaveProperty('code', 'CALIBRATION_CANCELLATION_CONFLICT');
  // Another Core process reconstructs the same intent from Mongo.
  expect((await Runtime.findById('runtime').lean()).workloads[0].cancellation.requestId).toBe(winner.requestId);
});

test('stop survives expiry and never converts expiration into successful cancellation', async () => {
  const target = await acquire();
  const input = cancelInput(target);
  await control.operate(input);
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { 'workloads.0.expiresAt': new Date(0) } });
  await coordination.reapExpired();
  const result = await control.operate({ action: 'show', id: target.admissionId });
  expect(result.calibration).toMatchObject({ state: 'cancellation_requested', released: false,
    recoveryState: 'UNKNOWN', cancellation: { requestId: input.requestId } });
  await expect(coordination.release('workload', proof(target))).resolves.toMatchObject({ released: false });
});

test('native release retains the cancellation receipt and replay never targets a replacement', async () => {
  const target = await acquire();
  const input = cancelInput(target);
  await control.operate(input);
  await expect(coordination.release('workload', proof(target))).resolves.toMatchObject({ released: true });
  const replacement = await acquire();
  const result = await control.operate(input);
  expect(result).toMatchObject({ accepted: true, idempotent: true,
    calibration: { released: true, state: 'released', cancellation: { requestId: input.requestId } } });
  expect((await Runtime.findById('runtime').lean()).workloads.find(w => w.admissionId === replacement.admissionId).cancellation).toBeNull();
});

test('cancellation racing normal release cannot be lost from its native receipt', async () => {
  const target = await acquire();
  const input = cancelInput(target);
  const original = Runtime.findOneAndUpdate.bind(Runtime);
  jest.spyOn(Runtime, 'findOneAndUpdate').mockImplementationOnce((filter, update, options) => ({
    lean: async () => {
      await control.operate(input);
      return original(filter, update, options).lean();
    }
  }));
  await expect(coordination.release('workload', proof(target))).resolves.toMatchObject({ released: false });
  await expect(coordination.release('workload', proof(target))).resolves.toMatchObject({ released: true });
  expect((await control.operate(input)).calibration.cancellation.requestId).toBe(input.requestId);
});

test('native recovery release retains stop evidence', async () => {
  const target = await acquire();
  const input = cancelInput(target);
  await control.operate(input);
  await Runtime.updateOne({ _id: 'runtime' }, { $set: {
    'workloads.0.recoveryState': 'RESTORED', 'workloads.0.recoveryReceipt': { verified: true }
  } });
  await expect(coordination.resolveWorkloadRecovery({ recoveryId: target.recoveryId,
    recoveryGeneration: target.recoveryGeneration, principal: target.principal })).resolves.toMatchObject({ released: true });
  expect((await control.operate(input)).calibration).toMatchObject({ released: true,
    cancellation: { requestId: input.requestId } });
});

test('one cancellation requestId cannot race onto two different calibrations', async () => {
  const a = await acquire();
  const b = await acquire(B);
  const first = cancelInput(a);
  const second = { ...cancelInput(b), requestId: first.requestId };
  const results = await Promise.allSettled([control.operate(first), control.operate(second)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected').reason.code).toBe('CALIBRATION_CANCELLATION_CONFLICT');
});

test('native recovery release refuses an unresolved child inference after cancellation', async () => {
  const target = await acquire();
  const inference = await coordination.acquireInference({ principal: target.principal, requestId: randomUUID(), host: A,
    model: 'synthetic-judge', workloadAdmissionId: target.admissionId, workloadGeneration: target.generation });
  await coordination.markInferenceUnknown({ id: inference.admissionId, generation: inference.generation,
    principal: target.principal, reason: 'fixture uncertain child' });
  await control.operate(cancelInput(target));
  await Runtime.updateOne({ _id: 'runtime' }, { $set: {
    'workloads.0.recoveryState': 'RESTORED', 'workloads.0.recoveryReceipt': { verified: true }
  } });
  await expect(coordination.resolveWorkloadRecovery({ recoveryId: target.recoveryId,
    recoveryGeneration: target.recoveryGeneration, principal: target.principal })).resolves.toMatchObject({ released: false });
  const state = await Runtime.findById('runtime').lean();
  expect(state.workloads).toHaveLength(1);
  expect(state.inferences[0]).toMatchObject({ admissionId: inference.admissionId, state: 'UNKNOWN' });
});

test('stop racing recovery release is retained rather than silently omitted from its receipt', async () => {
  const target = await acquire();
  const input = cancelInput(target);
  await Runtime.updateOne({ _id: 'runtime' }, { $set: {
    'workloads.0.recoveryState': 'RESTORED', 'workloads.0.recoveryReceipt': { verified: true }
  } });
  const original = Runtime.findOneAndUpdate.bind(Runtime);
  jest.spyOn(Runtime, 'findOneAndUpdate').mockImplementationOnce((filter, update, options) => ({
    lean: async () => { await control.operate(input); return original(filter, update, options).lean(); }
  }));
  const recovery = { recoveryId: target.recoveryId, recoveryGeneration: target.recoveryGeneration, principal: target.principal };
  await expect(coordination.resolveWorkloadRecovery(recovery)).resolves.toMatchObject({ released: false });
  await expect(coordination.resolveWorkloadRecovery(recovery)).resolves.toMatchObject({ released: true });
  expect((await control.operate(input)).calibration.cancellation.requestId).toBe(input.requestId);
});

test('HTTP and owner MCP use the same control; acceptance is 202 and never completion', async () => {
  const target = await acquire();
  const { id, action, ...body } = cancelInput(target);
  const path = `/api/nerve-center/judge-calibrations/${id}`;
  await request(app).get(path).expect(200);
  const result = await request(app).post(`${path}/cancel`).send(body).expect(202);
  expect(result.body.data.calibration).toMatchObject({ state: 'cancellation_requested', released: false });
  const call = args => handleOwnerMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'judge_calibration', arguments: args } });
  expect((await call({ action, id, ...body })).result.structuredContent).toMatchObject({ accepted: true, idempotent: true });
  expect((await call({ action: 'show', id })).result.structuredContent.calibration.released).toBe(false);
  expect((await call({ action, id, ...body, restart: true })).result.isError).toBe(true);
  await request(app).post(`${path}/cancel`).send({ ...body, generation: target.generation }).expect(400);
  await request(app).post(`${path}/cancel`).send({ ...body, id: randomUUID() }).expect(400);
});

test('deploy blockers advertise the exact cancel route then native recovery after acceptance', async () => {
  const target = await acquire();
  expect((await coordination.listDeployBlockers({ service: 'benchmark' })).blockers[0].cancel)
    .toContain(`/judge-calibrations/${target.admissionId}/cancel`);
  await control.operate(cancelInput(target));
  expect((await coordination.listDeployBlockers({ service: 'benchmark' })).blockers[0].cancel)
    .toContain('cancellation requested');
});
