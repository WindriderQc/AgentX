jest.mock('../../src/utils/fetchWithTimeout', () => jest.fn());

const fetch = require('../../src/utils/fetchWithTimeout');
const QdrantVectorStore = require('../../src/services/vectorStore/QdrantVectorStore');
const { RagStore, resetRagStore } = require('../../src/services/ragStore');

const ok = (result = {}) => ({ ok: true, json: async () => ({ result }), text: async () => '' });
const fail = () => ({ ok: false, status: 503, text: async () => 'unavailable' });

// In-memory Qdrant answering the scroll, upsert and filtered delete calls the
// store makes. `failUpsertBatch` and `failDelete` inject faults.
function fakeQdrant() {
  const state = { points: new Map(), upserts: 0, failUpsertBatch: null, failDelete: null };
  const matches = (payload, cond) => payload[cond.key] === cond.match.value;
  const select = (filter = {}) => [...state.points.values()].filter(point =>
    (filter.must || []).every(cond => matches(point.payload, cond))
    && !(filter.must_not || []).some(cond => matches(point.payload, cond)));
  fetch.mockReset();
  fetch.mockImplementation(async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    if (url.endsWith('/points/scroll')) {
      const hits = select(body.filter);
      const offset = body.offset || 0;
      const next = offset + body.limit < hits.length ? offset + body.limit : null;
      return ok({ next_page_offset: next, points: hits.slice(offset, offset + body.limit)
        .map(point => ({ id: point.id, ...(body.with_payload === false ? {} : { payload: point.payload }) })) });
    }
    if (url.endsWith('/points/delete')) {
      if (state.failDelete?.(body.filter)) return fail();
      select(body.filter).forEach(point => state.points.delete(point.id));
      return ok();
    }
    if (url.endsWith('/points') && options.method === 'PUT') {
      state.upserts += 1;
      if (state.upserts === state.failUpsertBatch) return fail();
      body.points.forEach(point => state.points.set(point.id, point));
      return ok();
    }
    return ok({});
  });
  return state;
}

const chunks = (count, version) => Array.from({ length: count }, (_, i) => ({
  chunkIndex: i, text: `${version}-${i}`, embedding: [1, 0]
}));
const stored = state => [...state.points.values()].map(point => point.payload);
const store = () => Object.assign(
  new QdrantVectorStore({ qdrantUrl: 'http://qdrant:6333', collectionName: 'test' }),
  { _collectionVerified: true }
);

describe('QdrantVectorStore revision writes', () => {
  let state;
  let qdrant;
  beforeEach(async () => {
    state = fakeQdrant();
    qdrant = store();
    await qdrant.upsertDocument('doc', { hash: 'v1' }, chunks(150, 'v1'));
    state.upserts = 0;
  });

  test('a failed second batch leaves the previous version whole', async () => {
    state.failUpsertBatch = 2;
    await expect(qdrant.upsertDocument('doc', { hash: 'v2' }, chunks(150, 'v2')))
      .rejects.toThrow('Qdrant upsert failed: 503');
    const payloads = stored(state);
    expect(payloads).toHaveLength(150);
    expect(payloads.every(payload => payload.hash === 'v1' && payload.text.startsWith('v1-'))).toBe(true);
    expect(new Set(payloads.map(payload => payload.revision)).size).toBe(1);
    expect(await qdrant.getDocument('doc')).not.toHaveProperty('mixedRevision');
  });

  test('a successful write leaves only the new revision', async () => {
    const result = await qdrant.upsertDocument('doc', { hash: 'v2' }, chunks(150, 'v2'));
    expect(result).toEqual({ documentId: 'doc', chunkCount: 150, status: 'updated' });
    const payloads = stored(state);
    expect(payloads).toHaveLength(150);
    expect(payloads.every(payload => payload.hash === 'v2')).toBe(true);
    expect(new Set(payloads.map(payload => payload.revision)).size).toBe(1);
    expect(await qdrant.getDocument('doc')).toMatchObject({ hash: 'v2', chunkCount: 150 });
  });

  test('a shorter version removes the previous tail', async () => {
    await qdrant.upsertDocument('doc', { hash: 'v2' }, chunks(20, 'v2'));
    const payloads = stored(state);
    expect(payloads.map(payload => payload.chunkIndex).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(payloads.every(payload => payload.hash === 'v2')).toBe(true);
  });

  test('a failed cleanup is surfaced and the document reads as mixed until rewritten', async () => {
    state.failDelete = filter => Boolean(filter.must_not);
    await expect(qdrant.upsertDocument('doc', { hash: 'v2' }, chunks(150, 'v2')))
      .rejects.toThrow('Qdrant delete by filter failed: 503');
    expect(await qdrant.getDocument('doc')).toMatchObject({ mixedRevision: true });
    state.failDelete = null;
    await qdrant.upsertDocument('doc', { hash: 'v2' }, chunks(150, 'v2'));
    expect(stored(state)).toHaveLength(150);
    expect(await qdrant.getDocument('doc')).not.toHaveProperty('mixedRevision');
  });

  test('a partial revision whose rollback failed reads as mixed', async () => {
    state.failUpsertBatch = 2;
    state.failDelete = () => true;
    await expect(qdrant.upsertDocument('fresh', { hash: 'v1' }, chunks(150, 'v1'))).rejects.toThrow();
    expect(stored(state).filter(payload => payload.documentId === 'fresh')).toHaveLength(100);
    expect(await qdrant.getDocument('fresh')).toMatchObject({ mixedRevision: true, chunkCount: 100 });
  });
});

describe('legacy points without a revision', () => {
  let state;
  const seedLegacy = (hashFor, count) => {
    for (let i = 0; i < count; i++) {
      state.points.set(`legacy-${i}`, { id: `legacy-${i}`, payload: {
        documentId: 'note', source: 'notes/note.md', text: `legacy-${i}`, chunkIndex: i, hash: hashFor(i)
      } });
    }
  };
  beforeEach(() => { state = fakeQdrant(); });

  test('a uniform legacy document reads as consistent and is replaced on next write', async () => {
    seedLegacy(() => 'old', 3);
    const qdrant = store();
    expect(await qdrant.getDocument('note')).toEqual({
      documentId: 'note', source: 'notes/note.md', tags: undefined, hash: 'old', chunkCount: 3
    });
    await qdrant.upsertDocument('note', { hash: 'new' }, chunks(2, 'new'));
    expect(stored(state).map(payload => payload.text).sort()).toEqual(['new-0', 'new-1']);
  });

  test('a mixed legacy document whose first chunk matches is re-ingested, not skipped', async () => {
    resetRagStore();
    seedLegacy(i => (i < 100 ? 'h-new' : 'h-old'), 150);
    const rag = new RagStore({ type: 'memory' });
    rag.vectorStore = store();
    rag.embeddingsService = { embedBatch: jest.fn(async texts => texts.map(() => [1, 0])) };

    const result = await rag.upsertDocumentWithChunks('A short replacement note.', {
      documentId: 'note', source: 'notes/note.md', hash: 'h-new'
    });

    expect(result.unchanged).not.toBe(true);
    expect(rag.embeddingsService.embedBatch).toHaveBeenCalledTimes(1);
    const payloads = stored(state);
    expect(payloads.every(payload => payload.hash === 'h-new' && payload.revision)).toBe(true);
    expect(new Set(payloads.map(payload => payload.revision)).size).toBe(1);
  });
});
