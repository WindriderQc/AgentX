'use strict';
const crypto = require('node:crypto');
const Batches = require('../../models/PhotoProcessingBatch'), Cards = require('../../models/PhotoProcessingCard');
const Runs = require('../../models/PhotoProcessingRun'), Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive'), Runtime = require('../../models/RuntimeCoordination');
const worker = require('../../src/services/photos/photoProcessingQueue');
const control = require('../../src/services/photos/photoProcessingControl');
const queue = require('../../src/services/heavyWorkQueueService');
const runtime = require('../../src/services/runtimeCoordinationService');
const drain = require('../../src/services/runtimeDrainIntent');
const { createPhotoProcessingWork } = require('../../src/services/photos/photoProcessingWork');
const uuid = () => crypto.randomUUID();
const HOST = 'http://localhost:11434', NAS = 'http://localhost:3180';
const library = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const config = () => ({ libraryId: library, originalPathPrefix: '/imports', nasHost: NAS, autoProcess: true });
const target = async () => ({ model: 'synthetic-vision', host: HOST });
const deps = { config, target, preDispatch: job => worker.preDispatch(job, { config, target }) };
const input = () => ({ operationId: uuid(), runId: uuid(), items: [uuid()] });
const pause = () => control.pause({ requestId: uuid(), expectedRevision: 0 }, 'synthetic-operator');
const plannedJobs = async () => (await queue.list()).jobs.map(({ presentation, ...job }) => job);
const idle = () => Object.fromEntries(['library', 'metadataExtraction', 'thumbnailGeneration', 'smartSearch', 'faceDetection',
  'facialRecognition', 'ocr', 'duplicateDetection', 'videoConversion', 'sidecar', 'workflow', 'backgroundTask', 'search']
  .map(name => [name, { queueStatus: { isActive: false }, jobCounts: { active: 0, waiting: 0, delayed: 0, paused: 0 } }]));

beforeEach(async () => {
  drain.clear();
  process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id: 'nas', endpoints: [NAS] }, { id: 'vision', endpoints: [HOST] }]);
  await Promise.all([Batches, Cards, Runs, Queue, Archive, Runtime].map(model => model.deleteMany({})));
  await Batches.ensureProcessingIndexes();
});
afterEach(() => { drain.clear(); delete process.env.AGENTX_RUNTIME_RESOURCES_JSON; jest.restoreAllMocks(); });

test('paused FIFO preserves planned identities, selections and reservations without discovery or effects', async () => {
  const first = await worker.enqueue(input(), deps); await worker.enqueue(input(), deps);
  const job = await queue.get(first.queueId);
  await queue.reserve(job.id, { expectedRevision: job.revision, start: new Date(Date.now()+3600000).toISOString() }, 'operator');
  const beforeRows = await Batches.find().sort({ _id: 1 }).lean(), beforeJobs = await plannedJobs();
  await pause();
  const bridge = { call: jest.fn() }, run = jest.fn();
  await worker.sweep({ ...deps, bridge, work: { run } });
  await worker.sweep({ ...deps, bridge, work: { run } });
  expect(bridge.call).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  expect(await Batches.find().sort({ _id: 1 }).lean()).toEqual(beforeRows);
  expect(await plannedJobs()).toEqual(beforeJobs);
  expect((await control.status()).inFlight).toHaveLength(0);
});

test('manual photo pre-dispatch refuses before route probing while paused', async () => {
  const first = await worker.enqueue(input(), deps), job = await queue.get(first.queueId);
  await pause();
  const probe = jest.fn();
  await expect(worker.preDispatch(job, { config, target: probe })).rejects.toMatchObject({ code: 'PHOTO_PROCESSING_PAUSED' });
  await expect(require('../../src/services/heavyWorkQueueEvidence').preDispatch(job)).rejects.toMatchObject({ code: 'PHOTO_PROCESSING_PAUSED' });
  expect(probe).not.toHaveBeenCalled();
  expect((await queue.get(job.id)).state).toBe('requested');
});

test.each(['index', 'between-images', 'export'])('pause at %s lets the admitted batch finish and retains the next until explicit resume', async phase => {
  const first = await worker.enqueue(input(), deps), next = await worker.enqueue(input(), deps);
  const sha256 = 'a'.repeat(64), projection = { sha256, size: 4, relativePath: 'synthetic/image.jpg' };
  const proposal = { description: 'Synthetic landscape', tags: [], quality: 'bonne', frameSuitability: 'oui', reasons: [], privacyReview: false };
  let paused = false;
  async function checkpoint(at) {
    if (phase !== at || paused) return;
    paused = true;
    expect(await pause()).toMatchObject({ paused: true, drained: false });
    const run = jest.fn();
    await worker.sweep({ ...deps, work: { run } });
    expect(run).not.toHaveBeenCalled();
  }
  const bridge = { call: jest.fn(async command => {
    if (command.op === 'runs') return { runs: [] };
    if (command.op === 'project') { await checkpoint('index'); return { results: [projection] }; }
    await checkpoint('export'); return { exported: true };
  }) };
  const asset = { id: uuid(), libraryId: library, type: 'IMAGE', exifInfo: {} };
  const immich = { validateLibrary: jest.fn(), asset: async () => asset, pendingTag: jest.fn() };
  const client = { json: async p => p === '/jobs' ? idle() : [], image: async () => ({ bytes: Buffer.from('synthetic'), contentType: 'image/jpeg' }) };
  const inference = { execute: jest.fn(async () => ({ ok: true, body: { message: { content: JSON.stringify(proposal) } } })) };
  const originalUpdate = Cards.updateOne.bind(Cards);
  jest.spyOn(Cards, 'updateOne').mockImplementation(async (...args) => {
    const result = await originalUpdate(...args);
    if (args[1]?.$set?.analysis?.state === 'completed') await checkpoint('between-images');
    return result;
  });
  const work = createPhotoProcessingWork({ config, bridge, immich, client, inference });
  await worker.sweep({ ...deps, bridge, client, work, wait: true });
  expect(paused).toBe(true);
  expect((await Batches.findById(first.operationId)).state).toBe('completed');
  expect(inference.execute).toHaveBeenCalledTimes(1);
  const job = await queue.get(first.queueId);
  await queue.settle(job.id, await worker.observe(job, { client }), 'synthetic-observer');
  await runtime.reapExpired(new Date(Date.now()+86400000));
  await worker.sweep({ ...deps, bridge, client, work, wait: true });
  expect((await Batches.findById(next.operationId)).state).toBe('queued');
  expect(await Batches.countDocuments({ workerSlot: 'photo-processing' })).toBe(0);
  expect(await control.status()).toMatchObject({ paused: true, drained: true, revision: 1 });
  await control.resume({ requestId: uuid(), expectedRevision: 1, confirmation: control.RESUME }, 'synthetic-operator');
  await worker.sweep({ ...deps, bridge, client, work, wait: true });
  expect((await Batches.findById(next.operationId)).state).toBe('completed');
  expect(inference.execute).toHaveBeenCalledTimes(1); // The retained content result is reused.
});
