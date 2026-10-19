const { migrateEmbeddingCollection, CancelledError, UsageError } = require('../../src/services/embeddingCollectionMigration');

const doc = (documentId, text) => ({ documentId, originalText: text, source: 'docs', sourceIdentityKind: 'document_id', contentHash: `c-${text}` });

function stores(sourcePayloads, targetPayloads) {
  const deleted = [];
  const upserts = [];
  const page = (payloads) => async function* scroll() { yield payloads.map((payload, i) => ({ id: i, payload })); };
  return {
    deleted,
    upserts,
    deps: {
      sourceStore: { getCollectionInfo: async () => ({ vectorSize: 4, payloadSchema: {} }), _scrollPages: page(sourcePayloads) },
      targetStore: {
        getCollectionInfo: async () => ({ vectorSize: 8, payloadSchema: {} }),
        createPayloadIndex: async () => {},
        deleteDocument: async (id) => { deleted.push(id); },
        _scrollPages: page(targetPayloads)
      },
      targetRagStore: { upsertDocumentWithChunks: async (text, meta) => { upserts.push(meta.documentId); } },
      embeddingModel: 'model-b',
      embeddingDimension: 8
    }
  };
}

describe('embedding collection migration hooks', () => {
  test('a pruning delta pass copies changes and removes documents deleted from the source', async () => {
    const { deps, deleted, upserts } = stores(
      [doc('kept', 'same'), doc('changed', 'new text')],
      [doc('kept', 'same'), doc('changed', 'old text'), doc('gone', 'removed')]
    );
    const progress = [];
    const summary = await migrateEmbeddingCollection({ source: 'a', target: 'b', delta: true, prune: true },
      { ...deps, onProgress: (s) => progress.push(s.documents) });
    expect(upserts).toEqual(['changed']);
    expect(deleted).toEqual(['gone']);
    expect(summary).toMatchObject({ documents: 2, migrated: 1, pruned: 1 });
    expect(progress.at(-1)).toBe(2);
  });

  test('stops between documents when asked and reports what it did', async () => {
    const { deps, upserts } = stores([doc('one', 'a'), doc('two', 'b')], []);
    let calls = 0;
    const err = await migrateEmbeddingCollection({ source: 'a', target: 'b' }, { ...deps, shouldStop: () => calls++ >= 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(CancelledError);
    expect(upserts).toEqual(['one']);
    expect(err.summary.migrated).toBe(1);
  });

  test('prune needs a complete delta pass', async () => {
    const { deps } = stores([], []);
    await expect(migrateEmbeddingCollection({ source: 'a', target: 'b', prune: true }, deps)).rejects.toBeInstanceOf(UsageError);
    await expect(migrateEmbeddingCollection({ source: 'a', target: 'b', delta: true, prune: true, limit: 1 }, deps)).rejects.toBeInstanceOf(UsageError);
  });
});
