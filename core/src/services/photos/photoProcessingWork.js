'use strict';
const crypto = require('node:crypto');
const Cards = require('../../../models/PhotoProcessingCard');
const Batches = require('../../../models/PhotoProcessingBatch');
const { createPhotoProcessingBridge } = require('./photoProcessingBridge');
const { createImmichClient } = require('./immichClient');
const { createPhotoProcessingImmich, metadata } = require('./photoProcessingImmich');
const { loadProcessingConfig } = require('./photoProcessingConfig');
const { analyze, completedAnalysisFailure } = require('./photoAnalysis');
const { fail } = require('./importFiles');
const { hash } = require('./phoneLibrary');
const WC = { w: 1, j: true };
const INDEX_QUEUES = ['library', 'metadataExtraction', 'thumbnailGeneration', 'smartSearch', 'faceDetection', 'facialRecognition', 'ocr', 'duplicateDetection', 'videoConversion', 'sidecar', 'workflow', 'backgroundTask', 'search'];
function queuesIdle(value) {
  return INDEX_QUEUES.every(name => {
    const queue = value?.[name], counts = queue?.jobCounts;
    return queue?.queueStatus?.isActive === false && counts
      && ['active', 'waiting', 'delayed', 'paused'].every(k => Number.isSafeInteger(counts[k]) && counts[k] === 0);
  });
}
function createPhotoProcessingWork(deps = {}) {
  const configured = deps.config || loadProcessingConfig;
  let pinnedConfig;
  const config = () => pinnedConfig || configured();
  const bridge = deps.bridge || createPhotoProcessingBridge({ config });
  const client = deps.client || createImmichClient();
  const immich = deps.immich || createPhotoProcessingImmich({ client, config, bridge });
  const cards = deps.cards || Cards, batches = deps.batches || Batches;
  const pause = deps.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;
  async function assertWindow(job, remaining = 0) {
    if (deps.assertWindow) return deps.assertWindow(job, remaining);
    const current = await require('../heavyWorkQueueService').get(job.id);
    if (current.dispatchId !== job.dispatchId || current.state !== 'running'
      || now() < Date.parse(current.reservation?.start) || now() + remaining >= Date.parse(current.reservation?.end)
      || !Number.isFinite(Date.parse(current.reservation?.end)))
      throw fail('HEAVY_QUEUE_WINDOW_CLOSED', 'Observe this processing identity before assigning another execution window');
  }
  async function run(row, job) {
    pinnedConfig = { ...configured() };
    if (row.configHash !== hash([pinnedConfig.libraryId, pinnedConfig.originalPathPrefix, pinnedConfig.nasHost]))
      throw fail('PHOTO_PROCESSING_CONFIG_CHANGED', 'The queued library configuration changed before execution');
    await assertWindow(job);
    await immich.validateLibrary();
    const projection = await bridge.call({ op: 'project', operationId: row._id, runId: row.runId, items: row.items });
    const selected = [...new Map(projection.results.filter(x => !x.skipped).map(x => [x.sha256, x])).values()];
    await batches.updateOne({ _id: row._id, dispatchId: job.dispatchId }, { $set: { projections: projection.results,
      progress: { phase: 'index', selected: selected.length, linked: 0 } } }, { writeConcern: WC });
    const assets = new Map();
    for (const item of selected) {
      const asset = await immich.asset(item); if (asset) assets.set(item.sha256, asset);
    }
    if (assets.size < selected.length) {
      // Persist before the non-idempotent upstream scan. A lost answer is
      // observed through this identity; no replacement scan is dispatched.
      const frozen = await batches.findOneAndUpdate({ _id: row._id, scanDispatchedAt: { $exists: false } },
        { $set: { scanDispatchedAt: new Date() } }, { new: true, writeConcern: WC }).lean();
      if (frozen) { await assertWindow(job, 15 * 60 * 1000); await immich.scan(); }
      const end = now() + 15 * 60 * 1000;
      while (true) {
        for (const item of selected) {
          const asset = await immich.asset(item); if (asset) assets.set(item.sha256, asset);
        }
        const idle = queuesIdle(await client.json('/jobs'));
        if (assets.size === selected.length && idle) break;
        if (now() >= end) throw fail('PHOTO_INDEX_RECONCILIATION_REQUIRED', 'Immich indexing still needs observation; no scan is replayed');
        await batches.updateOne({ _id: row._id }, { $set: { progress: { phase: 'index', selected: selected.length, linked: assets.size } } });
        await pause(5000);
        await assertWindow(job);
      }
    } else if (!queuesIdle(await client.json('/jobs'))) {
      throw fail('PHOTO_INDEX_RECONCILIATION_REQUIRED', 'Immich still has active indexing work');
    }
    let completed = 0, failedAnalyses = 0;
    for (const projection of selected) {
      const asset = assets.get(projection.sha256);
      const ocr = await client.json('/assets/' + asset.id + '/ocr');
      await cards.updateOne({ _id: projection.sha256 }, { $setOnInsert: { projection,
        review: { revision: 0, approved: false }, frame: { revision: 0, selected: false } },
      $set: { assetId: asset.id, libraryId: config().libraryId, metadata: metadata(asset, require('./photoService').ocrText(ocr)) } }, { upsert: true, writeConcern: WC });
      let card = await cards.findById(projection.sha256).lean();
      if (asset.type === 'IMAGE' && !card.analysis) {
        if (!card.review?.revision && !card.pendingDecision)
          await immich.pendingTag(asset.id, { sha256:card._id });
        const preview = await client.image('/assets/' + asset.id + '/thumbnail?size=preview');
        await assertWindow(job, 180000);
        const analysisId = crypto.randomUUID();
        const claimed = await cards.findOneAndUpdate({ _id: card._id, analysis: { $exists: false } },
          { $set: { analysis: { state: 'running', analysisId, batchId: row._id, queueId: job.id, startedAt: new Date() } } },
          { new: true, writeConcern: WC }).lean();
        if (!claimed) throw fail('PHOTO_ANALYSIS_HELD', 'Another analysis owns this content');
        const inference = deps.inference || require('../../extensions/trustedRuntimeServices').createTrustedRuntimeServices().inference;
        let result, state = 'completed';
        try { result = { ...await analyze({ inference, ...preview, sha256: card._id, analysisId, queueId: job.id, target: row.target }), metadata: card.metadata }; }
        catch (error) {
          // A malformed returned proposal is a known completed inference, not
          // evidence of an outstanding model call. Preserve its failed attempt
          // without retrying it or blocking unrelated content indefinitely.
          if (!completedAnalysisFailure(error)) throw error;
          state = 'failed';
          result = { schema: 'agentx.photo-metadata/v1', analysisId, sourceSha256: card._id,
            metadata: card.metadata, reviewed: false, vision: 'failed', error: error.code };
        }
        await cards.updateOne({ _id: card._id, 'analysis.analysisId': analysisId, 'analysis.state': 'running' },
          { $set: { analysis: { state, analysisId, card: result } } }, { writeConcern: WC });
        card = await cards.findById(card._id).lean();
      }
      if (card.analysis?.state === 'running') throw fail('PHOTO_ANALYSIS_HELD', 'Observe the original analysis; no model replay');
      if (card.analysis?.state === 'failed') failedAnalyses++;
      if (asset.type !== 'IMAGE' && !card.analysis) {
        const analysisId = crypto.randomUUID();
        await cards.updateOne({ _id: card._id, analysis: { $exists: false } }, { $set: { analysis: { state: 'completed', analysisId,
          card: { schema: 'agentx.photo-metadata/v1', sourceSha256: card._id, analysisId, metadata: card.metadata,
            reviewed: false, vision: 'not-applicable' } } } }, { writeConcern: WC });
        card = await cards.findById(card._id).lean();
      }
      if (card.analysis?.card) await bridge.call({ op: 'exportCard', sha256: card._id,
        analysisId: card.analysis.analysisId, card: card.analysis.card });
      completed++;
      await batches.updateOne({ _id: row._id }, { $set: { progress: { phase: 'analysis', selected: selected.length, completed } } });
    }
    await batches.updateOne({ _id: row._id, dispatchId: job.dispatchId }, { $set: { state: 'completed', finishedAt: new Date(),
      progress: { phase: 'completed', selected: selected.length, completed, failedAnalyses,
        companions: projection.results.length - selected.length } } }, { writeConcern: WC });
  }
  return { run };
}
module.exports = { createPhotoProcessingWork, queuesIdle };
