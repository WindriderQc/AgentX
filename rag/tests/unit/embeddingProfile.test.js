jest.mock('../../src/services/embeddings', () => {
  const make = (config = {}) => ({
    model: config.embeddingModel || 'env-model',
    dimension: config.dimension || 4,
    getDimension() { return this.dimension; },
    // A deterministic vector whose size is the model's dimension.
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
const { RagStore } = require('../../src/services/ragStore');
const { storeForCollection, resetMemoryStores } = require('../../src/services/collectionStores');
const { memoryProfileRepository } = require('../helpers/memoryProfileRepository');

const env = { EMBEDDING_MODEL: 'model-a', EMBEDDING_DIMENSION: '4', QDRANT_COLLECTION: 'docs_a' };

describe('active embedding profile', () => {
  beforeEach(() => {
    process.env.VECTOR_STORE_TYPE = 'memory';
    resetMemoryStores();
  });

  test('is seeded once from the environment and served by the RagStore', async () => {
    const repository = memoryProfileRepository();
    const profiles = createProfileService({ repository, env });
    const rag = new RagStore({ type: 'memory' });
    await profiles.configure(rag);
    expect(await profiles.read()).toMatchObject({ revision: 0, active: { model: 'model-a', dimension: 4, collection: 'docs_a' }, previous: null });
    expect(rag.embeddingsService.model).toBe('model-a');
    expect(rag.vectorStore).toBe(storeForCollection('docs_a', 4));
    // A later environment does not replace the stored profile.
    const later = createProfileService({ repository, env: { ...env, EMBEDDING_MODEL: 'model-z' } });
    expect((await later.read()).active.model).toBe('model-a');
  });

  test('a swap needs the freeze of the same build and the expected revision', async () => {
    const profiles = createProfileService({ repository: memoryProfileRepository(), env });
    await profiles.read();
    const next = { model: 'model-b', dimension: 8, collection: 'docs_b' };
    expect(await profiles.swap(0, next, { buildId: 'b1' })).toBeNull();
    expect(await profiles.freeze(0, 'b1', 60000)).toMatchObject({ freeze: { buildId: 'b1' } });
    expect(await profiles.freeze(0, 'b2', 60000)).toBeNull();
    expect(await profiles.swap(0, next, { buildId: 'b2' })).toBeNull();
    const swapped = await profiles.swap(0, next, { buildId: 'b1' });
    expect(swapped).toMatchObject({ revision: 1, active: next, previous: { model: 'model-a' }, freeze: null });
    expect(await profiles.swap(0, next, { buildId: 'b1' })).toBeNull();
  });

  test('a write waits for the freeze and lands in the collection that serves afterwards', async () => {
    let clock = 0;
    const repository = memoryProfileRepository();
    const profiles = createProfileService({
      repository, env,
      now: () => new Date(1700000000000 + clock),
      sleep: async (ms) => {
        clock += ms;
        // The build switches collections while the writer waits.
        if (repository.doc.freeze) await profiles.swap(0, { model: 'model-b', dimension: 8, collection: 'docs_b' }, { buildId: 'b1' });
      }
    });
    const rag = new RagStore({ type: 'memory' });
    await profiles.configure(rag);
    await profiles.freeze(0, 'b1', 60000);

    await rag.upsertDocumentWithChunks('Late note', { documentId: 'late', source: 'notes' });
    expect(await storeForCollection('docs_a', 4).getDocument('late')).toBeNull();
    expect(await storeForCollection('docs_b', 8).getDocument('late')).toMatchObject({ documentId: 'late' });
    expect(rag.embeddingsService.model).toBe('model-b');
  });

  test('a write that a switch overtakes is written again on the new collection', async () => {
    const repository = memoryProfileRepository();
    const profiles = createProfileService({ repository, env, sleep: async () => {} });
    const rag = new RagStore({ type: 'memory' });
    await profiles.configure(rag);
    const oldStore = storeForCollection('docs_a', 4);
    const upsert = oldStore.upsertDocument.bind(oldStore);
    oldStore.upsertDocument = async (...args) => {
      const result = await upsert(...args);
      // The switch completes while this write is in flight.
      await profiles.freeze(0, 'b1', 60000);
      await profiles.swap(0, { model: 'model-b', dimension: 8, collection: 'docs_b' }, { buildId: 'b1' });
      return result;
    };
    await rag.upsertDocumentWithChunks('Racing note', { documentId: 'race', source: 'notes' });
    expect(await storeForCollection('docs_b', 8).getDocument('race')).toMatchObject({ documentId: 'race' });
  });
});
