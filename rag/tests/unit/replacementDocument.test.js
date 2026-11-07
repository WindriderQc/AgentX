'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { RagStore } = require('../../src/services/ragStore');
const { unchangedReplacement } = require('../../src/services/replacementDocument');

const id = 'synthetic-successor';
const input = { key: 'memory-review:synthetic:one', text: 'Synthetic current fact', source: 'nestor-memory',
  scope: 'owner', sensitivity: 'private', validFrom: null, sourceRefs: [{ system: 'memory-review', id: 'synthetic:one' }] };
let store;
beforeEach(() => {
  store = new RagStore({ type: 'memory' });
  store.embeddingsService = { embedBatch: jest.fn(async texts => texts.map(() => [0.1, 0.2])) };
});

test('initial ownership is in the first payload, and survives a lost create reply and service restart', async () => {
  const vector = store.vectorStore;
  const upsert = vector.upsertDocument.bind(vector);
  vector.upsertDocument = async (...args) => {
    expect(args[1].replacementWrite).toMatchObject({ key: input.key, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), revision: expect.any(String) });
    await upsert(...args);
    throw new Error('create ACK lost');
  };
  await expect(store.createReplacementDocument(id, input)).rejects.toThrow('create ACK lost');
  const original = structuredClone(await vector.getDocument(id));
  // A new service object has no in-process receipt/cache.
  store = new RagStore({ vectorStore: vector, embeddingsService: store.embeddingsService });
  expect(await store.createReplacementDocument(id, input)).toMatchObject({ status: 'unchanged' });
  expect(await store.getDocument(id)).toEqual({ ...original, originalText: input.text });
  expect(store.embeddingsService.embedBatch).toHaveBeenCalledTimes(1);
  expect(await vector.getDocumentOriginalText(id)).toBe(input.text);
  expect(unchangedReplacement(original, input.key)).toBe(true);
});

test.each([
  ['content', { text: 'Synthetic independently edited fact' }],
  ['scope', { scope: 'household', sensitivity: 'normal' }],
  ['sensitivity', { scope: 'owner', sensitivity: 'highly_private' }],
  ['source', { source: 'agent-artifacts' }],
  ['provenance', { sourceRefs: [{ system: 'manual', id: 'synthetic-edit' }] }],
  ['fact date', { validFrom: '2026-01-01T00:00:00.000Z' }],
  ['tags', { tags: ['edited'] }],
  ['chunking', { chunkSize: 100 }],
  ['source hash', { hash: 'synthetic-updated-source-hash' }],
  ['format', { format: 'markdown' }],
])('a late cleanup and create retry preserve an edited %s', async (_name, changes) => {
  await store.createReplacementDocument(id, input);
  const original = await store.getDocument(id);
  const { text = input.text, ...metadata } = changes;
  await store.upsertDocumentWithChunks(text, { documentId: id, source: input.source, ...metadata });
  const edited = structuredClone(await store.getDocument(id));
  expect(edited.revision).not.toBe(original.revision);
  expect(edited.replacementWrite).toBeUndefined();
  await expect(store.deleteReplacementDocument(id, { key: input.key })).rejects.toThrow(/reconcile/);
  await expect(store.createReplacementDocument(id, input)).rejects.toThrow(/reconcile/);
  expect(await store.getDocument(id)).toEqual(edited);
});

test('supersession renews the revision and prevents removal', async () => {
  await store.createReplacementDocument(id, input);
  const { revisionFingerprint } = require('../../src/services/documentRevision');
  const original = await store.getDocument(id);
  await store.setDocumentValidity(id, { expectedFingerprint: revisionFingerprint(original), invalidatedAt: '2026-10-01T00:00:00Z', supersededBy: 'later' });
  expect((await store.getDocument(id)).revision).not.toBe(original.revision);
  await expect(store.deleteReplacementDocument(id, { key: input.key })).rejects.toThrow(/reconcile/);
});

test('even a rewrite back to initial text cannot inherit the initial ownership', async () => {
  await store.createReplacementDocument(id, input);
  await store.upsertDocumentWithChunks('Synthetic intervening edit', { documentId: id, source: input.source });
  await store.upsertDocumentWithChunks(input.text, { documentId: id, source: input.source });
  await expect(store.deleteReplacementDocument(id, { key: input.key })).rejects.toThrow(/reconcile/);
});

test('a concurrent edit at the storage delete preserves the new native revision and reports reconciliation', async () => {
  await store.createReplacementDocument(id, input);
  const vector = store.vectorStore;
  const remove = vector.deleteReplacementDocument.bind(vector);
  vector.deleteReplacementDocument = async (...args) => {
    // An external writer bypasses RagStore's lock, after its validation read.
    await vector.upsertDocument(id, { ...await vector.getDocument(id), contentHash: 'synthetic-changed-hash' },
      [{ text: 'Synthetic concurrent edit', chunkIndex: 0, embedding: [0.2, 0.1] }]);
    return remove(...args);
  };
  await expect(store.deleteReplacementDocument(id, { key: input.key })).rejects.toThrow(/changed during removal.*reconcile/);
  expect((await store.getDocumentChunks(id))[0].text).toBe('Synthetic concurrent edit');
});

test('a lost removal ACK resumes by the original identity without touching a recreated document', async () => {
  await store.createReplacementDocument(id, input);
  const vector = store.vectorStore;
  const remove = vector.deleteReplacementDocument.bind(vector);
  vector.deleteReplacementDocument = async (...args) => { await remove(...args); throw new Error('delete ACK lost'); };
  await expect(store.deleteReplacementDocument(id, { key: input.key })).rejects.toThrow('delete ACK lost');
  vector.deleteReplacementDocument = remove;
  expect(await store.deleteReplacementDocument(id, { key: input.key })).toMatchObject({ status: 'absent' });
  await store.upsertDocumentWithChunks('Synthetic recreated document', { documentId: id, source: input.source });
  await expect(store.deleteReplacementDocument(id, { key: input.key })).rejects.toThrow(/proof is missing.*reconcile/);
  expect((await store.getDocumentChunks(id))[0].text).toBe('Synthetic recreated document');
});

test('legacy successors, mismatched identities and mixed revisions fail closed', async () => {
  await store.upsertDocumentWithChunks(input.text, { documentId: id, source: input.source });
  await expect(store.createReplacementDocument(id, input)).rejects.toThrow(/proof is missing/);
  await expect(store.deleteReplacementDocument(id, { key: input.key })).rejects.toThrow(/proof is missing/);
  await store.deleteDocument(id);
  await store.createReplacementDocument(id, input);
  await expect(store.deleteReplacementDocument(id, { key: 'another-key' })).rejects.toThrow(/proof is missing/);
  const doc = store.vectorStore.documents.get(id);
  const originalRevision = doc.revision;
  delete doc.replacementWrite.revision;
  delete doc.revision;
  await expect(store.deleteReplacementDocument(id, { key: input.key })).rejects.toThrow(/proof is missing/);
  doc.revision = originalRevision;
  doc.replacementWrite.revision = originalRevision;
  store.vectorStore.documents.get(id).mixedRevision = true;
  await expect(store.deleteReplacementDocument(id, { key: input.key })).rejects.toThrow(/proof is missing/);
});

test('the owner validates bounded arguments and runs both operations through the existing write guard', async () => {
  await expect(store.createReplacementDocument(id, { ...input, scope: 'household' })).rejects.toMatchObject({ statusCode: 400 });
  await expect(store.createReplacementDocument(id, { ...input, replacementWrite: {} })).rejects.toMatchObject({ statusCode: 400 });
  await expect(store.createReplacementDocument(id, { ...input, text: 'x'.repeat(4001) })).rejects.toMatchObject({ statusCode: 400 });
  await expect(store.deleteReplacementDocument(id, { key: input.key, fingerprint: 'client-supplied' })).rejects.toMatchObject({ statusCode: 400 });
  const run = jest.fn(async (_store, work) => work());
  store.setWriteGuard({ run });
  await store.createReplacementDocument(id, input);
  await store.deleteReplacementDocument(id, { key: input.key });
  expect(run).toHaveBeenCalledTimes(2);
  expect(await store.getDocument(id)).toBeNull();
});

test('normalization keeps an exact retry idempotent without accepting invalid fact metadata', async () => {
  const body = { ...input, validFrom: '2026-01-01T01:00:00+01:00', sourceRefs: [...input.sourceRefs, ...input.sourceRefs] };
  await store.createReplacementDocument(id, body);
  expect(await store.createReplacementDocument(id, body)).toMatchObject({ status: 'unchanged' });
  expect(store.embeddingsService.embedBatch).toHaveBeenCalledTimes(1);
  await expect(store.createReplacementDocument(id, { ...body, validFrom: 'invalid' })).rejects.toMatchObject({ statusCode: 400 });
});
