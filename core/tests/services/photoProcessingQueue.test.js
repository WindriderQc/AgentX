'use strict';
const crypto = require('node:crypto');
const Batches = require('../../models/PhotoProcessingBatch');
const Cards = require('../../models/PhotoProcessingCard');
const Runs = require('../../models/PhotoProcessingRun');
const Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive');
const Runtime = require('../../models/RuntimeCoordination');
const worker = require('../../src/services/photos/photoProcessingQueue');
const queue = require('../../src/services/heavyWorkQueueService');
const { createPhotoProcessingWork } = require('../../src/services/photos/photoProcessingWork');
const uuid = () => crypto.randomUUID();
const A = 'http://localhost:11434', NAS = 'http://localhost:3180';
const config = () => ({ libraryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', originalPathPrefix: '/imports', nasHost: NAS });
const target = async () => ({ model: 'synthetic-vision', host: A });
const idle = () => Object.fromEntries(['library', 'metadataExtraction', 'thumbnailGeneration', 'smartSearch', 'faceDetection',
  'facialRecognition', 'ocr', 'duplicateDetection', 'videoConversion', 'sidecar', 'workflow', 'backgroundTask', 'search'].map(n => [n, { queueStatus: { isActive: false },
  jobCounts: { active: 0, waiting: 0, delayed: 0, paused: 0 } }]));
const deps = { config, target, preDispatch: job => worker.preDispatch(job, { config, target }) };
const input = () => ({ operationId: uuid(), runId: uuid(), items: [uuid()] });
beforeEach(async () => {
  process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id: 'synthetic-nas', endpoints: [NAS] }, { id: 'synthetic-vision', endpoints: [A] }]);
  await Promise.all([Batches, Cards, Runs, Queue, Archive, Runtime].map(model => model.deleteMany({})));
  await Batches.ensureProcessingIndexes();
});
afterAll(() => { delete process.env.AGENTX_RUNTIME_RESOURCES_JSON; });

test('concurrent planning and lost replies preserve one selection and one queue identity', async () => {
  const request = input();
  const results = await Promise.all(Array.from({ length: 6 }, () => worker.enqueue(request, deps)));
  expect(new Set(results.map(r => r.queueId)).size).toBe(1);
  expect(await Batches.countDocuments()).toBe(1); expect((await queue.list()).count).toBe(1);
  await expect(worker.enqueue({ ...request, items: [uuid()] }, deps)).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  const job = await queue.get(results[0].queueId);
  expect(job.hosts).toEqual([NAS, A].sort());
  await expect(worker.preDispatch(job, { config, target: async () => ({ model: 'different', host: A }) }))
    .rejects.toMatchObject({ code: 'HEAVY_QUEUE_EXECUTOR_CHANGED' });
});

test('an existing reservation delays photo effects and releases only the unstarted claim', async () => {
  const request = await worker.enqueue(input(), deps);
  let blocker = await queue.submit({ key: 'synthetic-blocker', title: 'Synthetic reserved work', kind: 'other', hosts: [A], estimatedMinutes: 10,
    source: { type: 'coding' }, executor: { mode: 'operator', receiptRef: 'synthetic-receipt' } }, 'test');
  blocker = await queue.reserve(blocker.id, { expectedRevision: blocker.revision, start: new Date().toISOString() }, 'test');
  const run = jest.fn(); await worker.sweep({ ...deps, work: { run }, wait: true });
  expect(run).not.toHaveBeenCalled(); expect((await queue.get(request.queueId)).state).toBe('requested');
  expect(await Batches.countDocuments({ workerSlot: 'photo-processing' })).toBe(0);
});

test('multiple Core sweepers launch one processing batch and hold the next until native settlement', async () => {
  const first = await worker.enqueue(input(), deps), second = await worker.enqueue(input(), deps);
  let finish;
  const run = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  await Promise.all([worker.sweep({ ...deps, work: { run } }), worker.sweep({ ...deps, work: { run } })]);
  expect(run).toHaveBeenCalledTimes(1);
  expect((await queue.get(first.queueId)).state).toBe('running'); expect((await queue.get(second.queueId)).state).toBe('requested');
  await worker.sweep({ ...deps, work: { run } }); expect(run).toHaveBeenCalledTimes(1);
  finish(); await new Promise(resolve => setImmediate(resolve));
});

test('a lost begin reply leaves the crossed fence held without relaunching', async () => {
  const request = await worker.enqueue(input(), deps), run = jest.fn();
  const transport = { ...queue, begin: async (...args) => { await queue.begin(...args); throw Error('reply lost'); } };
  await worker.sweep({ ...deps, queue: transport, work: { run }, wait: true });
  await worker.sweep({ ...deps, work: { run }, wait: true });
  expect(run).not.toHaveBeenCalled(); expect((await queue.get(request.queueId)).state).toBe('dispatching');
  expect(await Batches.countDocuments({ workerSlot: 'photo-processing' })).toBe(1);
});

test('indexing, metadata, vision and portable export dedupe the same content across occurrences', async () => {
  const request = await worker.enqueue(input(), deps), row = await Batches.findById(request.operationId).lean();
  const sha256 = 'a'.repeat(64), analysis = { description: 'Synthetic landscape', tags: ['nature'], quality: 'bonne',
    frameSuitability: 'oui', reasons: ['Composition simple'], privacyReview: false };
  const projected = { sha256, size: 5, relativePath: row.runId+'/folder/image.jpg', immichChecksum: 'synthetic' };
  const bridge = { call: jest.fn(async command => command.op === 'project' ? { results: [projected, projected] } : { exported: true }) };
  const asset = { id: uuid(), libraryId: config().libraryId, hasMetadata: true, type: 'IMAGE', exifInfo: { dateTimeOriginal: '2020-01-02T03:04:05Z', description: 'Human text' }, tags: [{ value: 'Human tag' }] };
  const immich = { validateLibrary: jest.fn(), asset: jest.fn(async () => asset), scan: jest.fn(), pendingTag: jest.fn() };
  const inference = { execute: jest.fn(async () => ({ ok: true, body: { message: { content: JSON.stringify(analysis) } }, metadata: { model: 'synthetic-vision' } })) };
  const client = { json: jest.fn(async p => p === '/jobs' ? idle() : []), image: jest.fn(async () => ({ bytes: Buffer.from('synthetic-preview'), contentType: 'image/jpeg' })) };
  const work = createPhotoProcessingWork({ config, bridge, immich, inference, client });
  await worker.sweep({ ...deps, work, wait: true });
  expect((await Batches.findById(row._id)).state).toBe('completed'); expect(inference.execute).toHaveBeenCalledTimes(1);
  const stored = await Cards.findById(sha256).lean();
  expect(stored.analysis.card).toMatchObject({ reviewed: false, sourceSha256: sha256, proposal: analysis,
    metadata: { exif: { description: 'Human text' }, tags: ['Human tag'] } });
  expect(client.json.mock.calls.some(([p, options]) => p.startsWith('/assets/') && options?.method === 'PUT')).toBe(false);
  expect(bridge.call.mock.calls.filter(([x]) => x.op === 'exportCard')).toHaveLength(1);
  expect((await worker.observe(await queue.get(request.queueId), { client })).state).toBe('completed');
  expect(inference.execute.mock.calls[0][1]).toMatchObject({ hostUrl: A, sourcePolicy: 'local-only' });
});

test('a lost upstream scan reply is never converted into a second scan', async () => {
  const request = await worker.enqueue(input(), deps), row = await Batches.findById(request.operationId).lean();
  const item = { sha256: 'b'.repeat(64), size: 5, relativePath: row.runId+'/folder/video.mov' };
  const bridge = { call: jest.fn(async () => ({ results: [item] })) };
  const immich = { validateLibrary: jest.fn(), asset: jest.fn(async () => null), scan: jest.fn(async () => { throw Error('scan reply lost'); }) };
  const work = createPhotoProcessingWork({ config, bridge, immich, client: { json: async () => idle() }, pause: async () => {}, now: () => 0, assertWindow: async () => {} });
  await expect(work.run(row, { id: request.queueId, dispatchId: uuid() })).rejects.toThrow('scan reply lost');
  expect((await Batches.findById(row._id)).scanDispatchedAt).toBeTruthy();
  immich.asset.mockResolvedValue({ id: uuid(), type: 'VIDEO', exifInfo: {} });
  await work.run(row, { id: request.queueId, dispatchId: uuid() });
  expect(immich.scan).toHaveBeenCalledTimes(1);
});

test('whole-run discovery revisits receipts that arrive later and does not queue existing occurrences twice', async () => {
  const { enrollRun, discover } = require('../../src/services/photos/photoProcessingRuns');
  const runId = uuid(), operationId = uuid(), one = uuid(), two = uuid();
  await Promise.all([enrollRun({ runId, operationId }, deps), enrollRun({ runId, operationId }, deps)]);
  await expect(enrollRun({ runId: uuid(), operationId }, deps)).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  let received = false;
  const bridge = { call: jest.fn(async () => ({ total: 2, items: [
    { requestId: one, backup: { sha256: 'a'.repeat(64) } }, { requestId: two, backup: received ? { sha256: 'b'.repeat(64) } : null }
  ] })) };
  await discover({ ...deps, bridge });
  expect(await Batches.countDocuments()).toBe(1);
  await discover({ ...deps, bridge }); expect(await Batches.countDocuments()).toBe(1);
  received = true; await discover({ ...deps, bridge });
  expect(await Batches.countDocuments()).toBe(2);
  await discover({ ...deps, bridge }); expect(await Batches.countDocuments()).toBe(2);
});
