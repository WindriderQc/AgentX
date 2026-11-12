'use strict';
const Cards = require('../../../models/PhotoProcessingCard');
const Batches = require('../../../models/PhotoProcessingBatch');
const Decisions = require('../../../models/PhotoProcessingDecision');
const { id } = require('./phoneLibrary');
const { fail } = require('./importFiles');
const { loadProcessingConfig } = require('./photoProcessingConfig');
const { createPhotoProcessingBridge } = require('./photoProcessingBridge');
const { createImmichClient } = require('./immichClient');
const { createPhotoProcessingImmich } = require('./photoProcessingImmich');
const { createPhotoProcessingReview } = require('./photoProcessingReview');
function createPhotoProcessingService(deps = {}) {
  const config = deps.config || loadProcessingConfig, bridge = deps.bridge || createPhotoProcessingBridge({ config });
  const client = deps.client || createImmichClient(), cards = deps.cards || Cards, batches = deps.batches || Batches;
  const immich = deps.immich || createPhotoProcessingImmich({ client, config, bridge });
  const decisions = createPhotoProcessingReview({ client, bridge, immich, config, cards,
    frameConfig: deps.frameConfig || require('./photoFrameService').loadFrameConfig, decisions: deps.decisions });
  function status() {
    const fixed = config();
    return { configured: Boolean(fixed), frameEnabled: Boolean(fixed?.frameAlbumId), batchLimit: 24 };
  }
  async function page(input) {
    if (!status().configured) return { results: [], jobs: [], ...status() };
    const runId = id(input.runId);
    if (!Array.isArray(input.items) || input.items.length > 24) throw fail('INVALID_SELECTION', 'Read at most twenty-four photo cards');
    const results = [];
    for (const requestId of [...new Set(input.items.map(id))]) {
      const entry = await bridge.call({ op: 'occurrence', runId, requestId });
      const sha256 = entry.backup.sha256;
      const card = await cards.findById(sha256).lean();
      const pending = card?.pendingDecision && await (deps.decisions || Decisions).findById(card.pendingDecision).lean();
      results.push({ requestId, sha256, ...(card ? { assetId: card.assetId, metadata: card.metadata,
        analysis: card.analysis, review: card.review, frame: card.frame,
        ...(pending ? { pendingIntent: { writeId: pending._id, kind: pending.kind, value: pending.value, expectedRevision: pending.expectedRevision } } : {}) } : {}) });
    }
    let jobs = await batches.find({ runId, state: { $in: ['queued', 'claimed', 'running', 'uncertain'] } }).sort({ createdAt: 1 }).limit(10).lean();
    if (!jobs.length) jobs = await batches.find({ runId }).sort({ createdAt: -1 }).limit(10).lean();
    return { results, jobs: jobs.map(row => ({ operationId: row._id, state: row.state, queueId: row.queueId,
      progress: row.progress, error: row.error })), ...status() };
  }
  return { status, page, review: decisions.review, frame: decisions.frame,
    enqueueRun: input => require('./photoProcessingRuns').enrollRun(input, deps),
    enqueue: input => (deps.queue || require('./photoProcessingQueue')).enqueue(input, deps) };
}
module.exports = { createPhotoProcessingService };
