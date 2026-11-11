'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PNG } = require('pngjs');
const Image = require('../../models/ImageOperation');
const Conversation = require('../../models/Conversation');
const { forSurface, withSessionWrite, resumeDeletedSessionCleanup } = require('../../src/services/surfaceConversationService');
const storage = require('../../src/services/images/illustrationStorage');
const images = require('../../src/services/images/imageService');
const archive = require('../../src/services/imageArchive');
const conversations = forSurface('household');
const scope = { surface: 'household', sessionId: 'family:illustrated.session-1', packId: 'kidx_nestor', scopeId: 'family' };
const sessionScope = { sessionId: scope.sessionId, packId: scope.packId, scopeId: scope.scopeId };
const bytes = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const graph = { version: 1, builder: { id: 'fixture', version: 1 }, graphSha256: 'a'.repeat(64), graph: { text: { inputs: { text: 'A fictional lake' } } } };
let dir, epoch;
beforeEach(async () => {
  await Promise.all([Image.deleteMany({}), Conversation.deleteMany({})]);
  epoch = randomUUID(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'illustration-storage-'));
  process.env.IMAGE_ARCHIVE_DIR = dir;
  await conversations.createSession({ ...sessionScope, modeId: 'family', illustrationRetention: { epoch, expiresAt: new Date(Date.now()+600000).toISOString() } });
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.IMAGE_ARCHIVE_DIR; });
async function operation(extra = {}) {
  return (await Image.create({ _id: randomUUID(), actionKey: 'illustration:' + randomUUID(), requestHash: 'b'.repeat(64),
    state: 'completed', runtimeRestored: true, conversation: scope, profile: { id: 'fixture' }, request: { prompt: 'A fictional lake' },
    execution: graph, jobId: randomUUID(), queueRequestId: 'original-queue', admission: { id: 'original-admission' },
    illustration: { epoch, expiresAt: new Date(Date.now() + 600000).toISOString() }, ...extra })).toObject();
}
async function retained(extra) {
  const op = await operation(extra), artifact = await storage.retain(op._id, bytes);
  await Image.updateOne({ _id: op._id }, { $set: { artifact } });
  return Image.findById(op._id).lean();
}
test('temporary bytes are private, verified, bounded and absent from the durable archive and painting pool', async () => {
  const op = await retained();
  expect((await images.image(op._id)).bytes).toEqual(bytes);
  expect(await images.listFinished()).toEqual([]);
  expect(await images.listForConversation(scope)).toEqual([]);
  expect(await Image.findById(op._id).lean()).not.toHaveProperty('temporaryImage');
  expect(images.publicOperation(op)).not.toHaveProperty('temporaryImage');
  expect(fs.readdirSync(dir)).toEqual([]);
  await expect(storage.retain(op._id, Buffer.alloc(storage.MAX_BYTES + 1))).rejects.toMatchObject({ statusCode: 413 });
  expect(storage.validate(scope, { epoch, expiresAt: op.illustration.expiresAt }, { width: 1024, height: 1024 })).toBeTruthy();
});
test('the actual BSON document budget refuses a buffer before crossing 16 MiB', async () => {
  const op = await operation({ profile: { id: 'fixture', padding: 'x'.repeat(15 * 1024 * 1024) } });
  await expect(storage.retain(op._id, bytes)).rejects.toMatchObject({ statusCode: 413 });
  expect(await Image.findById(op._id).select('+temporaryImage').lean()).not.toHaveProperty('temporaryImage');
});
test('canonical deletion and cleanup retry remove only unkept contents while retaining native identities', async () => {
  const op = await retained();
  await conversations.deleteSession(sessionScope);
  await resumeDeletedSessionCleanup();
  await storage.retain(op._id, bytes); // A late renderer cannot resurrect a deleted session's bytes.
  const row = await Image.findById(op._id).select('+request +execution +temporaryImage +admission').lean();
  expect(row).not.toHaveProperty('temporaryImage');
  expect(row.request).not.toHaveProperty('prompt'); expect(row.execution).not.toHaveProperty('graph');
  expect(row).toMatchObject({ requestHash: op.requestHash, queueRequestId: 'original-queue', admission: { id: 'original-admission' } });
  await expect(images.image(op._id)).rejects.toMatchObject({ statusCode: 404 });
  await expect(storage.keep(op._id, scope, 'keep-original-request-1')).rejects.toThrow('ended');
  expect(fs.readdirSync(dir)).toEqual([]);
});
test('a different Family incarnation cannot retain an old renderer result', async () => {
  const op = await operation();
  await conversations.updateSession(sessionScope, { $set: { 'illustrationRetention.epoch': randomUUID() } });
  await storage.retain(op._id, bytes);
  expect(await Image.findById(op._id).select('+temporaryImage').lean()).not.toHaveProperty('temporaryImage');
});
test('native deletion cleanup resumes its durable tombstone after an interrupted content erase', async () => {
  const op = await retained();
  const erase = jest.spyOn(storage, 'expireConversation').mockRejectedValueOnce(new Error('Erase interrupted'));
  await expect(conversations.deleteSession(sessionScope)).rejects.toThrow('interrupted'); erase.mockRestore();
  const tombstone = await Conversation.findOne({ 'surfaceSession.sessionId': scope.sessionId }).lean();
  expect(tombstone.surfaceSession.deleteCleanupPending).toBe(true);
  await resumeDeletedSessionCleanup();
  expect(await Image.findById(op._id).select('+temporaryImage +execution +request').lean()).not.toHaveProperty('temporaryImage');
  expect(await conversations.getSession(sessionScope)).toBeNull();
});
test('keep is journaled before archive I/O and survives a concurrent canonical deletion', async () => {
  const op = await retained();
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { reached = resolve; });
  const rename = fsp.rename;
  jest.spyOn(fsp, 'rename').mockImplementationOnce(async (...args) => { reached(); await gate; return rename(...args); });
  const keeping = storage.keep(op._id, scope, 'keep-original-request-2');
  await entered;
  expect((await Image.findById(op._id).lean()).illustration.keep).toMatchObject({ state: 'accepted', requestId: 'keep-original-request-2' });
  let erased = false; const deleting = conversations.deleteSession(sessionScope).then(() => { erased = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(erased).toBe(false);
  release(); await keeping; await deleting;
  expect((await images.image(op._id)).bytes).toEqual(bytes);
  expect(await images.listFinished()).toEqual([expect.objectContaining({ id: op._id })]);
  expect(await storage.keep(op._id, scope, 'keep-original-request-2')).toMatchObject({ kept: true });
});
test('a failed archive copy preserves its original keep identity and resumes without another intent', async () => {
  const op = await retained();
  jest.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('Archive write unavailable'));
  await expect(storage.keep(op._id, scope, 'keep-original-request-3')).rejects.toThrow('unavailable');
  const accepted = (await Image.findById(op._id).lean()).illustration.keep;
  await storage.expireConversation(scope);
  await expect(storage.keep(op._id, scope, 'different-keep-request')).rejects.toThrow('own keep intent');
  expect(await storage.keep(op._id, scope, 'keep-original-request-3')).toMatchObject({ kept: true });
  const done = await Image.findById(op._id).lean();
  expect(done.illustration.keep.acceptedAt).toBe(accepted.acceptedAt);
  expect(done.artifact.archivedAt).toBe(accepted.acceptedAt);
  expect((await images.image(op._id)).bytes).toEqual(bytes);
});
test('a lost final keep acknowledgement replays the original receipt without another archive write', async () => {
  const op = await retained(), update = Image.findOneAndUpdate.bind(Image);
  const save = jest.spyOn(Image, 'findOneAndUpdate').mockImplementation((where, change, ...options) => {
    const result = update(where, change, ...options);
    if (change.$set?.['illustration.keep.state'] === 'completed') return { lean: async () => { await result.lean(); throw new Error('Keep ACK lost'); } };
    return result;
  });
  await expect(storage.keep(op._id, scope, 'keep-original-request-4')).rejects.toThrow('ACK lost'); save.mockRestore();
  const copy = jest.spyOn(fsp, 'rename');
  expect(await storage.keep(op._id, scope, 'keep-original-request-4')).toMatchObject({ kept: true });
  expect(copy).not.toHaveBeenCalled();
});
test('the content fence refuses a delayed execution graph and provider submission after expiry', async () => {
  const op = await operation({ state: 'reserving', execution: undefined });
  let release, entered;
  const barrier = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const held = withSessionWrite('household', scope.sessionId, async () => { entered(); await barrier; });
  await ready;
  const saving = storage.persistExecution(op, { execution: graph, state: 'generating', dispatchStarted: true });
  await storage.expireConversation(scope);
  release(); await held;
  expect(await saving).toBeNull();
  const submit = jest.fn();
  await expect(storage.submit(op, submit)).rejects.toMatchObject({ notSubmitted: true });
  expect(submit).not.toHaveBeenCalled();
  const row = await Image.findById(op._id).select('+execution +request').lean();
  expect(row).not.toHaveProperty('execution'); expect(row.request).not.toHaveProperty('prompt');
  expect(row.requestHash).toBe(op.requestHash);
});
test('erasure after graph persistence also refuses a later provider dispatch', async () => {
  const op = await operation({ state: 'reserving', execution: undefined });
  expect(await storage.persistExecution(op, { execution: graph, state: 'generating' })).toHaveProperty('execution.graph');
  await conversations.deleteSession(sessionScope);
  const submit = jest.fn(); await expect(storage.submit(op, submit)).rejects.toMatchObject({ notSubmitted: true });
  expect(submit).not.toHaveBeenCalled();
  expect(await Image.findById(op._id).select('+execution').lean()).not.toHaveProperty('execution.graph');
});
test('an admitted pending transport holds no conversation fence and cannot be invoked a second time', async () => {
  const op = await operation({ state: 'generating', dispatchStarted: true }); op.executionSha256 = graph.graphSha256;
  let entered, release; const pending = new Promise(resolve => { release = resolve; }), sent = new Promise(resolve => { entered = resolve; });
  const effect = jest.fn(async () => { entered(); await pending; return 'original late ACK'; });
  const sending = storage.submit(op, effect); await sent;
  const duplicate = jest.fn();
  await expect(storage.submit(op, duplicate)).rejects.toMatchObject({ runtimeUnknown: true });
  let timeout;
  try {
    await Promise.race([conversations.deleteSession(sessionScope), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Conversation write waited for the image transport')), 3000);
    })]);
    await expect(storage.submit(op, duplicate)).rejects.toMatchObject({ runtimeUnknown: true });
  } finally { clearTimeout(timeout); release(); await sending; }
  expect(effect).toHaveBeenCalledTimes(1); expect(duplicate).not.toHaveBeenCalled();
  const row = await Image.findById(op._id).select('+request +execution').lean();
  expect(row.request).not.toHaveProperty('prompt'); expect(row.execution).not.toHaveProperty('graph');
  expect(row.illustration.submission).toMatchObject({ requestId: op._id, executionSha256: graph.graphSha256 });
});
test('worker removal accepts only the original job and exact content receipt', async () => {
  const op = await retained(); op.output = { filename: 'native-output.png' };
  const discardOutput = jest.fn().mockResolvedValue({ contract: 'agentx.image-output-removal/v1', jobId: op.jobId, sha256: 'c'.repeat(64), removed: true });
  await storage.discardWorkerOutput(op, { discardOutput });
  expect((await Image.findById(op._id).lean()).illustration).toMatchObject({ workerRemovalPending: true });
  discardOutput.mockResolvedValue({ contract: 'agentx.image-output-removal/v1', jobId: op.jobId, sha256: op.artifact.sha256, removed: true });
  await storage.discardWorkerOutput(op, { discardOutput });
  const done = await Image.findById(op._id).lean();
  expect(done.illustration.workerRemoval).toMatchObject({ sha256: op.artifact.sha256, removed: true });
  expect(done.illustration).not.toHaveProperty('workerRemovalPending');
});


test('end keeps one exact receipt, creates a new scene epoch, and cannot erase the new incarnation', async () => {
  const first = await retained(), requestId = randomUUID();
  expect(await storage.end(scope, { epoch, requestId })).toEqual({ receipt: { epoch, requestId, state: 'completed' } });
  expect(await storage.endReceipt(scope, requestId)).toEqual({ epoch, requestId, state: 'completed' });
  expect(await storage.end(scope, { epoch, requestId: randomUUID() })).toEqual({ alreadyEnded: true, epoch, originalRequestId: requestId });
  const next = await storage.capture(scope);
  expect(next.epoch).not.toBe(epoch);
  const previousEpoch = epoch; epoch = next.epoch;
  const second = await retained();
  await storage.end(scope, { epoch: previousEpoch, requestId });
  expect((await storage.read(await Image.findById(second._id).lean())).bytes).toEqual(bytes);
  await expect(storage.read(first)).rejects.toMatchObject({ statusCode: 404 });
  expect((await conversations.getSession(sessionScope)).illustrationRetention.epoch).toBe(next.epoch);
});

test('an accepted end fences a new keep and late content even when content erasure failed', async () => {
  const op = await retained(), requestId = randomUUID();
  const update = jest.spyOn(Image, 'updateMany').mockRejectedValueOnce(new Error('Erase interrupted'));
  await expect(storage.end(scope, { epoch, requestId })).rejects.toThrow('interrupted'); update.mockRestore();
  expect(await storage.endReceipt(scope, requestId)).toMatchObject({ requestId, state: 'accepted' });
  await expect(storage.keep(op._id, scope, randomUUID())).rejects.toThrow('ended');
  expect(await storage.persistExecution(op, { execution: graph })).toBeNull();
  await storage.resumeKeeps();
  expect(await storage.endReceipt(scope, requestId)).toMatchObject({ state: 'completed' });
  expect(await Image.findById(op._id).select('+temporaryImage').lean()).not.toHaveProperty('temporaryImage');
  expect(fs.readdirSync(dir)).toEqual([]);
});

test('server housekeeping completes the original accepted keep after end and canonical deletion; GET performs no copy', async () => {
  const op = await retained(), requestId = randomUUID();
  jest.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('Archive unavailable'));
  await expect(storage.keep(op._id, scope, requestId)).rejects.toThrow('unavailable');
  const original = (await Image.findById(op._id).lean()).illustration.keep;
  const writes = jest.spyOn(fsp, 'rename');
  expect(await storage.keepReceipt(op._id, scope, requestId)).toEqual({ requestId, imageId: op._id, state: 'accepted' });
  expect(writes).toHaveBeenCalledTimes(1);
  await storage.end(scope, { epoch, requestId: randomUUID() });
  await conversations.deleteSession(sessionScope);
  await storage.resumeKeeps();
  expect(await storage.keepReceipt(op._id, scope, requestId)).toMatchObject({ state: 'completed' });
  const done = await Image.findById(op._id).select('+temporaryImage').lean();
  expect(done.illustration.keep).toMatchObject({ requestId, acceptedAt: original.acceptedAt, sha256: original.sha256 });
  expect(done.artifact.archivedAt).toBe(original.acceptedAt);
  expect(done).not.toHaveProperty('temporaryImage');
  expect(await images.listFinished()).toEqual([expect.objectContaining({ id: op._id, conversation: scope })]);
  expect((await images.image(op._id)).bytes).toEqual(bytes);
  await storage.resumeKeeps(); expect(writes).toHaveBeenCalledTimes(2);
});

test('real canonical human activity extends the current image without another scene or worker', async () => {
  const op = await retained();
  await Image.updateOne({ _id: op._id }, { $set: { 'illustration.expiresAt': new Date(Date.now() - 1000).toISOString() } });
  await conversations.recordTurn({ ...sessionScope, traceId: randomUUID(), inputText: 'Tell me more', replyText: 'Here is more.' });
  await withSessionWrite(scope.surface, scope.sessionId, async () => {}); // Observe the queued best-effort extension.
  const current = await Image.findById(op._id).lean();
  expect(Date.parse(current.illustration.expiresAt)).toBeGreaterThan(Date.now() + 590000);
  await storage.expireDue();
  expect((await images.image(op._id)).bytes).toEqual(bytes);
});

test('expiry reconciles canonical human activity after a crash before the retention extension', async () => {
  const op = await retained();
  await Image.updateOne({ _id: op._id }, { $set: { 'illustration.expiresAt': new Date(Date.now() - 1000).toISOString() } });
  await conversations.updateSession(sessionScope, { $set: { lastTurnAt: new Date() } });
  await storage.expireDue();
  expect((await images.image(op._id)).bytes).toEqual(bytes);
});

test('TTL erases temporary content and scene text but retains native receipts; expired epochs never revive', async () => {
  const op = await retained(), expired = new Date(Date.now() - 1000).toISOString();
  await Image.updateOne({ _id: op._id }, { $set: { 'illustration.expiresAt': expired } });
  await conversations.updateSession(sessionScope, { $set: { 'illustrationRetention.expiresAt': expired } });
  await storage.expireDue();
  const row = await Image.findById(op._id).select('+request +execution +temporaryImage +admission').lean();
  expect(row).not.toHaveProperty('temporaryImage'); expect(row.request).not.toHaveProperty('prompt'); expect(row.execution).not.toHaveProperty('graph');
  expect(row).toMatchObject({ requestHash: op.requestHash, queueRequestId: op.queueRequestId, admission: { id: 'original-admission' } });
  await storage.touch(scope, new Date().toISOString());
  await storage.retain(op._id, bytes);
  expect(await Image.findById(op._id).select('+temporaryImage').lean()).not.toHaveProperty('temporaryImage');
});

test('pool exclusion happens before its limit, so a temporary result cannot hide a kept Family drawing', async () => {
  const kept = await retained(); await storage.keep(kept._id, scope, randomUUID());
  await retained();
  expect(await images.listFinished({ limit: 1 })).toEqual([expect.objectContaining({ id: kept._id })]);
  const { paintingPool } = require('../../surfaces/household/family-paintings');
  expect(paintingPool(await images.listFinished())).toEqual([{ id: kept._id, source: 'family' }]);
});


test('human activity after the deadline cannot revive an expired epoch before housekeeping runs', async () => {
  const op = await retained(), expired = new Date(Date.now() - 1000).toISOString();
  await Image.updateOne({ _id: op._id }, { $set: { 'illustration.expiresAt': expired } });
  await conversations.updateSession(sessionScope, { $set: { 'illustrationRetention.expiresAt': expired, lastTurnAt: new Date() } });
  await storage.touch(scope, new Date().toISOString());
  await expect(images.image(op._id)).rejects.toMatchObject({ statusCode: 404 });
  const next = await storage.capture(scope);
  expect(next.epoch).not.toBe(epoch);
  expect(await Image.findById(op._id).select('+temporaryImage').lean()).not.toHaveProperty('temporaryImage');
});


test('HTTP retention identity arrays are refused before journaling or erasing', async () => {
  const express = require('express'), request = require('supertest');
  const app = express(); app.use(express.json());
  require('../../surfaces/household/illustration-retention-routes').register(app, { service: images, view: value => value });
  const op = await retained(), requestId = randomUUID();
  const base = `/family/sessions/${scope.sessionId}/images`;
  await request(app).post(base + '/retention/end').send({ epoch, requestId: [requestId] }).expect(400);
  await request(app).post(base + '/retention/end').send({ epoch: [epoch], requestId }).expect(400);
  await request(app).get(base + '/retention/end').query({ requestId: [requestId, requestId] }).expect(400);
  await request(app).post(base + `/${op._id}/keep`).send({ requestId: [requestId] }).expect(400);
  expect(await storage.endReceipt(scope, requestId)).toBeNull();
  expect((await images.image(op._id)).bytes).toEqual(bytes);
});


test('temporary retention preserves the existing qualified 4 MP scene size within its byte bound', async () => {
  const op = await operation();
  expect(storage.validate(scope, op.illustration, { width: 2048, height: 2048 })).toBeTruthy();
  const large = PNG.sync.write({ width: 2048, height: 2048, data: Buffer.alloc(2048 * 2048 * 4, 255) });
  const artifact = await storage.retain(op._id, large);
  expect(artifact).toMatchObject({ width: 2048, height: 2048 });
  await Image.updateOne({ _id: op._id }, { $set: { artifact } });
  expect((await images.image(op._id)).bytes).toEqual(large);
  expect(fs.readdirSync(dir)).toEqual([]);
});


test.each([false, true])('canonical Family intake completes under its existing fence with retention=%s', async hasImage => {
  let op;
  if (hasImage) {
    op = await retained();
    const nearDeadline = new Date(Date.now() + 5000).toISOString();
    await conversations.updateSession(sessionScope, { $set: { 'illustrationRetention.expiresAt': nearDeadline } });
    await Image.updateOne({ _id: op._id }, { $set: { 'illustration.expiresAt': nearDeadline } });
  } else await conversations.updateSession(sessionScope, { $unset: { illustrationRetention: 1 } });
  let timeout;
  try {
    const result = await Promise.race([
      conversations.acceptTurn({ ...sessionScope, traceId: randomUUID(), inputText: 'Continue the conversation.' }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Family intake deadlocked on the retention follow-up')), 2000); })
    ]);
    expect(result).toMatchObject({ duplicate: false, turn: { inputText: 'Continue the conversation.', outcome: 'pending' } });
  } finally { clearTimeout(timeout); }
  // The server's same queue, rather than a second touch or a compensating turn,
  // proves that the admitted follow-up ran after releasing the intake fence.
  await withSessionWrite(scope.surface, scope.sessionId, async () => {});
  if (hasImage) {
    expect(Date.parse((await Image.findById(op._id).lean()).illustration.expiresAt)).toBeGreaterThan(Date.now() + 590000);
    expect((await images.image(op._id)).bytes).toEqual(bytes);
  } else expect((await conversations.getSession(sessionScope)).illustrationRetention).toBeUndefined();
});
