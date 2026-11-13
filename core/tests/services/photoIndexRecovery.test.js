'use strict';
const crypto = require('node:crypto'), mongoose = require('mongoose');
const recovery = require('../../src/services/photos/photoIndexRecovery');
const Batches = require('../../models/PhotoProcessingBatch'), Cards = require('../../models/PhotoProcessingCard');
const Runs = require('../../models/PhotoProcessingRun'), Queue = require('../../models/HeavyWorkQueue');
const Archive = require('../../models/HeavyWorkQueueArchive'), Runtime = require('../../models/RuntimeCoordination');
const worker = require('../../src/services/photos/photoProcessingQueue'), writer = require('../../src/services/photos/photoProcessingWriter');
const queue = require('../../src/services/heavyWorkQueueService'), runtime = require('../../src/services/runtimeCoordinationService');
const drain = require('../../src/services/runtimeDrainIntent');
const { createPhotoProcessingWork } = require('../../src/services/photos/photoProcessingWork');
const uuid = () => crypto.randomUUID(), HOST = 'http://localhost:11434', NAS = 'http://localhost:3180';
const config = () => ({ libraryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', originalPathPrefix: '/imports', nasHost: NAS });
const target = async () => ({ model: 'synthetic-vision', host: HOST });
const idle = () => Object.fromEntries(['library', 'metadataExtraction', 'thumbnailGeneration', 'smartSearch', 'faceDetection',
  'facialRecognition', 'ocr', 'duplicateDetection', 'videoConversion', 'sidecar', 'workflow', 'backgroundTask', 'search']
  .map(k => [k, { queueStatus: { isActive: false }, jobCounts: { active: 0, waiting: 0, delayed: 0, paused: 0 } }]));
let input, deps, native, first, projections, immich, client, inference, bridge;
const failed = () => Batches.findById(first.operationId).lean();
const releases = async () => (await Runtime.findById('runtime').select('+releaseReceipts').lean()).releaseReceipts;

beforeEach(async () => {
  drain.clear();
  process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id: 'nas', endpoints: [NAS] }, { id: 'vision', endpoints: [HOST] }]);
  await Promise.all([Batches, Cards, Runs, Queue, Archive, Runtime].map(m => m.deleteMany({})));
  await Batches.ensureProcessingIndexes();
  native = { config, target, preDispatch: j => worker.preDispatch(j, { config, target }) };
  first = await worker.enqueue({ operationId: uuid(), runId: uuid(), items: [uuid(), uuid()] }, native);
  projections = ['a', 'b'].map(k => ({ sha256: k.repeat(64), size: 5, relativePath: 'synthetic/' + k + '.jpg' }));
  const asset = { id: uuid(), type: 'IMAGE' };
  immich = { validateLibrary: jest.fn(), asset: jest.fn(async p => p.sha256 === projections[0].sha256 ? asset : null),
    scan: jest.fn(), pendingTag: jest.fn() };
  client = { json: jest.fn(async () => idle()), image: jest.fn() };
  bridge = { call: jest.fn(async () => ({ results: projections })) };
  inference = { execute: jest.fn() };
  let clock = 0;
  const work = createPhotoProcessingWork({ config, immich, client, bridge, inference,
    now: () => (clock += 16 * 60 * 1000), assertWindow: async () => {}, pause: async () => {} });
  // Exercise the real caught timeout, not an invented terminal batch fixture.
  await worker.sweep({ ...native, work, wait: true });
  expect(await failed()).toMatchObject({ state: 'uncertain', error: 'PHOTO_INDEX_RECONCILIATION_REQUIRED', progress: { phase: 'index' } });
  expect(await writer.held(await failed(), 'UNKNOWN')).toBeTruthy();
  deps = { config, immich, client, pause: async () => {} };
  const plan = await recovery.inspect(first.operationId, deps), row = await failed();
  input = { op: 'close', operationId: uuid(), processingId: row._id, queueId: row.queueId, dispatchId: row.dispatchId,
    processId: row.processId, bindingHash: plan.bindingHash, actor: 'synthetic-photo-operator', receiptRef: 'synthetic-private-receipt',
    proof: { originalWorkerTerminated: true, sourceBoundaryVerified: true }, confirmation: 'CLOSE_FAILED_INDEX_WITHOUT_REPLAY' };
});
afterEach(() => {
  expect(immich.scan).toHaveBeenCalledTimes(1); // The original scan, never a recovery scan.
  expect(bridge.call).toHaveBeenCalledTimes(1);
  expect(inference.execute).not.toHaveBeenCalled();
  expect(client.image).not.toHaveBeenCalled();
  expect(immich.pendingTag).not.toHaveBeenCalled();
  drain.clear(); jest.restoreAllMocks(); delete process.env.AGENTX_RUNTIME_RESOURCES_JSON;
});

test('closes the exact original partial batch as failure, with native release proof and a read-only replay', async () => {
  const before = await failed();
  await Cards.create({ _id: projections[0].sha256, metadata: { description: 'Existing human text' },
    analysis: { state: 'completed', analysisId: uuid(), card: { preserved: true } },
    review: { revision: 7, approved: true }, frame: { revision: 5, selected: true }, pendingDecision: uuid() });
  const card = await Cards.findById(projections[0].sha256).lean();
  const result = await recovery.reconcile(input, deps);
  expect(result).toMatchObject({ state: 'failed', runtimeReleased: true, scanReplayed: false, modelsReplayed: false,
    effects: { selected: 2, verified: 1, unresolved: 1 }, idempotent: false });
  const after = await failed();
  for (const k of ['items', 'projections', 'progress', 'error', 'dispatchId', 'queueId', 'processId']) expect(after[k]).toEqual(before[k]);
  expect(after.indexRecovery.phase).toBe('released');
  expect(await writer.held(after)).toBeFalsy(); expect(await releases()).toHaveLength(1);
  expect((await queue.get(first.queueId)).releaseReceipt).toMatchObject({ authority: 'core.photo-processing.index-recovery',
    recoveryOperationId: input.operationId, state: 'failed', outcome: 'index-failed-before-analysis' });
  const repeated = await recovery.reconcile(input, deps);
  expect(repeated).toMatchObject({ idempotent: true, release: result.release });
  expect(await failed()).toEqual(after); expect(await releases()).toHaveLength(1);
  expect(await Cards.findById(card._id).lean()).toEqual(card);
  const lease = await runtime.acquireMaintenance({ principal: 'test-operator', requestId: uuid(), scope: 'core-recreate' });
  expect(lease.acquired).toBe(true);
});

test('inspection binds the native failure and observes effects without changing any owner document', async () => {
  const before = { batch: await failed(), runtime: await Runtime.findById('runtime').select('+releaseReceipts').lean(),
    queue: await queue.get(first.queueId), cards: await Cards.find({}).lean() };
  const plan = await recovery.inspect(first.operationId, deps);
  expect(plan).toMatchObject({ bindingHash: input.bindingHash, closesAs: 'failed', scanReplayed: false, modelsReplayed: false,
    effects: { selected: 2, verified: 1, unresolved: 1, stableReads: 2, indexingIdle: true } });
  expect({ batch: await failed(), runtime: await Runtime.findById('runtime').select('+releaseReceipts').lean(),
    queue: await queue.get(first.queueId), cards: await Cards.find({}).lean() }).toEqual(before);
});

test.each([
  { proof: { originalWorkerTerminated: false, sourceBoundaryVerified: true } },
  { proof: { originalWorkerTerminated: true, sourceBoundaryVerified: false } },
  { confirmation: 'FORCE' }, { bindingHash: '0'.repeat(64) }, { processId: uuid() }, { dispatchId: uuid() },
  { queueId: uuid() }, { force: true },
])('refuses incomplete or mismatched reviewed evidence without releasing anything: %j', async patch => {
  await expect(recovery.reconcile({ ...input, ...patch }, deps)).rejects.toMatchObject({ code: 'PHOTO_INDEX_RECOVERY_REFUSED' });
  expect((await failed()).state).toBe('uncertain'); expect(await writer.held(await failed())).toBeTruthy();
  expect(await releases()).toHaveLength(0); expect((await queue.get(first.queueId)).state).toBe('uncertain');
});

test.each(['running', 'completed', 'PHOTO_PROCESSING_UNKNOWN', 'RUNTIME_INFERENCE_ADMISSION_DENIED'])('another failure boundary refuses: %s', async state => {
  await Batches.updateOne({ _id: first.operationId }, { $set: state.includes('_') ? { error: state } : { state } });
  await expect(recovery.reconcile(input, deps)).rejects.toMatchObject({ code: 'PHOTO_INDEX_RECOVERY_REFUSED' });
  expect(await writer.held(await failed())).toBeTruthy();
});

test.each(['busy', 'changing', 'unavailable', 'library'])('unsettled or unavailable upstream evidence preserves the fence: %s', async mode => {
  if (mode === 'busy') client.json.mockImplementation(async () => { const j = idle(); j.library.jobCounts.waiting = 1; return j; });
  if (mode === 'changing') {
    let read = 0; immich.asset.mockImplementation(async p => p.sha256 === projections[0].sha256 ? { id: String(read++) } : null);
  }
  if (mode === 'unavailable') client.json.mockRejectedValue(Error('Upstream unavailable'));
  if (mode === 'library') immich.validateLibrary.mockRejectedValue(Error('Changed managed library'));
  await expect(recovery.reconcile(input, deps)).rejects.toThrow();
  expect((await failed()).state).toBe('uncertain'); expect(await writer.held(await failed())).toBeTruthy();
});

test.each(['own', 'foreign'])('an analysis claim must reconcile through its own owner: %s', async owner => {
  await Cards.create({ _id: projections[0].sha256, analysis: { state: owner === 'own' ? 'completed' : 'running',
    analysisId: uuid(), batchId: owner === 'own' ? first.operationId : uuid() } });
  await expect(recovery.reconcile(input, deps)).rejects.toMatchObject({ code: 'PHOTO_INDEX_RECOVERY_REFUSED' });
  expect(await writer.held(await failed())).toBeTruthy();
});

test('native authority arriving after the batch preparation prevents the atomic writer release', async () => {
  const update = Batches.findOneAndUpdate.bind(Batches);
  jest.spyOn(Batches, 'findOneAndUpdate').mockImplementation((...args) => {
    const q = update(...args), lean = q.lean.bind(q);
    q.lean = async () => {
      const row = await lean();
      if (args[1].$set?.indexRecovery) await Runtime.updateOne({ _id: 'runtime' }, { $push: { inferences: {
        admissionId: uuid(), generation: uuid(), principal: 'other-native-owner', requestId: uuid(), host: HOST,
        model: 'synthetic', kind: 'test', residencyKey: 'synthetic', residencySpec: {},
        acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60000), state: 'UNKNOWN' } } });
      return row;
    }; return q;
  });
  await expect(recovery.reconcile(input, deps)).rejects.toMatchObject({ code: 'PHOTO_INDEX_RECOVERY_REFUSED' });
  expect((await failed()).indexRecovery.phase).toBe('prepared'); expect(await writer.held(await failed())).toBeTruthy();
  expect(await releases()).toHaveLength(0); expect((await queue.get(first.queueId)).state).toBe('uncertain');
});

test('a lost preparation acknowledgement resumes the same failure intent; changed evidence refuses', async () => {
  const update = Batches.findOneAndUpdate.bind(Batches);
  const spy = jest.spyOn(Batches, 'findOneAndUpdate').mockImplementation((...args) => {
    const q = update(...args), lean = q.lean.bind(q);
    q.lean = async () => { const row = await lean(); if (args[1].$set?.indexRecovery) throw Error('prepare ACK lost'); return row; }; return q;
  });
  await expect(recovery.reconcile(input, deps)).rejects.toThrow('prepare ACK lost'); spy.mockRestore();
  expect((await failed()).indexRecovery.phase).toBe('prepared'); expect(await writer.held(await failed())).toBeTruthy();
  await expect(recovery.reconcile({ ...input, receiptRef: 'different' }, deps)).rejects.toMatchObject({ code: 'PHOTO_INDEX_RECOVERY_REFUSED' });
  expect(await recovery.reconcile(input, deps)).toMatchObject({ state: 'failed', runtimeReleased: true });
});

test('a lost writer-release acknowledgement is proved by the atomic native journal, never inferred from absence', async () => {
  const update = Runtime.findOneAndUpdate.bind(Runtime);
  const spy = jest.spyOn(Runtime, 'findOneAndUpdate').mockImplementation((...args) => {
    const q = update(...args), lean = q.lean.bind(q);
    q.lean = async () => { const row = await lean(); if (args[1].$pull?.coreWriters) throw Error('release ACK lost'); return row; }; return q;
  });
  await expect(recovery.reconcile(input, deps)).rejects.toThrow('release ACK lost'); spy.mockRestore();
  expect(await writer.held(await failed())).toBeFalsy(); expect(await releases()).toHaveLength(1);
  expect((await queue.get(first.queueId)).state).toBe('uncertain');
  expect(await recovery.reconcile(input, deps)).toMatchObject({ state: 'failed', runtimeReleased: true });
  expect(await releases()).toHaveLength(1);
});

test('a missing writer without the original native release proof cannot finish a prepared recovery', async () => {
  const settle = jest.spyOn(queue, 'settle').mockRejectedValue(Error('queue unavailable'));
  await expect(recovery.reconcile(input, deps)).rejects.toThrow('queue unavailable'); settle.mockRestore();
  await Runtime.updateOne({ _id: 'runtime' }, { $set: { releaseReceipts: [] } });
  await Batches.updateOne({ _id: first.operationId }, { $set: { 'indexRecovery.phase': 'prepared' }, $unset: { 'indexRecovery.release': 1 } });
  await expect(recovery.reconcile(input, deps)).rejects.toMatchObject({ code: 'PHOTO_INDEX_RECOVERY_REFUSED' });
  expect((await queue.get(first.queueId)).state).toBe('uncertain');
});

test('a lost queue settlement ACK returns the same historical failed receipt without a new write', async () => {
  const settle = queue.settle;
  const spy = jest.spyOn(queue, 'settle').mockImplementation(async (...args) => { await settle(...args); throw Error('queue ACK lost'); });
  await expect(recovery.reconcile(input, deps)).rejects.toThrow('queue ACK lost'); spy.mockRestore();
  const before = await failed();
  expect(await recovery.reconcile(input, deps)).toMatchObject({ state: 'failed', idempotent: true });
  expect(await failed()).toEqual(before); expect(await releases()).toHaveLength(1);
});

test('a terminal queue edited independently is not native photo termination/release evidence', async () => {
  await queue.settle(first.queueId, { operationId: first.operationId, state: 'failed', authority: 'unrelated-test' }, 'test');
  await expect(recovery.reconcile(input, deps)).rejects.toMatchObject({ code: 'PHOTO_INDEX_RECOVERY_REFUSED' });
  expect(await writer.held(await failed())).toBeTruthy();
});

test('the standalone owner works with a legacy batch schema without changing a loaded server module', async () => {
  const schema = Batches.schema.clone(); schema.remove('indexRecovery');
  const Legacy = mongoose.models.LegacyPhotoIndexBatch || mongoose.model('LegacyPhotoIndexBatch', schema, 'photo_processing_batches');
  expect(Legacy.schema.path('indexRecovery')).toBeUndefined();
  expect(await recovery.reconcile(input, { ...deps, batches: Legacy })).toMatchObject({ state: 'failed', runtimeReleased: true });
  expect((await failed()).indexRecovery.phase).toBe('released'); expect(await releases()).toHaveLength(1);
});

test('a holder admitted at the final CAS boundary cannot be cleared by the photo recovery', async () => {
  const update = Runtime.findOneAndUpdate.bind(Runtime);
  jest.spyOn(Runtime, 'findOneAndUpdate').mockImplementation((...args) => {
    const q = update(...args), lean = q.lean.bind(q);
    q.lean = async () => {
      if (args[1].$pull?.coreWriters) await Runtime.updateOne({ _id: 'runtime' }, { $push: { workloads: {
        admissionId: uuid(), generation: uuid(), principal: 'other-native-owner', requestId: uuid(), workloadId: uuid(),
        kind: 'test', hosts: [HOST], acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60000) } } });
      return lean();
    }; return q;
  });
  await expect(recovery.reconcile(input, deps)).rejects.toMatchObject({ code: 'PHOTO_INDEX_RECOVERY_REFUSED' });
  expect(await writer.held(await failed())).toBeTruthy(); expect(await releases()).toHaveLength(0);
  expect((await Runtime.findById('runtime').lean()).workloads).toHaveLength(1);
});

test('concurrent identical closures produce one native release and one original queue outcome', async () => {
  const results = await Promise.allSettled([recovery.reconcile(input, deps), recovery.reconcile(input, deps)]);
  expect(results.some(r => r.status === 'fulfilled')).toBe(true);
  expect(await releases()).toHaveLength(1); expect((await queue.get(first.queueId)).state).toBe('failed');
  expect(await recovery.reconcile(input, deps)).toMatchObject({ idempotent: true });
  await expect(recovery.reconcile({ ...input, operationId: uuid() }, deps)).rejects.toMatchObject({ code: 'PHOTO_INDEX_RECOVERY_REFUSED' });
});

test.each(['ACTIVE', 'foreign'])('a different writer admission is not this recoverable UNKNOWN holder: %s', async state => {
  await Runtime.updateOne({ _id: 'runtime' }, { $set: state === 'foreign'
    ? { 'coreWriters.0.processId': uuid() } : { 'coreWriters.0.state': state } });
  await expect(recovery.reconcile(input, deps)).rejects.toMatchObject({ code: 'PHOTO_INDEX_RECOVERY_REFUSED' });
  expect((await Runtime.findById('runtime').lean()).coreWriters).toHaveLength(1); expect(await releases()).toHaveLength(0);
});

test('indexing that becomes active after preparation keeps the fence and can later finish the same close plan', async () => {
  const update = Batches.findOneAndUpdate.bind(Batches);
  const spy = jest.spyOn(Batches, 'findOneAndUpdate').mockImplementation((...args) => {
    const q = update(...args), lean = q.lean.bind(q);
    q.lean = async () => {
      const row = await lean();
      if (args[1].$set?.indexRecovery) client.json.mockImplementation(async () => {
        const j = idle(); j.metadataExtraction.jobCounts.active = 1; return j;
      }); return row;
    }; return q;
  });
  await expect(recovery.reconcile(input, deps)).rejects.toMatchObject({ code: 'PHOTO_INDEX_RECOVERY_REFUSED' }); spy.mockRestore();
  expect((await failed()).indexRecovery.phase).toBe('prepared'); expect(await writer.held(await failed())).toBeTruthy();
  client.json.mockImplementation(async () => idle());
  expect(await recovery.reconcile(input, deps)).toMatchObject({ state: 'failed', runtimeReleased: true });
});

test('a changed frozen selection cannot reuse a prepared recovery', async () => {
  const settle = jest.spyOn(queue, 'settle').mockRejectedValue(Error('queue unavailable'));
  await expect(recovery.reconcile(input, deps)).rejects.toThrow('queue unavailable'); settle.mockRestore();
  await Batches.updateOne({ _id: first.operationId }, { $set: { items: [uuid()] } });
  await expect(recovery.reconcile(input, deps)).rejects.toMatchObject({ code: 'PHOTO_INDEX_RECOVERY_REFUSED' });
  expect((await queue.get(first.queueId)).state).toBe('uncertain');
});

test('native drain preserves FIFO after failed closure and discovery never reenrolls its original selection', async () => {
  const before = await failed();
  const second = await worker.enqueue({ operationId: uuid(), runId: uuid(), items: [uuid()] }, native);
  drain.request({ scope: 'core-recreate', ttlMs: 60000 });
  await recovery.reconcile(input, deps);
  await worker.sweep({ ...native, work: { run: jest.fn() }, wait: true });
  expect((await Batches.findById(second.operationId)).state).toBe('queued');
  expect(await Batches.countDocuments({ workerSlot: 'photo-processing' })).toBe(0);
  const runs = require('../../src/services/photos/photoProcessingRuns');
  await runs.enrollRun({ runId: before.runId, operationId: uuid() }, native);
  const readBridge = { call: jest.fn(async () => ({ total: before.items.length,
    items: before.items.map((requestId, i) => ({ requestId, backup: { sha256: projections[i].sha256 } })) })) };
  await runs.discover({ ...native, bridge: readBridge });
  expect(await Batches.countDocuments({ runId: before.runId })).toBe(1);
  const lease = await runtime.acquireMaintenance({ principal: 'test-operator', requestId: uuid(), scope: 'core-recreate' });
  expect(lease.acquired).toBe(true);
});
