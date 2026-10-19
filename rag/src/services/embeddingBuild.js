'use strict';

/**
 * Build a new embedding index for another model, then switch RAG to it.
 *
 * A build copies every document from the serving collection into a new one,
 * re-embedded with the target model; search keeps the serving collection the
 * whole time. Then it freezes writes, runs a pruning delta pass for what
 * changed meanwhile, and swaps the profile. A failure, a cancellation or a
 * restart before the swap leaves the previous profile serving. Only Core's
 * heavy-work queue starts a build: its request id is the build id.
 */

const logger = require('../../config/logger');
const { migrateEmbeddingCollection, CancelledError } = require('./embeddingCollectionMigration');
const { storeForCollection, ragStoreFor } = require('./collectionStores');
const { getProfileService } = require('./embeddingProfile');

const IN_PROGRESS = ['copying', 'finalizing'];
const FREEZE_MS = 10 * 60000;
const PROGRESS_EVERY = 10;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const BUILD_ID_PATTERN = /^[a-f0-9-]{36}$/;

function fail(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function targetCollectionName(sourceCollection, model, buildId) {
  const base = sourceCollection.split('__')[0];
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'model';
  return `${base}__${slug}_${buildId.slice(0, 8)}`;
}

function view(build) {
  if (!build) return null;
  const { _id, ...rest } = build;
  return { id: _id, ...rest };
}

function mongoRepository() {
  const Model = require('../../models/EmbeddingBuild');
  return {
    get: (id) => Model.findById(id).lean(),
    latest: () => Model.findOne({}).sort({ startedAt: -1 }).lean(),
    findInProgress: () => Model.findOne({ status: { $in: IN_PROGRESS } }).lean(),
    async create(doc) {
      try { await Model.create(doc); } catch (err) { if (err.code !== 11000) throw err; }
      return Model.findById(doc._id).lean();
    },
    update: (id, fromStatuses, set) => Model.findOneAndUpdate({ _id: id, status: { $in: fromStatuses } }, { $set: set }, { new: true }).lean(),
    listInProgress: () => Model.find({ status: { $in: IN_PROGRESS } }).lean()
  };
}

function summaryProgress(summary, total) {
  return {
    total,
    documents: summary.documents,
    migrated: summary.migrated,
    skipped: summary.skipped.length,
    failed: summary.failed.length,
    missingOriginalText: summary.missingOriginalText,
    pruned: summary.pruned
  };
}

function createBuildService({
  repository = mongoRepository(),
  profiles = getProfileService(),
  verifyQueueRequest,
  servingRagStore = () => require('./ragStore').getRagStore(),
  stores = { storeForCollection, ragStoreFor },
  freezeMs = FREEZE_MS,
  now = () => new Date()
} = {}) {
  const cancelled = new Set();
  const running = new Map();

  async function saveProgress(id, summary, total) {
    await repository.update(id, IN_PROGRESS, { progress: summaryProgress(summary, total) });
  }

  async function copy(build, options, total) {
    const deps = {
      sourceStore: stores.storeForCollection(build.sourceCollection, build.sourceDimension),
      targetStore: stores.storeForCollection(build.targetCollection, build.dimension),
      targetRagStore: stores.ragStoreFor({ collection: build.targetCollection, model: build.model, dimension: build.dimension }),
      embeddingModel: build.model,
      embeddingDimension: build.dimension,
      shouldStop: () => cancelled.has(build._id),
      onProgress: (summary) => {
        if (summary.documents % PROGRESS_EVERY === 0) saveProgress(build._id, summary, total).catch(() => {});
      }
    };
    const summary = await migrateEmbeddingCollection({ source: build.sourceCollection, target: build.targetCollection, ...options }, deps);
    if (summary.failed.length || summary.missingOriginalText) {
      throw Object.assign(fail(`${summary.failed.length + summary.missingOriginalText} documents could not be copied`
        + ` (${summary.missingOriginalText} without original text); the previous index keeps serving`, 409, 'EMBEDDING_BUILD_INCOMPLETE'), { summary });
    }
    return { summary, targetStore: deps.targetStore };
  }

  async function finalize(build, total) {
    const frozen = await profiles.freeze(build.fromRevision, build._id, freezeMs);
    if (!frozen) throw fail('The serving embedding profile changed during the build', 409, 'EMBEDDING_PROFILE_CHANGED');
    try {
      // Writes accepted before the freeze, and deletions, reach the new collection.
      const { summary, targetStore } = await copy(build, { delta: true, prune: true }, total);
      const info = await targetStore.getCollectionInfo();
      if (summary.documents > 0 && info?.vectorSize !== build.dimension) {
        throw fail(`The new collection holds vectors of size ${info?.vectorSize}, not ${build.dimension}`, 409, 'EMBEDDING_DIMENSION_MISMATCH');
      }
      const next = { model: build.model, dimension: build.dimension, collection: build.targetCollection };
      const swapped = await profiles.swap(build.fromRevision, next, { buildId: build._id });
      if (!swapped) throw fail('The serving embedding profile changed before the switch', 409, 'EMBEDDING_PROFILE_CHANGED');
      profiles.apply(servingRagStore(), swapped);
      return { summary, swapped };
    } catch (err) {
      await profiles.thaw(build._id);
      throw err;
    }
  }

  async function run(build) {
    const id = build._id;
    let total = null;
    try {
      const stats = await stores.storeForCollection(build.sourceCollection, build.sourceDimension).getStats();
      total = Number.isFinite(stats?.documentCount) ? stats.documentCount : null;
      const { summary } = await copy(build, {}, total);
      const copied = summaryProgress(summary, total);
      await repository.update(id, ['copying'], { status: 'finalizing', progress: copied });
      if (cancelled.has(id)) throw new CancelledError('build cancelled');
      const finished = await finalize(build, total);
      await repository.update(id, ['finalizing'], {
        status: 'activated', finishedAt: now(), profileRevision: finished.swapped.revision,
        // The copy's counts, and what the final pass added or removed after it.
        progress: { ...copied, finalPass: { migrated: finished.summary.migrated, pruned: finished.summary.pruned } }
      });
      logger.info('Embedding build activated', { buildId: id, model: build.model, collection: build.targetCollection });
    } catch (err) {
      const status = err instanceof CancelledError ? 'cancelled' : 'failed';
      await repository.update(id, IN_PROGRESS, {
        status, finishedAt: now(), error: status === 'failed' ? String(err.message).slice(0, 1000) : null,
        ...(err.summary ? { progress: summaryProgress(err.summary, total) } : {})
      });
      logger.warn(`Embedding build ${status}; the previous index keeps serving`, { buildId: id, error: err.message });
    } finally {
      cancelled.delete(id);
      running.delete(id);
    }
  }

  async function start({ buildId, model, dimension } = {}) {
    if (!BUILD_ID_PATTERN.test(String(buildId || ''))) throw fail('buildId must be the queue request id', 400, 'EMBEDDING_BUILD_INVALID');
    if (!MODEL_PATTERN.test(String(model || ''))) throw fail('model must be an embedding model name', 400, 'EMBEDDING_BUILD_INVALID');
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 8192) throw fail('dimension must be 1 to 8192', 400, 'EMBEDDING_BUILD_INVALID');

    const existing = await repository.get(buildId);
    if (existing) {
      if (existing.model !== model || existing.dimension !== dimension) throw fail('This build id names another build', 409, 'EMBEDDING_BUILD_CONFLICT');
      return view(existing);
    }
    // Only the heavy-work queue starts a build, inside its dispatch window.
    await verifyQueueRequest(buildId, { model, dimension });
    const other = await repository.findInProgress();
    if (other) throw fail(`Embedding build ${other._id} is still in progress`, 409, 'EMBEDDING_BUILD_ACTIVE');
    const profile = await profiles.read();
    if (profile.active.model === model && profile.active.dimension === dimension) {
      throw fail(`RAG already serves ${model}`, 409, 'EMBEDDING_MODEL_UNCHANGED');
    }
    const build = await repository.create({
      _id: buildId, model, dimension,
      sourceCollection: profile.active.collection, sourceModel: profile.active.model, sourceDimension: profile.active.dimension,
      targetCollection: targetCollectionName(profile.active.collection, model, buildId),
      fromRevision: profile.revision, status: 'copying', cancelRequested: false, progress: {}, error: null,
      profileRevision: null, startedAt: now(), finishedAt: null
    });
    if (build.status === 'copying' && !running.has(buildId)) running.set(buildId, run(build));
    return view(build);
  }

  async function cancel(id) {
    const build = await repository.get(id);
    if (!build) throw fail('Embedding build not found', 404, 'EMBEDDING_BUILD_NOT_FOUND');
    if (build.status === 'finalizing') throw fail('The build is switching collections; it can no longer be cancelled', 409, 'EMBEDDING_BUILD_FINALIZING');
    if (build.status !== 'copying') return view(build);
    cancelled.add(id);
    return view(await repository.update(id, ['copying'], { cancelRequested: true }) || build);
  }

  /** A build this process no longer runs (restart) cannot resume: the previous index keeps serving. */
  async function recoverInterrupted() {
    for (const build of await repository.listInProgress()) {
      if (running.has(build._id)) continue;
      await profiles.thaw(build._id);
      await repository.update(build._id, IN_PROGRESS, {
        status: 'failed', finishedAt: now(), error: 'Interrupted by a RAG restart before the switch; the previous index keeps serving'
      });
    }
  }

  /**
   * Delete the collection the last switch replaced. The caller names it and the
   * revision it saw; nothing else is ever deleted, and never during a build.
   */
  async function retirePrevious({ collection, expectedRevision } = {}) {
    const profile = await profiles.read();
    if (!profile.previous || profile.previous.collection !== collection || profile.revision !== expectedRevision) {
      throw fail('Only the previous collection named in the current profile can be retired', 409, 'EMBEDDING_PROFILE_CHANGED');
    }
    if (collection === profile.active.collection) throw fail('The serving collection cannot be retired', 409, 'EMBEDDING_COLLECTION_SERVING');
    if (await repository.findInProgress()) throw fail('An embedding build is in progress', 409, 'EMBEDDING_BUILD_ACTIVE');
    const deleted = await stores.storeForCollection(collection, profile.previous.dimension).deleteCollection();
    const updated = await profiles.forgetPrevious(expectedRevision, collection);
    logger.info('Previous embedding collection retired', { collection, deleted });
    return { collection, deleted, profile: updated };
  }

  return {
    start,
    cancel,
    recoverInterrupted,
    retirePrevious,
    get: async (id) => view(await repository.get(id)),
    latest: async () => view(await repository.latest()),
    // Tests wait for the background run they started.
    settled: (id) => running.get(id) || Promise.resolve()
  };
}

/** Core's queue must hold this request, dispatching or running, for the same model. */
async function verifyCoreQueueRequest(buildId, { model, dimension }) {
  const fetchWithTimeout = require('../utils/fetchWithTimeout');
  const { SERVICE_OUTBOUND_OPERATION_IDS, SERVICE_OUTBOUND_TIMEOUTS, configuredServiceOrigin } = require('../clients/serviceOutboundClient');
  const core = configuredServiceOrigin(process.env.CORE_PROXY_URL || 'http://localhost:3080');
  const operationId = SERVICE_OUTBOUND_OPERATION_IDS.CORE_QUEUE_READ;
  const response = await fetchWithTimeout(`${core}/api/cluster/schedule/work-queue/${buildId}`, {}, SERVICE_OUTBOUND_TIMEOUTS[operationId],
    { expectedOrigins: [core], operationId });
  const body = await response.json().catch(() => null);
  const job = body?.data || body;
  const matches = response.ok && job?.kind === 'embedding-reindex' && ['dispatching', 'running'].includes(job.state)
    && job.executor?.model === model && job.executor?.dimension === dimension;
  if (!matches) throw fail('A build starts only from its dispatched heavy-work request', 409, 'EMBEDDING_BUILD_NOT_QUEUED');
}

let shared = null;
function getBuildService() {
  if (!shared) shared = createBuildService({ verifyQueueRequest: verifyCoreQueueRequest });
  return shared;
}

async function recoverInterruptedBuilds() {
  return getBuildService().recoverInterrupted();
}

module.exports = { createBuildService, getBuildService, recoverInterruptedBuilds, verifyCoreQueueRequest, targetCollectionName, IN_PROGRESS };
