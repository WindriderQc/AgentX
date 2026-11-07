'use strict';
const mongoose = require('mongoose');
jest.mock('../../src/services/modelRouterConfig', () => ({
  ensureTaskModelOverridesLoaded: jest.fn(async () => {}),
  resolvePreferredTaskEntry: jest.fn(async () => ({ model: 'synthetic-vision', url: 'http://127.0.0.1:11434' }))
}));
const Imports = require('../../models/HouseholdPlantImport');
const Plant = require('../../models/HouseholdPlant');
const Photo = require('../../models/HouseholdPlantPhoto');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const Runtime = require('../../models/RuntimeCoordination');
const worker = require('../../src/services/householdPlantImportQueue');
const queue = require('../../src/services/heavyWorkQueueService');
const evidence = require('../../src/services/heavyWorkQueueEvidence');
const plants = require('../../src/services/householdPlantService');
const { createPlantAssistant } = require('../../src/services/householdPlantAssistant');
const router = require('../../src/services/modelRouterConfig');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const A = 'http://localhost:11434', B = 'http://localhost:11435';
let execute, assistant;
const answer = () => ({ ok: true, body: { message: { content: '{"candidates":[]}' } }, metadata: { model: 'synthetic-vision' } });
async function imported(index) {
  const { plant } = await plants.create({ nickname: `Synthetic ${index}` });
  await plants.addPhoto({ id: plant.id, expectedRevision: 0, bytes: PNG, mimeType: 'image/png' });
  return (await Imports.create({ _id: String(index).padStart(64, '0'), hashes: [String(index).padStart(64, 'a')],
    plantId: new mongoose.Types.ObjectId(plant.id), nickname: plant.nickname, imported: true, files: [] })).toObject();
}
beforeEach(async () => {
  process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id: 'synthetic-a', endpoints: [A] }, { id: 'synthetic-b', endpoints: [B] }]);
  await Promise.all([Imports, Plant, Photo, Queue, Archive, Runtime].map(model => model.deleteMany({})));
  await Imports.ensureImportIndexes();
  router.resolvePreferredTaskEntry.mockResolvedValue({ model: 'synthetic-vision', url: A });
  execute = jest.fn(async () => answer());
  assistant = createPlantAssistant({ inference: { execute }, consumerContract: 'household-runtime-v1' });
  worker.configure(assistant);
});
afterAll(() => { delete process.env.AGENTX_RUNTIME_RESOURCES_JSON; worker.configure(null); });

test('enrolls one immutable Core request under concurrent retries, without live inference', async () => {
  const row = await imported(1);
  const results = await Promise.all(Array.from({ length: 5 }, () => worker.enroll(row)));
  expect(new Set(results.map(job => job.id)).size).toBe(1);
  expect((await queue.list()).count).toBe(1);
  expect(results[0]).toMatchObject({ state: 'requested', kind: 'other', hosts: [A], executor: { mode: 'plant-identify', importId: row._id } });
  const { plant } = await plants.get({ id: String(row.plantId), view: 'manage' });
  expect(plant.assistant.identify).toMatchObject({ state: 'queued', queueId: results[0].id });
  await expect(assistant.identify({ id: plant.id })).rejects.toMatchObject({ code: 'PLANT_ASSIST_QUEUED' });
  expect(execute).not.toHaveBeenCalled();
});

test('serializes different plants through the Core fence, retaining native inference and release evidence', async () => {
  const first = await imported(1), second = await imported(2);
  const one = await worker.enroll(first), two = await worker.enroll(second);
  let release;
  execute.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(answer()); }));
  await Promise.all([worker.sweep(), worker.sweep(), worker.sweep()]);
  // Wait until the asynchronous native step reaches the fake provider.
  for (let i = 0; i < 40 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(execute).toHaveBeenCalledTimes(1);
  const running = await queue.get(one.id);
  expect(running.state).toBe('running');
  expect((await queue.get(two.id)).state).toBe('requested');
  expect(execute.mock.calls[0][0]).toMatchObject({ model: 'synthetic-vision', taskType: 'plant_identify' });
  expect(execute.mock.calls[0][1]).toMatchObject({ hostUrl: A, sourcePolicy: 'local-only' });
  release();
  for (let i = 0; i < 40 && (await Imports.findById(first._id)).state !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await worker.sweep(); // the lane stays held until queue reconciliation
  expect(execute).toHaveBeenCalledTimes(1);
  expect((await evidence.reconcile(one.id, 'test')).state).toBe('completed');
  await worker.sweep({ wait: true });
  expect(execute).toHaveBeenCalledTimes(2);
  expect((await evidence.reconcile(two.id, 'test')).state).toBe('completed');
  await worker.sweep();
  expect(await Imports.countDocuments({ workerSlot: 'plant-identify' })).toBe(0);
  expect(await plants.list({ view: 'child' })).toEqual({ plants: [] });
});

test('lost submit responses reconcile the same intent after routing changes', async () => {
  const row = await imported(1);
  const submit = jest.fn(async (...args) => { await queue.submit(...args); throw new Error('lost response'); });
  await expect(worker.enroll(row, { queue: { submit } })).rejects.toThrow('lost response');
  router.resolvePreferredTaskEntry.mockResolvedValue({ model: 'changed-synthetic', url: B });
  const prior = await Imports.findById(row._id).lean();
  const reconciled = await worker.enroll(prior);
  expect(reconciled.hosts).toEqual([A]);
  expect((await queue.list()).count).toBe(1);
  await expect(evidence.preDispatch(reconciled)).rejects.toMatchObject({ code: 'HEAVY_QUEUE_EXECUTOR_CHANGED' });
  expect(execute).not.toHaveBeenCalled();
});

test('resource conflicts wait without inference or clearing an existing owner', async () => {
  const row = await imported(1), job = await worker.enroll(row);
  let blocker = await queue.submit({ key: 'synthetic-blocker', title: 'Synthetic reservation', kind: 'other', hosts: [A], estimatedMinutes: 15,
    source: { type: 'coding' }, executor: { mode: 'operator', receiptRef: 'synthetic-receipt' } }, 'test');
  blocker = await queue.reserve(blocker.id, { expectedRevision: blocker.revision, start: new Date().toISOString() }, 'test');
  await worker.sweep({ wait: true });
  expect((await queue.get(job.id)).state).toBe('requested');
  expect(execute).not.toHaveBeenCalled();
  expect(await Imports.countDocuments({ workerSlot: 'plant-identify' })).toBe(0);
  expect((await queue.get(blocker.id)).state).toBe('reserved');
});

test('dispatch gaps and disappeared processes keep the global lane fenced and never relaunch', async () => {
  const first = await imported(1), second = await imported(2);
  const job = await worker.enroll(first); await worker.enroll(second);
  const reserved = await queue.reserve(job.id, { expectedRevision: job.revision, start: new Date().toISOString() }, 'test');
  const begun = await queue.begin(job.id, { expectedRevision: reserved.revision }, 'test');
  await Imports.updateOne({ _id: first._id }, { $set: { state: 'running', workerSlot: 'plant-identify', dispatchId: begun.dispatchId, processId: 'gone-process' } });
  expect((await evidence.reconcile(job.id, 'test')).state).toBe('uncertain');
  await worker.sweep(); await worker.sweep();
  expect(execute).not.toHaveBeenCalled();
  expect(await Imports.countDocuments({ workerSlot: 'plant-identify' })).toBe(1);
});

test('failed identification is recorded; runtime quarantine prevents lane release and the next plant', async () => {
  const first = await imported(1), second = await imported(2);
  const job = await worker.enroll(first); await worker.enroll(second);
  execute.mockRejectedValueOnce(Object.assign(new Error('synthetic vision unavailable'), { code: 'INFERENCE_VISION_REQUIRED' }));
  await worker.sweep({ wait: true });
  expect((await Imports.findById(first._id)).state).toBe('failed');
  await Runtime.collection.insertOne({ _id: 'runtime', revision: 0, inferences: [{ id: 'synthetic-held', host: A, state: 'UNKNOWN', expiresAt: new Date(Date.now() + 60000) }] });
  expect((await evidence.reconcile(job.id, 'test')).state).toBe('uncertain');
  await worker.sweep(); expect(execute).toHaveBeenCalledTimes(1);
  await Runtime.deleteMany({});
  expect((await evidence.reconcile(job.id, 'test')).state).toBe('failed');
  await worker.sweep({ wait: true }); expect(execute).toHaveBeenCalledTimes(2);
});

test('cancelled requests and retired drafts stop waiting without blocking the next plant', async () => {
  const first = await imported(1), second = await imported(2), third = await imported(3);
  const one = await worker.enroll(first), two = await worker.enroll(second), three = await worker.enroll(third);
  await queue.cancel(one.id, { expectedRevision: one.revision }, 'test');
  await Plant.updateOne({ _id: second.plantId }, { $set: { status: 'retired' } });
  await worker.sweep({ wait: true });
  expect((await queue.get(two.id)).state).toBe('cancelled');
  expect((await Plant.findById(first.plantId)).assistant.identify.state).toBe('failed');
  expect(execute).not.toHaveBeenCalled();
  await worker.sweep({ wait: true });
  expect(execute).toHaveBeenCalledTimes(1);
  expect((await queue.get(three.id)).state).toBe('running');
});

test('an expired planned window never launches identification', async () => {
  const row = await imported(1), job = await worker.enroll(row);
  await queue.reserve(job.id, { expectedRevision: job.revision, start: new Date(Date.now() - 4 * 60000).toISOString() }, 'test');
  await Queue.updateOne({ _id: 'heavy-work', 'jobs.id': job.id }, { $set: { 'jobs.$.reservation.end': new Date(Date.now() - 1000).toISOString() } });
  await worker.sweep({ wait: true });
  expect(execute).not.toHaveBeenCalled();
  expect((await Imports.findById(row._id)).state).toBe('queued');
  expect(await Imports.countDocuments({ workerSlot: 'plant-identify' })).toBe(0);
});
