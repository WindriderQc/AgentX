const {
  migrateEmbeddingCollection,
  buildUpsertMetadata,
  parseArgs,
  UsageError
} = require('../../scripts/migrate-embedding-collection');
const { generateDocumentId } = require('../../src/services/ragStoreUtils');

function sourceStoreWith(payloads, { payloadSchema = {} } = {}) {
  const scrollCalls = [];
  return {
    scrollCalls,
    getCollectionInfo: jest.fn(async () => ({ vectorSize: 768, pointsCount: payloads.length, payloadSchema })),
    async *_scrollPages(args) {
      scrollCalls.push(args);
      const size = args.pageSize;
      for (let i = 0; i < payloads.length; i += size) {
        yield payloads.slice(i, i + size).map((payload, j) => ({ id: `p-${i + j}`, payload }));
      }
    }
  };
}

function targetStoreWith({ exists = false, vectorSize = 1024, points = [], payloadSchema = {} } = {}) {
  const state = { exists, vectorSize, payloadSchema: { ...payloadSchema } };
  return {
    state,
    getCollectionInfo: jest.fn(async () => (state.exists
      ? { vectorSize: state.vectorSize, pointsCount: 0, payloadSchema: state.payloadSchema }
      : null)),
    createPayloadIndex: jest.fn(async (field, schema) => { state.payloadSchema[field] = { data_type: schema }; }),
    async *_scrollPages() {
      yield points.map((payload, i) => ({ id: `t-${i}`, payload }));
    }
  };
}

function ragStoreFor(targetStore) {
  return {
    upsertDocumentWithChunks: jest.fn(async () => {
      targetStore.state.exists = true;
      return { status: 'created' };
    })
  };
}

const labelDoc = (source, text, extra = {}) => ({
  documentId: generateDocumentId(source, text),
  source,
  originalText: text,
  sourceIdentityKind: 'source_label',
  tags: ['a'],
  contentHash: `c-${text}`,
  ...extra
});

const baseOptions = { source: 'old_collection', target: 'new_collection' };

function deps(sourceStore, targetStore, targetRagStore = ragStoreFor(targetStore)) {
  return { sourceStore, targetStore, targetRagStore, embeddingModel: 'qllama/bge-m3:f16', embeddingDimension: 1024 };
}

describe('migrate-embedding-collection', () => {
  test('refuses a target equal to the source before reading anything', async () => {
    const source = sourceStoreWith([]);
    await expect(migrateEmbeddingCollection({ source: 'same', target: 'same' }, deps(source, targetStoreWith())))
      .rejects.toBeInstanceOf(UsageError);
    expect(source.getCollectionInfo).not.toHaveBeenCalled();
  });

  test('parses flags and requires source and target', () => {
    expect(parseArgs(['--source', 'a', '--target', 'b', '--dry-run', '--delta', '--limit', '5', '--page-size', '99']))
      .toEqual({ source: 'a', target: 'b', dryRun: true, delta: true, limit: 5, pageSize: 16 });
    expect(() => parseArgs(['--source', 'a'])).toThrow(UsageError);
    expect(() => parseArgs(['--source', 'a', '--target', 'b', '--limit', '0'])).toThrow(UsageError);
  });

  test('dry run counts documents, missing original text and sources without writing', async () => {
    const source = sourceStoreWith([
      labelDoc('docs', 'one'),
      labelDoc('docs', 'two'),
      { documentId: 'legacy', source: 'notes', chunkSize: 500 }
    ]);
    const target = targetStoreWith();
    const ragStore = ragStoreFor(target);
    const summary = await migrateEmbeddingCollection({ ...baseOptions, dryRun: true }, deps(source, target, ragStore));

    expect(summary).toMatchObject({
      documents: 3, missingOriginalText: 1, wouldMigrate: 2, migrated: 0,
      sources: { docs: 2, notes: 1 },
      skipped: [{ documentId: 'legacy', reason: 'missing originalText' }]
    });
    expect(ragStore.upsertDocumentWithChunks).not.toHaveBeenCalled();
    expect(target.createPayloadIndex).not.toHaveBeenCalled();
    // chunk-0 payloads only, small pages, no vectors requested
    expect(source.scrollCalls[0]).toMatchObject({
      filter: { must: [{ key: 'chunkIndex', match: { value: 0 } }] },
      pageSize: 4
    });
    expect(source.scrollCalls[0].withPayload.include).toEqual(expect.arrayContaining(['originalText', 'format', 'hash']));
  });

  test('upserts with preserved metadata and passes documentId only for non-label identities', async () => {
    const markdown = { documentId: 'maison/four.md', source: 'maison', originalText: '# Four', sourceIdentityKind: 'document_id',
      tags: ['maison'], scope: 'household', sensitivity: 'normal', format: 'markdown', chunkSize: 800, chunkOverlap: 80,
      hash: 'file-hash', title: 'Four' };
    const label = labelDoc('api', 'plain text');
    const source = sourceStoreWith([markdown, label]);
    const target = targetStoreWith();
    const ragStore = ragStoreFor(target);
    const summary = await migrateEmbeddingCollection(baseOptions, deps(source, target, ragStore));

    expect(summary.migrated).toBe(2);
    expect(summary.failed).toEqual([]);
    expect(ragStore.upsertDocumentWithChunks).toHaveBeenNthCalledWith(1, '# Four', {
      documentId: 'maison/four.md', source: 'maison', tags: ['maison'], scope: 'household', sensitivity: 'normal',
      format: 'markdown', chunkSize: 800, chunkOverlap: 80, hash: 'file-hash', forceReindex: true
    });
    expect(ragStore.upsertDocumentWithChunks).toHaveBeenNthCalledWith(2, 'plain text', {
      source: 'api', tags: ['a'], forceReindex: true
    });
  });

  test('legacy rows without an identity kind keep their document id', () => {
    const { metadata } = buildUpsertMetadata({ documentId: 'custom-id', source: 's', originalText: 't' });
    expect(metadata.documentId).toBe('custom-id');
  });

  test('never drops half a classification or changes an automatic id', async () => {
    const source = sourceStoreWith([
      { documentId: 'half', source: 's', originalText: 'x', sourceIdentityKind: 'document_id', scope: 'household' },
      { documentId: 'renamed', source: 's', originalText: 'y', sourceIdentityKind: 'source_label' }
    ]);
    const target = targetStoreWith();
    const ragStore = ragStoreFor(target);
    const summary = await migrateEmbeddingCollection(baseOptions, deps(source, target, ragStore));

    expect(ragStore.upsertDocumentWithChunks).not.toHaveBeenCalled();
    expect(summary.failed).toEqual([
      { documentId: 'half', reason: 'incomplete scope/sensitivity labels' },
      { documentId: 'renamed', reason: 'automatic document id does not match its source and text' }
    ]);
  });

  test('delta skips documents already in the target with the same hashes', async () => {
    const same = labelDoc('docs', 'same', { hash: 'h1' });
    const changed = labelDoc('docs', 'changed');
    const fresh = labelDoc('docs', 'fresh');
    const source = sourceStoreWith([same, changed, fresh]);
    const target = targetStoreWith({
      exists: true,
      points: [
        { documentId: same.documentId, contentHash: same.contentHash, hash: 'h1' },
        { documentId: changed.documentId, contentHash: 'older' }
      ]
    });
    const ragStore = ragStoreFor(target);
    const summary = await migrateEmbeddingCollection({ ...baseOptions, delta: true }, deps(source, target, ragStore));

    expect(summary.migrated).toBe(2);
    expect(summary.skipped).toEqual([{ documentId: same.documentId, reason: 'already in target with the same hash' }]);
    expect(ragStore.upsertDocumentWithChunks.mock.calls.map(([text]) => text)).toEqual(['changed', 'fresh']);
  });

  test('limit bounds the documents read from the source', async () => {
    const source = sourceStoreWith([labelDoc('d', '1'), labelDoc('d', '2'), labelDoc('d', '3')]);
    const target = targetStoreWith();
    const summary = await migrateEmbeddingCollection({ ...baseOptions, limit: 2, pageSize: 1 }, deps(source, target));
    expect(summary.documents).toBe(2);
    expect(summary.migrated).toBe(2);
  });

  test('stops when the written target vector size differs from EMBEDDING_DIMENSION', async () => {
    const source = sourceStoreWith([labelDoc('d', '1'), labelDoc('d', '2')]);
    const target = targetStoreWith({ vectorSize: 768 });
    const ragStore = ragStoreFor(target);
    const run = migrateEmbeddingCollection(baseOptions, deps(source, target, ragStore));
    await expect(run).rejects.toThrow(/vector size 768, EMBEDDING_DIMENSION is 1024/);
    await run.catch((err) => expect(err.summary.migrated).toBe(1));
    expect(ragStore.upsertDocumentWithChunks).toHaveBeenCalledTimes(1);
  });

  test('refuses an existing target with another vector size before writing', async () => {
    const source = sourceStoreWith([labelDoc('d', '1')]);
    const target = targetStoreWith({ exists: true, vectorSize: 768 });
    const ragStore = ragStoreFor(target);
    await expect(migrateEmbeddingCollection(baseOptions, deps(source, target, ragStore))).rejects.toThrow(/vector size 768/);
    expect(ragStore.upsertDocumentWithChunks).not.toHaveBeenCalled();
  });

  test('copies source payload indexes missing on the target after the first upsert', async () => {
    const source = sourceStoreWith([labelDoc('d', '1')], {
      payloadSchema: {
        documentId: { data_type: 'keyword', points: 10 },
        text: { data_type: 'text', params: { type: 'text', tokenizer: 'word' }, points: 10 },
        source: { data_type: 'keyword', points: 10 }
      }
    });
    const target = targetStoreWith({ payloadSchema: { source: { data_type: 'keyword' } } });
    const summary = await migrateEmbeddingCollection(baseOptions, deps(source, target));

    expect(target.createPayloadIndex.mock.calls).toEqual([
      ['documentId', 'keyword'],
      ['text', { type: 'text', tokenizer: 'word' }]
    ]);
    expect(summary.payloadIndexesCopied).toEqual(['documentId', 'text']);
  });

  test('reports a failed upsert and continues', async () => {
    const source = sourceStoreWith([labelDoc('d', '1'), labelDoc('d', '2')]);
    const target = targetStoreWith();
    const ragStore = ragStoreFor(target);
    ragStore.upsertDocumentWithChunks.mockRejectedValueOnce(new Error('embedding service unavailable'));
    const summary = await migrateEmbeddingCollection(baseOptions, deps(source, target, ragStore));
    expect(summary.migrated).toBe(1);
    expect(summary.failed).toEqual([{ documentId: generateDocumentId('d', '1'), reason: 'embedding service unavailable' }]);
  });
});
