#!/usr/bin/env node
'use strict';
// Explicit Core operator attempt, never an automatic retry or a server patch.
const { createRequire } = require('node:module');
const path = require('node:path'), crypto = require('node:crypto');
const app = createRequire(path.join(process.cwd(), 'package.json'));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/, WC = { w: 1, j: true };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refusal = message => Object.assign(new Error(message), { code: 'PHOTO_RETRY_REFUSED' });
function validate(input) {
  if (!input || !['operationId', 'analysisId', 'previousAnalysisId', 'reconciliationId', 'queueId', 'dispatchId']
    .every(k => UUID.test(input[k] || '')) || !['sha256', 'previousAnalysisSha256', 'configHash', 'targetHash']
    .every(k => SHA.test(input[k] || '')) || input.analysisId === input.previousAnalysisId
    || typeof input.receiptRef !== 'string' || !input.receiptRef.length || input.receiptRef.length > 500
    || input.confirmation !== 'RETRY_VERIFIED_NOT_ATTEMPTED') throw refusal('An explicit, identity-bound retry is required');
}
function previousMatches(card, input) {
  const a = card?.analysis, r = a?.reconciliation;
  return card?.metadata?.type === 'IMAGE' && !card.pendingDecision && a?.state === 'failed'
    && a.analysisId === input.previousAnalysisId && digest(a) === input.previousAnalysisSha256
    && a.card?.vision === 'not-attempted' && a.card.error === 'RUNTIME_INFERENCE_ADMISSION_DENIED'
    && r?.operationId === input.reconciliationId && r.providerDispatched === false
    && r.code === 'RUNTIME_INFERENCE_ADMISSION_DENIED' && r.authority === 'core.photo-processing.operator';
}
async function retry(input, deps = {}) {
  validate(input);
  const cards = deps.cards || app('./models/PhotoProcessingCard');
  const batches = deps.batches || app('./models/PhotoProcessingBatch');
  const queue = deps.queue || app('./src/services/heavyWorkQueueService');
  const writer = deps.writer || app('./src/services/photos/photoProcessingWriter');
  const config = (deps.config || app('./src/services/photos/photoProcessingConfig').loadProcessingConfig)();
  const inputHash = digest(input), now = deps.now || Date.now;
  let card = await cards.findById(input.sha256).lean();
  if (card?.analysis?.retry?.operationId === input.operationId) {
    if (card.analysis.retry.inputHash !== inputHash) throw refusal('Retry identity already has different arguments');
    if (!card.analysis.retry.exported || !['completed', 'failed'].includes(card.analysis.state))
      throw refusal('Observe the original attempt and its effects; do not dispatch it again');
    const original = await batches.findById(input.operationId).lean();
    if (original?.state !== 'completed' || original.inputHash !== inputHash || await writer.held(original))
      throw refusal('Observe the original batch and writer release before acknowledging completion');
    return { sha256: input.sha256, analysisId: card.analysis.analysisId, state: card.analysis.state,
      idempotent: true, inferenceReplayed: false };
  }
  if (!previousMatches(card, input) || Buffer.byteLength(JSON.stringify(card.analysis)) > 131072)
    throw refusal('Only the exact proven pre-dispatch refusal can be retried');
  if (!config || digest([config.libraryId, config.originalPathPrefix, config.nasHost]) !== input.configHash)
    throw refusal('The reviewed library configuration changed');
  if (card.libraryId !== config.libraryId) throw refusal('The original card belongs to another library');
  const target = await (deps.target || app('./src/services/photos/photoProcessingQueue').target)();
  if (digest(target) !== input.targetHash) throw refusal('The reviewed analysis route changed');
  async function window(remaining = 0) {
    const job = await queue.get(input.queueId), normal = app('./src/services/heavyWorkQueueContract').hosts;
    if (!job || job.dispatchId !== input.dispatchId || job.state !== 'dispatching' || job.kind !== 'diagnostic'
      || job.key !== 'photo-analysis-retry:' + input.operationId
      || job.executor?.mode !== 'operator' || job.executor.receiptRef !== input.receiptRef
      || normal(job.hosts).join() !== normal([config.nasHost, target.host]).join()
      || now() < Date.parse(job.reservation?.start) || now() + remaining >= Date.parse(job.reservation?.end)
      || !Number.isFinite(Date.parse(job.reservation?.end))) throw refusal('The exact admitted operator window is required');
    return job;
  }
  await window(240000);
  const row = { _id: input.operationId, runId: card.projection?.runId, items: [card.projection?.requestId],
    queueId: input.queueId, dispatchId: input.dispatchId, processId: crypto.randomUUID(), target,
    configHash: input.configHash, inputHash, state: 'claimed' };
  if (await batches.findById(row._id).lean()) throw refusal('Observe the original operation; no second worker is admitted');
  const client = deps.client || app('./src/services/photos/immichClient').createImmichClient();
  const bridge = deps.bridge || app('./src/services/photos/photoProcessingBridge').createPhotoProcessingBridge({ config: () => config });
  const immich = deps.immich || app('./src/services/photos/photoProcessingImmich')
    .createPhotoProcessingImmich({ client, bridge, config: () => config });
  const idle = deps.indexingIdle || (async () => app('./src/services/photos/photoProcessingWork').queuesIdle(await client.json('/jobs')));
  if (!await writer.acquire(row)) throw refusal('An existing batch or maintenance owns the writer; leave it untouched');
  let fenced = false, created = false;
  try {
    // No workerSlot: this operator owns its receipt, while the shared writer
    // prevents the automatic Core monitor from claiming another photo batch.
    await batches.create([row], { writeConcern: WC }); created = true;
    card = await cards.findById(input.sha256).lean();
    if (!previousMatches(card, input)) throw refusal('The original card changed before admission');
    await immich.validateLibrary();
    if (!await idle()) throw refusal('Existing indexing must finish before the retry');
    const projection = await bridge.call({ op: 'projection', sha256: input.sha256 });
    if (!projection || projection.sha256 !== input.sha256) throw refusal('The verified gallery reference is required');
    const asset = await immich.asset(projection);
    if (!asset || asset.id !== card.assetId || asset.type !== 'IMAGE') throw refusal('The original Immich asset must match');
    const preview = await client.image('/assets/' + asset.id + '/thumbnail?size=preview');
    if (!/^image\/(jpeg|png|webp)$/.test(preview.contentType) || !Buffer.isBuffer(preview.bytes)
      || preview.bytes.length > 8 * 1024 * 1024) throw refusal('A bounded decoded preview is required');
    const ocr = await client.json('/assets/' + asset.id + '/ocr');
    const metadata = app('./src/services/photos/photoProcessingImmich').metadata(asset, app('./src/services/photos/photoService').ocrText(ocr));
    await window(240000); await writer.assert(row);
    const marker = { operationId: input.operationId, inputHash, previousAnalysis: card.analysis,
      receiptRef: input.receiptRef, exported: false };
    const analysis = { state: 'running', analysisId: input.analysisId, batchId: row._id, queueId: row.queueId,
      startedAt: new Date(now()), retry: marker };
    // Treat a lost CAS answer as potentially claimed, before any model call.
    fenced = true;
    const claimed = await cards.findOneAndUpdate({ _id: input.sha256, analysis: card.analysis },
    { $set: { analysis, metadata } }, { new: true, writeConcern: WC }).lean();
    if (!claimed) { fenced = false; throw refusal('Another attempt already owns the content'); }
    await batches.updateOne({ _id: row._id, processId: row.processId }, { $set: { state: 'running',
      projections: [projection], progress: { phase: 'analysis', selected: 1, completed: 0 } } }, { writeConcern: WC });
    const engine = app('./src/services/photos/photoAnalysis');
    const inference = deps.inference || app('./src/extensions/trustedRuntimeServices').createTrustedRuntimeServices().inference;
    let result, state = 'completed';
    try { result = { ...await engine.analyze({ inference, ...preview, sha256: input.sha256,
      analysisId: input.analysisId, queueId: input.queueId, target }), metadata }; }
    catch (error) {
      if (!engine.completedAnalysisFailure(error)) throw error;
      state = 'failed';
      result = { schema: 'agentx.photo-metadata/v1', analysisId: input.analysisId, sourceSha256: input.sha256,
        metadata, reviewed: false, vision: 'failed', error: error.code };
    }
    result.retryOf = input.previousAnalysisId;
    const saved = await cards.findOneAndUpdate({ _id: input.sha256, 'analysis.analysisId': input.analysisId,
      'analysis.state': 'running', 'analysis.retry.operationId': input.operationId },
    { $set: { analysis: { state, analysisId: input.analysisId, card: result, retry: marker } } }, { new: true, writeConcern: WC }).lean();
    if (!saved) throw refusal('The original attempt needs reconciliation before export');
    await window(); await writer.assert(row);
    if (!saved.review?.revision && !saved.pendingDecision) await immich.pendingTag(asset.id, {
      sha256: input.sha256, baselineTags: metadata.tags, baselineIncomplete: metadata.tagsTruncated });
    const exported = await bridge.call({ op: 'exportCard', sha256: input.sha256, analysisId: input.analysisId, card: result });
    if (exported?.exported !== true || exported.sha256 !== input.sha256 || exported.analysisId !== input.analysisId)
      throw refusal('Observe the original portable export before acknowledging it');
    if (!await idle()) throw refusal('Observe outstanding metadata jobs before releasing the writer');
    await cards.updateOne({ _id: input.sha256, 'analysis.analysisId': input.analysisId,
      'analysis.retry.operationId': input.operationId }, { $set: { 'analysis.retry.exported': true } }, { writeConcern: WC });
    await batches.updateOne({ _id: row._id, processId: row.processId }, { $set: { state: 'completed',
      finishedAt: new Date(now()), progress: { phase: 'completed', selected: 1, completed: 1, failedAnalyses: state === 'failed' ? 1 : 0 } } }, { writeConcern: WC });
    await writer.release(row);
    return { sha256: input.sha256, analysisId: input.analysisId, previousAnalysisId: input.previousAnalysisId,
      state, exported: true, previousAttemptPreserved: true, ownerDecisionsCreated: 0, idempotent: false };
  } catch (error) {
    if (fenced) {
      // A possibly dispatched call or export never becomes an automatic retry.
      await writer.unknown(row);
      if (created) await batches.updateOne({ _id: row._id, processId: row.processId },
        { $set: { state: 'uncertain', error: error.code || 'PHOTO_RETRY_UNKNOWN' } }, { writeConcern: WC });
    } else {
      if (created) await batches.updateOne({ _id: row._id, processId: row.processId },
        { $set: { state: 'failed', error: error.code || 'PHOTO_RETRY_REFUSED' } }, { writeConcern: WC });
      await writer.release(row);
    }
    throw error;
  }
}
async function main() {
  const input = JSON.parse(Buffer.from(process.env.PHOTO_ANALYSIS_RETRY || '', 'base64').toString('utf8'));
  const mongoose = app('mongoose'); await mongoose.connect(process.env.MONGODB_URI);
  try { console.log(JSON.stringify(await retry(input))); } finally { await mongoose.disconnect(); }
}
if (require.main === module || process.env.PHOTO_ANALYSIS_RETRY_STDIN === '1')
  main().catch(error => { console.error(error.code || 'PHOTO_RETRY_UNKNOWN'); process.exitCode = 1; });
module.exports = { retry, digest };
