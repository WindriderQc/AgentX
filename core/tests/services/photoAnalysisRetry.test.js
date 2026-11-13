'use strict';
const crypto = require('node:crypto'), uuid = () => crypto.randomUUID();
const { retry, digest } = require('../../scripts/retry-photo-analysis.cjs');
const Cards = require('../../models/PhotoProcessingCard');
const Batches = require('../../models/PhotoProcessingBatch');
const Runtime = require('../../models/RuntimeCoordination');
let input, deps, original, job, config, target, projection;
const proposal = { description: 'Synthetic landscape', tags: ['landscape'], quality: 'bonne',
  frameSuitability: 'oui', reasons: ['Synthetic composition'], privacyReview: false };
beforeEach(async () => {
  await Promise.all([Cards, Batches, Runtime].map(m => m.deleteMany({})));
  await Runtime.create({ _id: 'runtime' });
  config = { libraryId: uuid(), originalPathPrefix: '/external/photos', nasHost: 'http://127.0.0.1:8091' };
  target = { model: 'fixture-vision', host: 'http://127.0.0.1:11434' };
  input = { operationId: uuid(), analysisId: uuid(), previousAnalysisId: uuid(), reconciliationId: uuid(),
    queueId: uuid(), dispatchId: uuid(), sha256: 'a'.repeat(64), receiptRef: 'synthetic-receipt',
    configHash: digest([config.libraryId, config.originalPathPrefix, config.nasHost]), targetHash: digest(target),
    confirmation: 'RETRY_VERIFIED_NOT_ATTEMPTED' };
  original = { state: 'failed', analysisId: input.previousAnalysisId,
    reconciliation: { operationId: input.reconciliationId, providerDispatched: false,
      code: 'RUNTIME_INFERENCE_ADMISSION_DENIED', authority: 'core.photo-processing.operator' },
    card: { analysisId: input.previousAnalysisId, sourceSha256: input.sha256, reviewed: false,
      vision: 'not-attempted', error: 'RUNTIME_INFERENCE_ADMISSION_DENIED' } };
  input.previousAnalysisSha256 = digest(original);
  projection = { sha256: input.sha256, runId: uuid(), requestId: uuid(), relativePath: 'synthetic/image.jpg', size: 9 };
  const assetId = uuid();
  await Cards.create({ _id: input.sha256, assetId, libraryId: config.libraryId, projection,
    metadata: { type: 'IMAGE' }, analysis: original,
    review: { revision: 3, approved: true, description: 'Human text', tags: ['human'] },
    frame: { revision: 2, selected: true } });
  job = { id: input.queueId, dispatchId: input.dispatchId, state: 'dispatching', kind: 'diagnostic',
    key: 'photo-analysis-retry:' + input.operationId,
    hosts: [config.nasHost, target.host], executor: { mode: 'operator', receiptRef: input.receiptRef },
    reservation: { start: new Date(Date.now() - 1000).toISOString(), end: new Date(Date.now() + 600000).toISOString() } };
  deps = { config: () => config, target: async () => target, queue: { get: jest.fn(async () => job) },
    indexingIdle: jest.fn(async () => true),
    client: { image: jest.fn(async () => ({ bytes: Buffer.from('synthetic'), contentType: 'image/jpeg' })),
      json: jest.fn(async () => []) },
    immich: { validateLibrary: jest.fn(async () => ({})), pendingTag: jest.fn(async () => ({})),
      asset: jest.fn(async () => ({ id: assetId, type: 'IMAGE', tags: [], exifInfo: { fileSizeInByte: 9 } })) },
    bridge: { call: jest.fn(async cmd => cmd.op === 'projection' ? projection
      : { sha256: cmd.sha256, analysisId: cmd.analysisId, exported: true }) },
    inference: { execute: jest.fn(async () => ({ ok: true, body: { message: { content: JSON.stringify(proposal) } } })) } };
});
test('one explicit attempt preserves refused history and human choices, exports a new card and releases its writer', async () => {
  const result = await retry(input, deps), card = await Cards.findById(input.sha256).lean();
  expect(result).toMatchObject({ state: 'completed', exported: true, previousAttemptPreserved: true });
  expect(card.analysis.retry.previousAnalysis).toEqual(original);
  expect(card.analysis.analysisId).toBe(input.analysisId);
  expect(card.analysis.card).toMatchObject({ proposal, retryOf: input.previousAnalysisId });
  expect(card.review).toEqual({ revision: 3, approved: true, description: 'Human text', tags: ['human'] });
  expect(card.frame).toEqual({ revision: 2, selected: true });
  expect(deps.immich.pendingTag).not.toHaveBeenCalled();
  expect(deps.inference.execute).toHaveBeenCalledTimes(1);
  expect((await Runtime.findById('runtime')).coreWriters).toHaveLength(0);
  expect(await Batches.findById(input.operationId).lean()).toMatchObject({ state: 'completed', progress: { completed: 1, failedAnalyses: 0 } });
  expect(await retry(input, deps)).toMatchObject({ idempotent: true, inferenceReplayed: false });
  expect(deps.inference.execute).toHaveBeenCalledTimes(1);
  await expect(retry({ ...input, analysisId: uuid() }, deps)).rejects.toMatchObject({ code: 'PHOTO_RETRY_REFUSED' });
});
test.each(['running', 'possibly-dispatched', 'completed-inference', 'wrong-authority', 'wrong-digest'])('refuses an ineligible prior attempt: %s', async kind => {
  const a = JSON.parse(JSON.stringify(original));
  if (kind === 'running') a.state = 'running';
  if (kind === 'possibly-dispatched') a.reconciliation.providerDispatched = true;
  if (kind === 'completed-inference') a.card.vision = 'failed';
  if (kind === 'wrong-authority') a.reconciliation.authority = 'untrusted';
  await Cards.updateOne({ _id: input.sha256 }, { $set: { analysis: a } });
  input.previousAnalysisSha256 = kind === 'wrong-digest' ? 'b'.repeat(64) : digest(a);
  await expect(retry(input, deps)).rejects.toMatchObject({ code: 'PHOTO_RETRY_REFUSED' });
  expect(deps.inference.execute).not.toHaveBeenCalled();
  expect(await Batches.countDocuments()).toBe(0);
});
test.each(['dispatch', 'receipt', 'mode', 'hosts', 'expired', 'short'])('refuses an unrelated or closed operator window: %s', async kind => {
  if (kind === 'dispatch') job.dispatchId = uuid();
  if (kind === 'receipt') job.executor.receiptRef = 'different';
  if (kind === 'mode') job.executor.mode = 'photo-processing';
  if (kind === 'hosts') job.hosts = ['http://127.0.0.2:11434'];
  if (kind === 'expired') job.reservation.end = new Date(Date.now() - 1).toISOString();
  if (kind === 'short') job.reservation.end = new Date(Date.now() + 30000).toISOString();
  await expect(retry(input, deps)).rejects.toMatchObject({ code: 'PHOTO_RETRY_REFUSED' });
  expect(deps.inference.execute).not.toHaveBeenCalled();
});
test('another active batch retains its writer and is never interrupted', async () => {
  await Runtime.updateOne({ _id: 'runtime' }, { $push: { coreWriters: {
    kind: 'photo-processing', operationId: uuid(), queueId: uuid(), processId: uuid(),
    hosts: [target.host], state: 'ACTIVE', acquiredAt: new Date() } } });
  await expect(retry(input, deps)).rejects.toMatchObject({ code: 'PHOTO_RETRY_REFUSED' });
  expect(deps.inference.execute).not.toHaveBeenCalled();
  expect((await Runtime.findById('runtime')).coreWriters).toHaveLength(1);
  expect((await Cards.findById(input.sha256)).analysis).toEqual(original);
});
test('concurrent callers admit at most one inference', async () => {
  const results = await Promise.allSettled([retry(input, deps), retry(input, deps)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(deps.inference.execute).toHaveBeenCalledTimes(1);
});
test('a lost claim acknowledgement retains an unknown writer and cannot dispatch on replay', async () => {
  const wrapped = { findById: (...args) => Cards.findById(...args), updateOne: (...args) => Cards.updateOne(...args),
    findOneAndUpdate: (...args) => ({ lean: async () => {
      await Cards.findOneAndUpdate(...args).lean(); throw new Error('Synthetic lost claim reply');
    } }) };
  await expect(retry(input, { ...deps, cards: wrapped })).rejects.toThrow('lost claim reply');
  expect(deps.inference.execute).not.toHaveBeenCalled();
  expect((await Runtime.findById('runtime')).coreWriters[0].state).toBe('UNKNOWN');
  expect((await Cards.findById(input.sha256)).analysis.state).toBe('running');
  await expect(retry(input, deps)).rejects.toMatchObject({ code: 'PHOTO_RETRY_REFUSED' });
});
test('unknown provider outcomes retain the original attempt and reject another inference', async () => {
  deps.inference.execute.mockRejectedValue(new Error('Synthetic network uncertainty'));
  await expect(retry(input, deps)).rejects.toThrow('network uncertainty');
  expect((await Runtime.findById('runtime')).coreWriters[0].state).toBe('UNKNOWN');
  expect((await Batches.findById(input.operationId)).state).toBe('uncertain');
  expect((await Cards.findById(input.sha256)).analysis.retry.previousAnalysis).toEqual(original);
  await expect(retry(input, deps)).rejects.toMatchObject({ code: 'PHOTO_RETRY_REFUSED' });
  expect(deps.inference.execute).toHaveBeenCalledTimes(1);
});
test('a malformed completed response is exported as a failed new attempt without losing history', async () => {
  deps.inference.execute.mockResolvedValue({ ok: true, body: { message: { content: '{' } } });
  expect(await retry(input, deps)).toMatchObject({ state: 'failed', exported: true });
  const card = await Cards.findById(input.sha256).lean();
  expect(card.analysis.card).toMatchObject({ vision: 'failed', error: 'PHOTO_ANALYSIS_INVALID' });
  expect(card.analysis.retry.previousAnalysis).toEqual(original);
  expect((await Runtime.findById('runtime')).coreWriters).toHaveLength(0);
});
test('a lost export response preserves completed inference and fences its effects', async () => {
  deps.bridge.call.mockImplementation(async cmd => {
    if (cmd.op === 'projection') return projection;
    throw new Error('Synthetic export reply lost');
  });
  await expect(retry(input, deps)).rejects.toThrow('export reply lost');
  const card = await Cards.findById(input.sha256).lean();
  expect(card.analysis.state).toBe('completed'); expect(card.analysis.retry.exported).toBe(false);
  expect((await Runtime.findById('runtime')).coreWriters[0].state).toBe('UNKNOWN');
  await expect(retry(input, deps)).rejects.toMatchObject({ code: 'PHOTO_RETRY_REFUSED' });
  expect(deps.inference.execute).toHaveBeenCalledTimes(1);
});
test('preflight refusal leaves the original attempt intact and releases its own writer', async () => {
  deps.immich.asset.mockResolvedValue(null);
  await expect(retry(input, deps)).rejects.toMatchObject({ code: 'PHOTO_RETRY_REFUSED' });
  expect((await Cards.findById(input.sha256)).analysis).toEqual(original);
  expect((await Runtime.findById('runtime')).coreWriters).toHaveLength(0);
  expect(deps.inference.execute).not.toHaveBeenCalled();
});
test('a concurrent human review and frame choice survive completion', async () => {
  deps.inference.execute.mockImplementation(async () => {
    await Cards.updateOne({ _id: input.sha256 }, { $set: { review: { revision: 4, approved: false }, frame: { revision: 3, selected: false } } });
    return { ok: true, body: { message: { content: JSON.stringify(proposal) } } };
  });
  await retry(input, deps);
  const card = await Cards.findById(input.sha256).lean();
  expect(card.review).toEqual({ revision: 4, approved: false });
  expect(card.frame).toEqual({ revision: 3, selected: false });
  expect(deps.immich.pendingTag).not.toHaveBeenCalled();
});
test('a completed card cannot acknowledge a lost writer release as complete', async () => {
  await retry(input, deps);
  const row = await Batches.findById(input.operationId).lean();
  await Runtime.updateOne({ _id: 'runtime' }, { $push: { coreWriters: { kind: 'photo-processing',
    operationId: row._id, queueId: row.queueId, processId: row.processId,
    hosts: [target.host], state: 'UNKNOWN', acquiredAt: new Date() } } });
  await expect(retry(input, deps)).rejects.toMatchObject({ code: 'PHOTO_RETRY_REFUSED' });
  expect(deps.inference.execute).toHaveBeenCalledTimes(1);
});
test('an operator admission for another intent cannot be reused', async () => {
  job.key = 'unrelated-campaign';
  await expect(retry(input, deps)).rejects.toMatchObject({ code: 'PHOTO_RETRY_REFUSED' });
  expect(deps.inference.execute).not.toHaveBeenCalled();
});
