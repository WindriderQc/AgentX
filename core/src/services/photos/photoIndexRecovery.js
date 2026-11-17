'use strict';
// The native photo owner closes a known, caught index timeout as failure. It
// never resumes project/scan/analysis/export, and never treats an idle queue as
// proof that the original selected media were successfully processed.
const path = require('node:path'), crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = process.env.PHOTO_INDEX_RECOVERY_STDIN === '1' ? process.cwd() : path.resolve(__dirname, '../../..');
const app = createRequire(path.join(root, 'package.json'));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const FAILURE = 'PHOTO_INDEX_RECONCILIATION_REQUIRED', AUTHORITY = 'core.photo-processing.index-recovery';
const WC = { w: 1, j: true };
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = v => crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const refuse = message => Object.assign(new Error(message), { code: 'PHOTO_INDEX_RECOVERY_REFUSED', status: 409 });
const proof = row => ({ kind: 'photo-processing', operationId: row._id, queueId: row.queueId, processId: row.processId });
const sameWriter = (w, row) => Object.entries(proof(row)).every(([k, v]) => w[k] === v);
const date = v => v instanceof Date ? v.toISOString() : v;

function dependencies(deps) {
  return {
    batches: deps.batches || app('./models/PhotoProcessingBatch'),
    cards: deps.cards || app('./models/PhotoProcessingCard'),
    runtime: deps.runtime || app('./models/RuntimeCoordination'),
    queue: deps.queue || app('./src/services/heavyWorkQueueService'),
    config: deps.config || app('./src/services/photos/photoProcessingConfig').loadProcessingConfig,
    client: deps.client || app('./src/services/photos/immichClient').createImmichClient(),
    pause: deps.pause || (ms => new Promise(resolve => setTimeout(resolve, ms))),
    immich: deps.immich,
  };
}
function selection(row) {
  if (!Array.isArray(row.projections) || !row.projections.length || row.projections.length > 24)
    throw refuse('The acknowledged original projection receipt is required');
  const selected = [...new Map(row.projections.filter(p => !p.skipped).map(p => [p.sha256, p])).values()];
  if (!selected.length || selected.some(p => !SHA.test(p.sha256 || '') || !Number.isSafeInteger(p.size)
    || p.size < 1 || typeof p.relativePath !== 'string' || !p.relativePath))
    throw refuse('Original projection identities are incomplete');
  return selected;
}
function binding(row) {
  return { processingId: row._id, queueId: row.queueId, dispatchId: row.dispatchId, processId: row.processId,
    updatedAt: date(row.updatedAt), scanDispatchedAt: date(row.scanDispatchedAt), configHash: row.configHash,
    projectionDigest: digest(row.projections),
    selectionDigest: digest({ runId: row.runId, items: row.items, inputHash: row.inputHash, target: row.target }),
    progress: row.progress, error: row.error };
}
async function jobFor(row, d, recovered = false) {
  const job = await d.queue.get(row.queueId);
  if (job.id !== row.queueId || job.dispatchId !== row.dispatchId || job.operation?.id !== row._id
    || job.executor?.mode !== 'photo-processing' || job.executor.processingId !== row._id
    || !(job.state === 'uncertain' || recovered && job.state === 'failed'))
    throw refuse('The exact original uncertain photo dispatch is required');
  if (job.state === 'failed' && (job.releaseReceipt?.recoveryOperationId !== row.indexRecovery?.operationId
    || job.releaseReceipt?.inputHash !== row.indexRecovery?.inputHash || job.releaseReceipt?.authority !== AUTHORITY))
    throw refuse('A terminal queue without this native release receipt is not proof');
  return job;
}
async function noAnalyses(row, selected, d) {
  // Reused terminal cards and human choices are allowed and remain untouched.
  // Any attempt by this batch, or any still-running selected analysis, refuses.
  if (await d.cards.exists({ $or: [{ 'analysis.batchId': row._id },
    { _id: { $in: selected.map(p => p.sha256) }, 'analysis.state': 'running' }] }))
    throw refuse('An analysis attempt needs its own native reconciliation');
}
async function runtimeFor(row, d) {
  const runtime = await d.runtime.findById('runtime').select('+releaseReceipts').lean();
  if (!runtime || !Array.isArray(runtime.coreWriters) || !Array.isArray(runtime.workloads)
    || !Array.isArray(runtime.inferences)) throw refuse('Complete native runtime evidence is required');
  return runtime;
}
function quiescent(runtime, row) {
  if (runtime.maintenance !== null || runtime.workloads.length || runtime.inferences.length
    || runtime.coreWriters.length !== 1 || !sameWriter(runtime.coreWriters[0], row)
    || runtime.coreWriters[0].state !== 'UNKNOWN')
    throw refuse('The exact UNKNOWN photo writer must be the only remaining native holder');
}
async function effects(row, selected, d) {
  const config = d.config();
  if (!config || digest([config.libraryId, config.originalPathPrefix, config.nasHost]) !== row.configHash)
    // configHash historically uses JSON.stringify, not canonical object keys.
    throw refuse('The original managed library configuration changed');
  const immich = d.immich || app('./src/services/photos/photoProcessingImmich')
    .createPhotoProcessingImmich({ client: d.client, config: () => config });
  const { queuesIdle } = app('./src/services/photos/photoProcessingWork');
  async function read() {
    await immich.validateLibrary();
    const assets = [];
    for (const p of selected) {
      const value = await immich.asset(p);
      assets.push({ sha256: p.sha256, state: value ? 'verified' : 'unresolved', ...(value ? { assetId: value.id } : {}) });
    }
    if (!queuesIdle(await d.client.json('/jobs'))) throw refuse('Indexing effects have not settled');
    return { selected: selected.length, verified: assets.filter(a => a.state === 'verified').length,
      unresolved: assets.filter(a => a.state === 'unresolved').length, assets };
  }
  const first = await read();
  await d.pause(1000);
  const second = await read();
  if (digest(first) !== digest(second)) throw refuse('Original index effects are still changing');
  return { ...second, observedAt: new Date().toISOString(), stableReads: 2, indexingIdle: true };
}
async function capture(processingId, d) {
  if (!UUID.test(processingId || '')) throw refuse('Expected an original processing UUID');
  const row = await d.batches.findById(processingId).lean();
  if (!row || row.state !== 'uncertain' || row.error !== FAILURE || row.progress?.phase !== 'index'
    || row.workerSlot !== 'photo-processing' || row.indexRecovery
    || ![row._id, row.queueId, row.dispatchId, row.processId].every(v => UUID.test(v || ''))
    || !Number.isFinite(Date.parse(row.scanDispatchedAt)))
    throw refuse('Only a caught original index timeout before analysis is supported');
  const selected = selection(row), job = await jobFor(row, d);
  if (row.progress.selected !== selected.length || !Number.isSafeInteger(row.progress.linked)
    || row.progress.linked < 0 || row.progress.linked > selected.length)
    throw refuse('The original index progress does not match its projection receipt');
  quiescent(await runtimeFor(row, d), row);
  await noAnalyses(row, selected, d);
  const observed = await effects(row, selected, d);
  await noAnalyses(row, selected, d);
  const current = await d.batches.findById(processingId).lean();
  if (!current || digest(binding(current)) !== digest(binding(row)) || current.state !== 'uncertain' || current.indexRecovery)
    throw refuse('The original failure record changed during observation');
  quiescent(await runtimeFor(row, d), row);
  return { row, job, observed, binding: binding(row), bindingHash: digest(binding(row)) };
}
async function inspect(processingId, deps = {}) {
  const c = await capture(processingId, dependencies(deps));
  return { contract: 'agentx.photo-index-recovery-plan/v1', binding: c.binding, bindingHash: c.bindingHash,
    effects: c.observed, closesAs: 'failed', scanReplayed: false, modelsReplayed: false };
}
function validate(input) {
  const keys = ['op', 'operationId', 'processingId', 'queueId', 'dispatchId', 'processId', 'bindingHash',
    'actor', 'receiptRef', 'proof', 'confirmation'];
  if (!input || Object.keys(input).some(k => !keys.includes(k))
    || ![input.operationId, input.processingId, input.queueId, input.dispatchId, input.processId].every(v => UUID.test(v || ''))
    || !SHA.test(input.bindingHash || '') || !/^[A-Za-z0-9_.:-]{1,120}$/.test(input.actor || '')
    || typeof input.receiptRef !== 'string' || !input.receiptRef.trim() || input.receiptRef.length > 500
    || input.proof?.originalWorkerTerminated !== true || input.proof.sourceBoundaryVerified !== true
    || Object.keys(input.proof).some(k => !['originalWorkerTerminated', 'sourceBoundaryVerified'].includes(k))
    || input.confirmation !== 'CLOSE_FAILED_INDEX_WITHOUT_REPLAY' || input.op !== 'close')
    throw refuse('An exact reviewed failure plan and native worker-termination evidence are required');
}
function stored(row, input, inputHash) {
  const r = row?.indexRecovery;
  if (!r || !r.binding || r.operationId !== input.operationId || r.inputHash !== inputHash
    || r.bindingHash !== input.bindingHash || row._id !== input.processingId || row.queueId !== input.queueId
    || row.dispatchId !== input.dispatchId || row.processId !== input.processId || row.state !== 'failed'
    || row.error !== FAILURE || row.progress?.phase !== 'index'
    || digest({ ...binding(row), updatedAt: r.binding.updatedAt }) !== r.bindingHash)
    throw refuse('The original failure/recovery identity has different evidence');
  return r;
}
function releaseKey(row, r) {
  return { kind: 'photo-index-recovery', authority: AUTHORITY, operationId: r.operationId,
    processingId: row._id, queueId: row.queueId, dispatchId: row.dispatchId, processId: row.processId, inputHash: r.inputHash };
}
const matches = (a, b) => a && Object.entries(b).every(([k, v]) => a[k] === v);
async function release(row, r, d) {
  const key = releaseKey(row, r), runtime = await runtimeFor(row, d);
  const previous = runtime.releaseReceipts?.find(x => matches(x, key));
  if (previous || r.phase === 'released') {
    if (runtime.coreWriters.some(w => sameWriter(w, row))) throw refuse('A supposedly released original writer is still held');
    if (previous) return previous;
    if (matches(r.release, key)) return r.release; // Historical receipt survives the bounded runtime journal.
    throw refuse('Native writer release proof is missing');
  }
  quiescent(runtime, row);
  await noAnalyses(row, selection(row), d);
  const observed = await effects(row, selection(row), d);
  await noAnalyses(row, selection(row), d);
  // The batch's terminal failure and complete intent are durable *before* this
  // CAS. Its original slot stays held until queue settlement. Runtime removal
  // and its bounded release proof commit atomically in the existing journal.
  const receipt = { ...key, releasedAt: new Date().toISOString(), receiptRef: r.receiptRef,
    effectDigest: digest(observed.assets), indexObservedAt: observed.observedAt,
    effects: { selected: observed.selected, verified: observed.verified, unresolved: observed.unresolved } };
  const result = await d.runtime.findOneAndUpdate({ _id: 'runtime', maintenance: null,
    'workloads.0': { $exists: false }, 'inferences.0': { $exists: false }, 'coreWriters.1': { $exists: false },
    coreWriters: { $elemMatch: { ...proof(row), state: 'UNKNOWN' } } },
  { $pull: { coreWriters: proof(row) }, $push: { releaseReceipts: { $each: [receipt], $slice: -100 } } },
  { new: true, writeConcern: WC }).select('+releaseReceipts').lean();
  if (result) return receipt;
  // A concurrent identical recovery may have won; absence alone is not proof.
  const after = await runtimeFor(row, d), saved = after.releaseReceipts?.find(x => matches(x, key));
  if (!saved || after.coreWriters.some(w => sameWriter(w, row))) throw refuse('Native writer admission changed; retain the prepared recovery');
  return saved;
}
function observation(row, r) {
  return { operationId: row._id, dispatchId: row.dispatchId, terminal: true, state: 'failed',
    authority: AUTHORITY, recoveryOperationId: r.operationId, inputHash: r.inputHash, receiptRef: r.receiptRef,
    runtimeReleased: true, outcome: 'index-failed-before-analysis', effects: r.release.effects };
}
const result = (row, r, idempotent) => ({ ...observation(row, r), processingId: row._id, queueId: row.queueId,
  release: r.release, idempotent, scanReplayed: false, modelsReplayed: false });
async function reconcile(input, deps = {}) {
  validate(input);
  const d = dependencies(deps), inputHash = digest(input);
  let row = await d.batches.findById(input.processingId).lean();
  if (!row?.indexRecovery) {
    const c = await capture(input.processingId, d);
    if (c.bindingHash !== input.bindingHash || ['queueId', 'dispatchId', 'processId'].some(k => c.row[k] !== input[k]))
      throw refuse('The reviewed failure plan no longer matches');
    const recovery = { contract: 'agentx.photo-index-recovery/v1', operationId: input.operationId, inputHash,
      bindingHash: c.bindingHash, binding: c.binding, receiptRef: input.receiptRef, actor: input.actor,
      proof: input.proof, effects: c.observed, phase: 'prepared', preparedAt: new Date().toISOString() };
    // strict:false admits this one fixed new receipt field on a legacy Core's
    // side-process model. No loaded server module or arbitrary field is changed.
    row = await d.batches.findOneAndUpdate({ _id: c.row._id, state: 'uncertain', error: FAILURE,
      queueId: input.queueId, dispatchId: input.dispatchId, processId: input.processId,
      updatedAt: c.row.updatedAt, indexRecovery: { $exists: false } },
    { $set: { state: 'failed', finishedAt: new Date(), indexRecovery: recovery } },
    { new: true, strict: false, writeConcern: WC }).lean();
    if (!row) row = await d.batches.findById(input.processingId).lean();
  }
  let r = stored(row, input, inputHash);
  const currentJob = await jobFor(row, d, true);
  if (r.phase === 'released' && currentJob.state === 'failed' && matches(r.release, releaseKey(row, r)))
    return result(row, r, true);
  const receipt = await release(row, r, d);
  await d.batches.updateOne({ _id: row._id, 'indexRecovery.operationId': input.operationId,
    'indexRecovery.inputHash': inputHash }, { $set: { 'indexRecovery.phase': 'released', 'indexRecovery.release': receipt } },
  { strict: false, writeConcern: WC });
  row = await d.batches.findById(row._id).lean(); r = stored(row, input, inputHash);
  if (r.phase !== 'released' || !matches(r.release, releaseKey(row, r))) throw refuse('The native release receipt was not retained');
  const job = await d.queue.settle(row.queueId, observation(row, r), input.actor);
  if (job.state !== 'failed' || job.dispatchId !== row.dispatchId
    || job.releaseReceipt?.recoveryOperationId !== input.operationId || job.releaseReceipt?.inputHash !== inputHash)
    throw refuse('Observe the original queue settlement; no replacement or release is authorized');
  return result(row, r, false);
}
async function main() {
  const encoded = process.env.PHOTO_INDEX_RECOVERY || '';
  if (!/^[A-Za-z0-9+/]{1,24000}={0,2}$/.test(encoded)) throw refuse('Supply one bounded base64 recovery plan');
  const input = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const mongoose = app('mongoose');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
  try {
    if (input.op === 'inspect' && Object.keys(input).every(k => ['op', 'processingId'].includes(k)))
      console.log(JSON.stringify(await inspect(input.processingId)));
    else console.log(JSON.stringify(await reconcile(input)));
  } finally { await mongoose.disconnect(); }
}
if (process.env.PHOTO_INDEX_RECOVERY_STDIN === '1') main().catch(e => { console.error(e.code, e.message); process.exitCode = 1; });
module.exports = { inspect, reconcile, main };
