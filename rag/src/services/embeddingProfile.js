'use strict';

/**
 * The embedding profile RAG serves: model, dimension and Qdrant collection.
 *
 * It lives in Mongo, seeded once from EMBEDDING_MODEL, EMBEDDING_DIMENSION and
 * QDRANT_COLLECTION. Only a completed build replaces it, by compare-and-set on
 * its revision, so search never mixes vectors from two models. While a build
 * switches collections it freezes writes; every write to the serving store
 * waits for the freeze to end and repeats itself on the new collection if the
 * switch happened while it ran, so no ingestion is lost.
 */

const logger = require('../../config/logger');
const { storeForCollection } = require('./collectionStores');
const { getEmbeddingsService, resetEmbeddingsService } = require('./embeddings');

const PROFILE_ID = 'active';
const FREEZE_POLL_MS = 500;
const MAX_WRITE_ATTEMPTS = 3;

function envProfile(env = process.env) {
  return {
    model: env.EMBEDDING_MODEL || 'nomic-embed-text:v1.5',
    dimension: Number(env.EMBEDDING_DIMENSION) || 768,
    collection: env.QDRANT_COLLECTION || 'agentx_embeddings'
  };
}

function plain(doc) {
  if (!doc) return null;
  const pick = (p) => (p ? { model: p.model, dimension: p.dimension, collection: p.collection } : null);
  return {
    active: pick(doc.active),
    previous: pick(doc.previous),
    revision: doc.revision || 0,
    freeze: doc.freeze ? { buildId: doc.freeze.buildId, since: new Date(doc.freeze.since).toISOString(), until: new Date(doc.freeze.until).toISOString() } : null,
    activatedAt: doc.activatedAt ? new Date(doc.activatedAt).toISOString() : null,
    activatedBy: doc.activatedBy || null
  };
}

/** Mongo persistence; tests pass an in-memory repository with the same methods. */
function mongoRepository() {
  const Model = require('../../models/EmbeddingProfile');
  return {
    async load(seed) {
      await Model.updateOne({ _id: PROFILE_ID }, { $setOnInsert: { active: seed, previous: null, revision: 0, freeze: null } }, { upsert: true });
      return plain(await Model.findById(PROFILE_ID).lean());
    },
    async freeze(expectedRevision, freeze, now) {
      const doc = await Model.findOneAndUpdate(
        { _id: PROFILE_ID, revision: expectedRevision, $or: [{ freeze: null }, { 'freeze.until': { $lte: now } }] },
        { $set: { freeze } }, { new: true }
      ).lean();
      return plain(doc);
    },
    async thaw(buildId) {
      await Model.updateOne({ _id: PROFILE_ID, 'freeze.buildId': buildId }, { $set: { freeze: null } });
    },
    async forgetPrevious(expectedRevision, collection) {
      const doc = await Model.findOneAndUpdate(
        { _id: PROFILE_ID, revision: expectedRevision, 'previous.collection': collection },
        { $set: { previous: null } }, { new: true }
      ).lean();
      return plain(doc);
    },
    async swap(expectedRevision, next, { buildId, actor, now }) {
      const current = await Model.findById(PROFILE_ID).lean();
      if (!current || current.revision !== expectedRevision || current.freeze?.buildId !== buildId) return null;
      const doc = await Model.findOneAndUpdate(
        { _id: PROFILE_ID, revision: expectedRevision, 'freeze.buildId': buildId },
        { $set: { previous: current.active, active: next, freeze: null, activatedAt: now, activatedBy: actor }, $inc: { revision: 1 } },
        { new: true }
      ).lean();
      return plain(doc);
    }
  };
}

function createProfileService({ repository = mongoRepository(), env = process.env, now = () => new Date(), sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function read() {
    return repository.load(envProfile(env));
  }

  function frozen(profile, at = now()) {
    return Boolean(profile.freeze) && Date.parse(profile.freeze.until) > at.getTime();
  }

  // Point the serving RagStore and the shared embeddings service at the profile.
  function apply(ragStore, profile) {
    if (ragStore.profileRevision === profile.revision) return;
    const { model, dimension, collection } = profile.active;
    resetEmbeddingsService();
    ragStore.useProfile({
      vectorStore: storeForCollection(collection, dimension),
      embeddingsService: getEmbeddingsService({ embeddingModel: model, dimension }),
      revision: profile.revision
    });
    logger.info('RAG serves embedding profile', { model, dimension, collection, revision: profile.revision });
  }

  async function ready(ragStore) {
    for (;;) {
      const profile = await read();
      if (!frozen(profile)) {
        apply(ragStore, profile);
        return profile;
      }
      await wait(Math.min(FREEZE_POLL_MS, Math.max(1, Date.parse(profile.freeze.until) - now().getTime())));
    }
  }

  const writeGuard = {
    async run(ragStore, work) {
      for (let attempt = 1; ; attempt += 1) {
        const before = await ready(ragStore);
        const result = await work();
        const after = await read();
        // A freeze or switch that began during this write may have missed it: write again.
        if (after.revision === before.revision && !after.freeze) return result;
        if (attempt >= MAX_WRITE_ATTEMPTS) {
          throw Object.assign(new Error('The embedding collection changed during this write; retry it'), { code: 'EMBEDDING_PROFILE_CHANGED', statusCode: 409 });
        }
      }
    }
  };

  /** Serve the stored profile from this RagStore and guard its writes. */
  async function configure(ragStore) {
    apply(ragStore, await read());
    ragStore.setWriteGuard(writeGuard);
  }

  return {
    read,
    apply,
    configure,
    writeGuard,
    freeze: (expectedRevision, buildId, untilMs) => {
      const at = now();
      return repository.freeze(expectedRevision, { buildId, since: at, until: new Date(at.getTime() + untilMs) }, at);
    },
    thaw: (buildId) => repository.thaw(buildId),
    forgetPrevious: (expectedRevision, collection) => repository.forgetPrevious(expectedRevision, collection),
    swap: (expectedRevision, next, { buildId, actor = 'embedding-build' }) => repository.swap(expectedRevision, next, { buildId, actor, now: now() })
  };
}

let shared = null;
function getProfileService() {
  if (!shared) shared = createProfileService();
  return shared;
}

module.exports = { createProfileService, getProfileService, envProfile, plain, PROFILE_ID };
