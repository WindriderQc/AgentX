jest.mock('../../src/services/embeddings', () => {
  const make = (config = {}) => ({
    model: config.embeddingModel || 'env-model',
    dimension: config.dimension || 4,
    getDimension() { return this.dimension; },
    embedBatch: jest.fn(async (texts) => texts.map((text) => Array.from({ length: config.dimension || 4 }, (_, i) => (text.length + i) / 10)))
  });
  let shared = null;
  return {
    EmbeddingsService: function EmbeddingsService(config) { return make(config); },
    getEmbeddingsService: (config) => { if (!shared) shared = make(config); return shared; },
    resetEmbeddingsService: () => { shared = null; }
  };
});

const { createProfileService } = require('../../src/services/embeddingProfile');
const { createBuildService } = require('../../src/services/embeddingBuild');
const { RagStore } = require('../../src/services/ragStore');
const collectionStores = require('../../src/services/collectionStores');
const { memoryProfileRepository } = require('../helpers/memoryProfileRepository');
const { memoryBuildRepository } = require('../helpers/memoryBuildRepository');

const env = { EMBEDDING_MODEL: 'model-a', EMBEDDING_DIMENSION: '4', QDRANT_COLLECTION: 'docs' };
const BUILD = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';

async function setup({ verify = async () => {}, stores } = {}) {
  process.env.VECTOR_STORE_TYPE = 'memory';
  collectionStores.resetMemoryStores();
  const profileRepository = memoryProfileRepository();
  const profiles = createProfileService({ repository: profileRepository, env, sleep: async () => {} });
  const serving = new RagStore({ type: 'memory' });
  await profiles.configure(serving);
  await serving.upsertDocumentWithChunks('Alpha document text', { documentId: 'alpha', source: 'docs' });
  await serving.upsertDocumentWithChunks('Beta document text', { documentId: 'beta', source: 'docs' });
  const repository = memoryBuildRepository();
  const builds = createBuildService({ repository, profiles, verifyQueueRequest: verify, servingRagStore: () => serving, stores: stores || collectionStores });
  return { profiles, profileRepository, serving, repository, builds };
}

describe('embedding index build', () => {
  test('copies every document into a new collection, then switches RAG to it', async () => {
    const { builds, profiles, serving } = await setup();
    const started = await builds.start({ buildId: BUILD, model: 'qllama/bge-m3:f16', dimension: 8 });
    expect(started).toMatchObject({ id: BUILD, status: 'copying', sourceCollection: 'docs', targetCollection: 'docs__qllama_bge_m3_f16_11111111' });
    // Search still reads the previous collection while the build copies.
    expect(serving.vectorStore).toBe(collectionStores.storeForCollection('docs', 4));
    await builds.settled(BUILD);

    expect(await builds.get(BUILD)).toMatchObject({
      status: 'activated', profileRevision: 1,
      progress: { total: 2, documents: 2, migrated: 2, failed: 0, finalPass: { migrated: 0, pruned: 0 } }
    });
    expect(await profiles.read()).toMatchObject({
      revision: 1, freeze: null,
      active: { model: 'qllama/bge-m3:f16', dimension: 8, collection: 'docs__qllama_bge_m3_f16_11111111' },
      previous: { model: 'model-a', dimension: 4, collection: 'docs' }
    });
    expect(serving.embeddingsService.model).toBe('qllama/bge-m3:f16');
    const target = collectionStores.storeForCollection('docs__qllama_bge_m3_f16_11111111', 8);
    expect(serving.vectorStore).toBe(target);
    expect((await target.getCollectionInfo()).vectorSize).toBe(8);
    expect((await target.listDocuments()).documents.map((d) => d.documentId).sort()).toEqual(['alpha', 'beta']);
    // The previous collection is kept, unchanged, until it is retired explicitly.
    expect((await collectionStores.storeForCollection('docs', 4).listDocuments()).total).toBe(2);
  });

  test('writes and deletions made during the copy reach the new collection', async () => {
    let serving;
    let injected = false;
    const stores = {
      ...collectionStores,
      ragStoreFor(spec) {
        const target = collectionStores.ragStoreFor(spec);
        const upsert = target.upsertDocumentWithChunks.bind(target);
        target.upsertDocumentWithChunks = async (...args) => {
          const result = await upsert(...args);
          if (!injected) {
            injected = true;
            // Ingestion keeps serving the old collection during the copy.
            await serving.upsertDocumentWithChunks('Gamma arrived late', { documentId: 'gamma', source: 'docs' });
            await serving.deleteDocument('beta');
          }
          return result;
        };
        return target;
      }
    };
    const ctx = await setup({ stores });
    serving = ctx.serving;
    await ctx.builds.start({ buildId: BUILD, model: 'model-b', dimension: 8 });
    await ctx.builds.settled(BUILD);
    const build = await ctx.builds.get(BUILD);
    expect(build.status).toBe('activated');
    const target = collectionStores.storeForCollection(build.targetCollection, 8);
    expect((await target.listDocuments()).documents.map((d) => d.documentId).sort()).toEqual(['alpha', 'gamma']);
    expect(build.progress.finalPass).toEqual({ migrated: 1, pruned: 1 });
  });

  test('starts only from a dispatched queue request', async () => {
    const refuse = async () => { throw Object.assign(new Error('not queued'), { statusCode: 409, code: 'EMBEDDING_BUILD_NOT_QUEUED' }); };
    const { builds, repository } = await setup({ verify: refuse });
    await expect(builds.start({ buildId: BUILD, model: 'model-b', dimension: 8 })).rejects.toMatchObject({ code: 'EMBEDDING_BUILD_NOT_QUEUED' });
    expect(repository.rows.size).toBe(0);
  });

  test('a lost answer is replayed by the same id, never started twice', async () => {
    const verify = jest.fn(async () => {});
    const { builds } = await setup({ verify });
    const first = await builds.start({ buildId: BUILD, model: 'model-b', dimension: 8 });
    const again = await builds.start({ buildId: BUILD, model: 'model-b', dimension: 8 });
    expect(again.id).toBe(first.id);
    expect(verify).toHaveBeenCalledTimes(1);
    await expect(builds.start({ buildId: BUILD, model: 'model-c', dimension: 8 })).rejects.toMatchObject({ code: 'EMBEDDING_BUILD_CONFLICT' });
    await expect(builds.start({ buildId: OTHER, model: 'model-c', dimension: 8 })).rejects.toMatchObject({ code: 'EMBEDDING_BUILD_ACTIVE' });
    await builds.settled(BUILD);
  });

  test('a cancelled build leaves the previous profile serving', async () => {
    const { builds, profiles, serving } = await setup();
    await builds.start({ buildId: BUILD, model: 'model-b', dimension: 8 });
    await builds.cancel(BUILD);
    await builds.settled(BUILD);
    expect(await builds.get(BUILD)).toMatchObject({ status: 'cancelled', cancelRequested: true });
    expect(await profiles.read()).toMatchObject({ revision: 0, freeze: null, active: { model: 'model-a', collection: 'docs' } });
    expect(serving.embeddingsService.model).toBe('model-a');
  });

  test('a document that cannot be copied fails the build before any switch', async () => {
    const { builds, profiles } = await setup();
    // A legacy document stored without its original text cannot be rebuilt.
    const source = collectionStores.storeForCollection('docs', 4);
    source.documents.get('alpha').originalText = undefined;
    await builds.start({ buildId: BUILD, model: 'model-b', dimension: 8 });
    await builds.settled(BUILD);
    const build = await builds.get(BUILD);
    expect(build.status).toBe('failed');
    expect(build.error).toContain('without original text');
    expect(await profiles.read()).toMatchObject({ revision: 0, freeze: null, active: { model: 'model-a' } });
  });

  test('refuses a build for the model already served', async () => {
    const { builds } = await setup();
    await expect(builds.start({ buildId: BUILD, model: 'model-a', dimension: 4 })).rejects.toMatchObject({ code: 'EMBEDDING_MODEL_UNCHANGED' });
  });

  test('after a restart an unfinished build is failed and its freeze released', async () => {
    const { builds, repository, profiles, profileRepository } = await setup();
    repository.rows.set(OTHER, { _id: OTHER, status: 'finalizing', startedAt: new Date().toISOString(), model: 'model-b', dimension: 8 });
    await profiles.freeze(0, OTHER, 60000);
    await builds.recoverInterrupted();
    expect(repository.rows.get(OTHER)).toMatchObject({ status: 'failed' });
    expect(repository.rows.get(OTHER).error).toContain('previous index keeps serving');
    expect(profileRepository.doc.freeze).toBeNull();
  });
});

describe('retiring the previous collection', () => {
  test('deletes only the collection the switch replaced, once it is named with the current revision', async () => {
    const { builds, profiles } = await setup();
    await builds.start({ buildId: BUILD, model: 'model-b', dimension: 8 });
    await builds.settled(BUILD);
    const { revision, active, previous } = await profiles.read();
    await expect(builds.retirePrevious({ collection: active.collection, expectedRevision: revision })).rejects.toMatchObject({ code: 'EMBEDDING_PROFILE_CHANGED' });
    await expect(builds.retirePrevious({ collection: previous.collection, expectedRevision: revision - 1 })).rejects.toMatchObject({ code: 'EMBEDDING_PROFILE_CHANGED' });

    const retired = await builds.retirePrevious({ collection: 'docs', expectedRevision: revision });
    expect(retired).toMatchObject({ collection: 'docs', deleted: true, profile: { previous: null, active: { collection: active.collection } } });
    expect(await collectionStores.storeForCollection('docs', 4).getCollectionInfo()).toBeNull();
    expect((await collectionStores.storeForCollection(active.collection, 8).listDocuments()).total).toBe(2);
    await expect(builds.retirePrevious({ collection: 'docs', expectedRevision: revision })).rejects.toMatchObject({ code: 'EMBEDDING_PROFILE_CHANGED' });
  });

  test('refuses while a build is in progress', async () => {
    const { builds, repository, profiles } = await setup();
    await builds.start({ buildId: BUILD, model: 'model-b', dimension: 8 });
    await builds.settled(BUILD);
    const { revision } = await profiles.read();
    repository.rows.set(OTHER, { _id: OTHER, status: 'copying', startedAt: new Date().toISOString() });
    await expect(builds.retirePrevious({ collection: 'docs', expectedRevision: revision })).rejects.toMatchObject({ code: 'EMBEDDING_BUILD_ACTIVE' });
  });
});
