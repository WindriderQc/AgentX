'use strict';
const crypto = require('node:crypto');
const Batches = require('../../models/PhotoProcessingBatch');
const Cards = require('../../models/PhotoProcessingCard');
const Runs = require('../../models/PhotoProcessingRun');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const Runtime = require('../../models/RuntimeCoordination');
const worker = require('../../src/services/photos/photoProcessingQueue');
const writer = require('../../src/services/photos/photoProcessingWriter');
const queue = require('../../src/services/heavyWorkQueueService');
const runtime = require('../../src/services/runtimeCoordinationService');
const drain = require('../../src/services/runtimeDrainIntent');
const { createPhotoProcessingWork } = require('../../src/services/photos/photoProcessingWork');
const uuid = () => crypto.randomUUID();
const HOST = 'http://localhost:11434', NAS = 'http://localhost:3180';
const config = () => ({ libraryId: uuidLibrary, originalPathPrefix: '/imports', nasHost: NAS });
const uuidLibrary = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const target = async () => ({ model: 'synthetic-vision', host: HOST });
const deps = { config, target, preDispatch: job => worker.preDispatch(job, { config, target }) };
const lease = () => runtime.acquireMaintenance({ principal: 'operator', requestId: uuid(), scope: 'core-recreate' });
const input = () => ({ operationId: uuid(), runId: uuid(), items: [uuid()] });
const idle = () => Object.fromEntries(['library', 'metadataExtraction', 'thumbnailGeneration', 'smartSearch', 'faceDetection',
  'facialRecognition', 'ocr', 'duplicateDetection', 'videoConversion', 'sidecar', 'workflow', 'backgroundTask', 'search']
  .map(name => [name, { queueStatus: { isActive: false }, jobCounts: { active: 0, waiting: 0, delayed: 0, paused: 0 } }]));
beforeEach(async () => {
  drain.clear();
  process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id: 'nas', endpoints: [NAS] }, { id: 'vision', endpoints: [HOST] }]);
  await Promise.all([Batches, Cards, Runs, Queue, Archive, Runtime].map(model => model.deleteMany({})));
  await Batches.ensureProcessingIndexes();
});
afterEach(() => { drain.clear(); jest.restoreAllMocks(); delete process.env.AGENTX_RUNTIME_RESOURCES_JSON; });

test.each(['index', 'between-images', 'export'])('draining at %s lets the admitted batch finish, holds FIFO and resumes without repeating results', async phase => {
  const first = await worker.enqueue(input(), deps), second = await worker.enqueue(input(), deps);
  const sha256 = 'a'.repeat(64), projected = { sha256, size: 4, relativePath: 'synthetic/image.jpg' };
  const proposal = { description: 'Synthetic landscape', tags: [], quality: 'bonne',
    frameSuitability: 'oui', reasons: [], privacyReview: false };
  let requested = false;
  async function checkpoint(at) {
    if (at !== phase || requested) return;
    requested = true;
    const refused = await lease();
    expect(refused).toMatchObject({ acquired: false });
    expect(refused.blockers).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'core-writer', kind: 'photo-processing', drainable: true, id: first.operationId
    })]));
    drain.request({ scope: 'core-recreate', ttlMs: 60000 });
    const next = jest.fn();
    await worker.sweep({ ...deps, work: { run: next } });
    expect(next).not.toHaveBeenCalled();
    expect((await Batches.findById(second.operationId)).state).toBe('queued');
  }
  const asset = { id: uuid(), libraryId: uuidLibrary, type: 'IMAGE', exifInfo: {} };
  const bridge = { call: jest.fn(async command => {
    if (command.op === 'project') { await checkpoint('index'); return { results: [projected] }; }
    await checkpoint('export'); return { exported: true };
  }) };
  const immich = { validateLibrary: jest.fn(), asset: async () => asset, pendingTag: jest.fn() };
  const client = { json: async p => p === '/jobs' ? idle() : [], image: async () => ({ bytes: Buffer.from('preview'), contentType: 'image/jpeg' }) };
  const inference = { execute: jest.fn(async () => {
    const admission = await runtime.acquireInference({ principal: 'synthetic-photo', requestId: uuid(),
      host: HOST, model: 'synthetic-vision', kind: 'trusted-runtime', caller: 'verified-phone-photo' });
    expect(admission.acquired).toBe(true);
    expect((await lease()).acquired).toBe(false);
    await runtime.releaseInference({ id: admission.admissionId, generation: admission.generation, principal: 'synthetic-photo' });
    return { ok: true, body: { message: { content: JSON.stringify(proposal) } } };
  }) };
  const work = createPhotoProcessingWork({ config, bridge, client, immich, inference });
  // No inference is active here: this is precisely the formerly unprotected
  // interval after storing a result and before exporting/starting another one.
  const originalUpdate = Cards.updateOne.bind(Cards);
  jest.spyOn(Cards, 'updateOne').mockImplementation(async (...args) => {
    const result = await originalUpdate(...args);
    if (args[1]?.$set?.analysis?.state === 'completed') await checkpoint('between-images');
    return result;
  });
  await worker.sweep({ ...deps, client, work, wait: true });
  expect(requested).toBe(true);
  const job = await queue.get(first.queueId);
  expect((await Batches.findById(first.operationId)).state).toBe('completed');
  expect(inference.execute).toHaveBeenCalledTimes(1);
  const observation = await worker.observe(job, { client });
  expect(observation).toMatchObject({ terminal: true, state: 'completed' });
  await queue.settle(job.id, observation, 'test-native-observer');
  const maintenance = await lease();
  expect(maintenance.acquired).toBe(true);
  // Recreate clears process-local drain advice; the durable maintenance lease
  // still prevents any durable slot or effects from starting.
  drain.clear();
  await worker.sweep({ ...deps, client, work, wait: true });
  expect((await Batches.findById(second.operationId)).state).toBe('queued');
  expect(await Batches.countDocuments({ workerSlot: 'photo-processing' })).toBe(0);
  await runtime.release('maintenance', { id: maintenance.leaseId, generation: maintenance.generation, principal: 'operator' });
  await worker.sweep({ ...deps, client, work, wait: true });
  expect((await Batches.findById(second.operationId)).state).toBe('completed');
  expect(inference.execute).toHaveBeenCalledTimes(1);
  expect(await Cards.countDocuments()).toBe(1);
});

test('maintenance and batch admission race atomically in both orders', async () => {
  for (let n = 0; n < 8; n++) {
    await Runtime.deleteMany({});
    const row = { _id: uuid(), queueId: uuid(), processId: uuid(), target: { host: HOST } };
    const calls = [() => writer.acquire(row), lease];
    if (n % 2) calls.reverse();
    const results = await Promise.all(calls.map(call => call()));
    expect(results.filter(result => result === true || result.acquired === true)).toHaveLength(1);
    const saved = await Runtime.findById('runtime').lean();
    expect(Boolean(saved.maintenance) && saved.coreWriters.length > 0).toBe(false);
  }
});

test('a drain arriving during the writer CAS returns the unstarted selection to FIFO', async () => {
  const request = await worker.enqueue(input(), deps);
  const update = Runtime.findOneAndUpdate.bind(Runtime);
  jest.spyOn(Runtime, 'findOneAndUpdate').mockImplementation((...args) => {
    if (args[1]?.$push?.coreWriters) drain.request({ scope: 'core-recreate' });
    return update(...args);
  });
  const run = jest.fn();
  await worker.sweep({ ...deps, work: { run }, wait: true });
  expect(run).not.toHaveBeenCalled();
  expect((await Batches.findById(request.operationId)).state).toBe('queued');
  expect(await Batches.countDocuments({ workerSlot: 'photo-processing' })).toBe(0);
  expect((await Runtime.findById('runtime')).coreWriters).toHaveLength(0);
});

test('uncertain work retains a durable fence after restart/expiry, regardless of an edited terminal queue', async () => {
  const request = await worker.enqueue(input(), deps);
  const run = jest.fn(async () => { throw Error('export response lost'); });
  await worker.sweep({ ...deps, work: { run }, wait: true });
  const row = await Batches.findById(request.operationId).lean();
  expect(row.state).toBe('uncertain');
  drain.clear();
  await runtime.reapExpired(new Date(Date.now() + 86400000));
  await writer.release({ ...row, processId: uuid() }); // A replacement owner cannot release it.
  const refused = await lease();
  expect(refused).toMatchObject({ acquired: false });
  expect(refused.blockers[0]).toMatchObject({ type: 'core-writer', drainable: false, state: 'UNKNOWN' });
  const job = await queue.get(request.queueId);
  await queue.settle(job.id, { state: 'failed', operationId: row._id }, 'test');
  await worker.sweep({ ...deps, work: { run }, wait: true });
  expect(run).toHaveBeenCalledTimes(1);
  expect(await writer.held(row)).toBeTruthy();
});

test('an unstarted reservation failure releases the batch fence and preserves its request', async () => {
  const request = await worker.enqueue(input(), deps);
  const preDispatch = jest.fn(async () => { throw Error('read-only validation unavailable'); });
  await worker.sweep({ ...deps, preDispatch, work: { run: jest.fn() }, wait: true });
  expect((await Batches.findById(request.operationId)).state).toBe('queued');
  expect((await Runtime.findById('runtime')).coreWriters).toHaveLength(0);
  expect((await lease()).acquired).toBe(true);
});

test('a lost begin reply keeps both identities fenced without replaying a batch', async () => {
  const request = await worker.enqueue(input(), deps), run = jest.fn();
  const transport = { ...queue, begin: async (...args) => { await queue.begin(...args); throw Error('begin response lost'); } };
  await worker.sweep({ ...deps, queue: transport, work: { run }, wait: true });
  await worker.sweep({ ...deps, work: { run }, wait: true });
  expect(run).not.toHaveBeenCalled();
  expect((await queue.get(request.queueId)).state).toBe('dispatching');
  expect((await lease()).acquired).toBe(false);
});

test('a lost unstarted slot acknowledgement is reconciled before its maintenance fence releases', async () => {
  const request = await worker.enqueue(input(), deps), update = Batches.findOneAndUpdate.bind(Batches);
  jest.spyOn(Batches, 'findOneAndUpdate').mockImplementation((...args) => ({ lean: async () => {
    const result = await update(...args).lean();
    if (args[1]?.$set?.state === 'claimed') throw Error('slot acknowledgement lost');
    return result;
  } }));
  const run = jest.fn();
  await expect(worker.sweep({ ...deps, work: { run }, wait: true })).rejects.toThrow('slot acknowledgement lost');
  expect(run).not.toHaveBeenCalled();
  expect((await Batches.findById(request.operationId)).state).toBe('queued');
  expect(await Batches.countDocuments({ workerSlot: 'photo-processing' })).toBe(0);
  expect((await lease()).acquired).toBe(true);
});

test('background indexing remains protected after Core has stored its completed batch', async () => {
  const request = await worker.enqueue(input(), deps);
  await worker.sweep({ ...deps, work: { run: async (_row, job) => {
    await Batches.updateOne({ _id: request.operationId, dispatchId: job.dispatchId }, { $set: { state: 'completed' } });
  } }, wait: true });
  const job = await queue.get(request.queueId), busy = idle();
  busy.sidecar.jobCounts.active = 1;
  expect(await worker.observe(job, { client: { json: async () => busy } })).toMatchObject({ terminal: false });
  expect((await lease()).acquired).toBe(false);
  await worker.observe(job, { client: { json: async () => idle() } });
  expect((await lease()).acquired).toBe(true);
});

test('first installation obtains a native FIFO hold only at a natural batch boundary, then resumes that same selection', async () => {
  const first = await worker.enqueue(input(), deps), second = await worker.enqueue(input(), deps);
  await worker.enqueue(input(), deps);
  const run = jest.fn(async (_row, job) => {
    await Batches.updateOne({ _id: job.executor.processingId }, { $set: { state: 'completed' } });
  });
  const client = { json: async () => idle() };
  await worker.sweep({ ...deps, client, work: { run }, wait: true });
  const next = await queue.get(second.queueId), future = new Date(Date.now() + 2 * 3600000).toISOString();
  await expect(queue.reserve(next.id, { expectedRevision: next.revision, start: future }, 'test-bootstrap'))
    .rejects.toMatchObject({ code: 'HEAVY_QUEUE_CONFLICT' });
  const active = await queue.get(first.queueId);
  await queue.settle(active.id, await worker.observe(active, { client }), 'test-native-observer');
  const held = await queue.reserve(next.id, { expectedRevision: next.revision, start: future }, 'test-bootstrap');
  await worker.sweep({ ...deps, client, work: { run }, wait: true });
  expect(run).toHaveBeenCalledTimes(1);
  expect(await Batches.countDocuments({ workerSlot: 'photo-processing' })).toBe(0);
  expect((await Batches.findById(second.operationId)).state).toBe('queued');
  const maintenance = await lease();
  expect(maintenance.acquired).toBe(true);
  await runtime.release('maintenance', { id: maintenance.leaseId, generation: maintenance.generation, principal: 'operator' });
  await queue.reserve(held.id, { expectedRevision: held.revision, start: new Date().toISOString() }, 'test-bootstrap');
  await worker.sweep({ ...deps, client, work: { run }, wait: true });
  expect(run).toHaveBeenCalledTimes(2);
  expect((await Batches.findById(second.operationId)).state).toBe('completed');
});
