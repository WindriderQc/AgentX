'use strict';
// Island runs (docs/ISLAND.md): a typed executor on kind "other" that the
// operator CLI starts and finishes with an attested receipt.
const Queue = require('../../models/HeavyWorkQueue');
const Runtime = require('../../models/RuntimeCoordination');
const queue = require('../../src/services/heavyWorkQueueService');
const evidence = require('../../src/services/heavyWorkQueueEvidence');
const launcher = require('../../src/services/heavyWorkQueueLauncher');
const { validateRequest } = require('../../src/services/heavyWorkQueueContract');

const A = 'http://127.0.0.1:11434';
const executor = { mode: 'island', receiptRef: 'island/synthetic.json', agent: 'Eko', minutes: 60 };
const request = (extra = {}) => ({ key: 'synthetic-island', title: 'Synthetic island run', kind: 'other', hosts: [A],
  estimatedMinutes: 70, source: { type: 'operator', ref: 'benchmark-island-tab' }, executor, ...extra });
const finish = job => ({ expectedRevision: job.revision, dispatchId: job.dispatchId, state: 'completed',
  receiptRef: executor.receiptRef, receiptSha256: 'b'.repeat(64), confirmation: 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED' });

beforeEach(async () => { await Promise.all([Queue, Runtime].map(model => model.deleteMany({}))); });

test('the island executor is typed: defaults explicit; unknown fields, short time and model names refused', () => {
  const { request: saved } = validateRequest(request());
  expect(saved.executor).toEqual({ ...executor, memory: 'continue', world: 'mesa-island', harness: 'codex' });
  for (const harness of ['dsh', 'pi']) {
    expect(validateRequest(request({ executor: { ...executor, harness } })).request.executor.harness).toBe(harness);
  }
  expect(() => validateRequest(request({ executor: { ...executor, harness: 'claude' } }))).toThrow(/codex, dsh or pi/);
  expect(() => validateRequest(request({ estimatedMinutes: 60 }))).toThrow(/at least 70/);
  expect(() => validateRequest(request({ executor: { ...executor, model: 'any-model' } }))).toThrow(/unsupported fields/);
  expect(() => validateRequest(request({ executor: { ...executor, command: 'rm -rf /' } }))).toThrow(/unsupported fields/);
  expect(() => validateRequest(request({ executor: { ...executor, minutes: 2 } }))).toThrow(/minutes/);
  expect(() => validateRequest(request({ executor: { ...executor, receiptRef: undefined } }))).toThrow(/receiptRef/);
  expect(() => validateRequest(request({ kind: 'diagnostic' }))).toThrow(/operator executor/);
});

test('an island run crosses the fence, refuses Core launch and finishes only by attestation after release', async () => {
  const job = await queue.submit(request(), 'fixture');
  const slot = await queue.reserve(job.id, { expectedRevision: job.revision, start: new Date().toISOString() }, 'fixture');
  await expect(launcher.launch(slot.id, 'fixture', { expectedRevision: slot.revision }))
    .rejects.toMatchObject({ code: 'HEAVY_QUEUE_LAUNCH_UNSUPPORTED' });
  await expect(evidence.preDispatch(slot)).resolves.toBeUndefined();
  const begun = await queue.begin(slot.id, { expectedRevision: slot.revision }, 'fixture');
  await queue.record(begun.id, { dispatchId: begun.dispatchId, state: 'running', operationId: `island:${begun.id}` }, 'fixture');
  const running = await queue.get(begun.id);
  // Core cannot observe the runner; only the operator attestation settles it.
  await expect(evidence.observe(running)).rejects.toMatchObject({ statusCode: 409 });
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [{ host: A, state: 'ACTIVE', expiresAt: new Date(Date.now() + 60000) }] });
  await expect(queue.operatorFinish(running.id, finish(running), 'fixture')).rejects.toMatchObject({ statusCode: 409 });
  await Runtime.deleteMany({});
  await expect(queue.operatorFinish(running.id, finish(running), 'fixture'))
    .rejects.toMatchObject({ code: 'HEAVY_QUEUE_RELEASE_UNAVAILABLE' });
  expect((await queue.get(running.id)).state).toBe('running');
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [] });
  await expect(queue.operatorFinish(running.id, { ...finish(running), receiptRef: 'other' }, 'fixture'))
    .rejects.toMatchObject({ statusCode: 409 });
  const done = await queue.operatorFinish(running.id, finish(running), 'fixture');
  expect(done.state).toBe('completed');
  expect(done.operation).toMatchObject({ kind: 'island', authority: 'operator-attestation' });
  expect(done.releaseReceipt.receiptSha256).toBe('b'.repeat(64));
});

test('terminal attestation refuses a malformed runtime record even after an earlier release read', async () => {
  const submitted = await queue.submit(request(), 'fixture');
  const slot = await queue.reserve(submitted.id, { expectedRevision: submitted.revision, start: new Date().toISOString() }, 'fixture');
  const begun = await queue.begin(slot.id, { expectedRevision: slot.revision }, 'fixture');
  await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [] });
  expect((await queue.operatorRelease(begun.id, begun.dispatchId)).runtimeReleased).toBe(true);
  // Native storage is no longer a complete observation at the terminal boundary.
  await Runtime.collection.updateOne({ _id: 'runtime' }, { $set: { inferences: null } });
  await expect(queue.operatorFinish(begun.id, finish(begun), 'fixture'))
    .rejects.toMatchObject({ code: 'HEAVY_QUEUE_RELEASE_UNAVAILABLE' });
  expect((await queue.get(begun.id)).state).toBe('dispatching');
});
