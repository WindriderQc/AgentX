'use strict';

const { createHash } = require('node:crypto');
// A faithful in-memory RAG boundary: reads expose a revision fingerprint, and
// validity writes refuse a changed document exactly like the RAG service.
function fakeRag(hits = []) {
  const docs = new Map(), calls = [];
  const notFound = () => Object.assign(new Error('RAG returned 404: Document not found'), { status: 404 });
  const fingerprint = doc => createHash('sha256').update(JSON.stringify(doc)).digest('hex');
  const view = doc => ({ documentId: doc.documentId, source: doc.source,
    metadata: { ...doc.metadata, revisionFingerprint: fingerprint(doc) } });
  return { docs, calls,
    seed(documentId, text, metadata, source = 'nestor-memory') {
      docs.set(documentId, { documentId, source, text, metadata: { scope: 'owner', sensitivity: 'private', validFrom: null,
        sourceRefs: [], invalidatedAt: null, supersededBy: null, ...metadata } });
    },
    async getDocument(id) { calls.push(['get', id]); const doc = docs.get(id); if (!doc) throw notFound(); return view(doc); },
    async getDocumentChunks(id) { const doc = docs.get(id); if (!doc) throw notFound(); return { documentId: id, chunks: [{ chunkIndex: 0, text: doc.text }] }; },
    async upsertDocumentWithChunks(text, m) {
      calls.push(['upsert', m.documentId]);
      docs.set(m.documentId, { documentId: m.documentId, source: m.source, text, metadata: { scope: m.scope, sensitivity: m.sensitivity,
        validFrom: m.validFrom || null, sourceRefs: m.sourceRefs || [], invalidatedAt: null, supersededBy: null } });
      return { documentId: m.documentId, status: 'created' };
    },
    async setDocumentValidity(id, { invalidatedAt, supersededBy, expectedFingerprint }) {
      calls.push(['validity', id, supersededBy]);
      const doc = docs.get(id); if (!doc) throw notFound();
      if (fingerprint(doc) !== expectedFingerprint) throw Object.assign(new Error('RAG returned 409: The document changed after review'), { status: 409 });
      doc.metadata = { ...doc.metadata, invalidatedAt, supersededBy };
      return { documentId: id };
    },
    async deleteDocument(id) { calls.push(['delete', id]); if (!docs.delete(id)) throw notFound(); return { documentId: id }; },
    async searchSimilarChunks() { return hits; },
  };
}

const { createRagReplacement, ragReplacementSuccessorFor } = require('../../src/services/memoryReview/ragReplacement');
const key = 'memory-review:synthetic-run:candidate-1';
const refs = [{ system: 'memory-review', id: 'synthetic-run:candidate-1' }];
const now = () => new Date('2026-10-26T12:00:00Z');
let rag, replacement;
beforeEach(() => {
  rag = fakeRag();
  rag.seed('backup-a', 'Synthetic backup runs on host A', { validFrom: '2026-01-05T00:00:00.000Z' });
  replacement = createRagReplacement({ ragClient: rag, now });
});
const input = async (extra = {}) => ({ ref: 'backup-a', expectedFingerprint: (await replacement.source('backup-a')).fingerprint, key,
  text: 'Synthetic backup runs on host B', scope: 'owner', sensitivity: 'private', validFrom: '2026-10-25T00:00:00.000Z', sourceRefs: refs, ...extra });

test('a reviewed replacement writes the successor in the same source, then links the predecessor', async () => {
  const applied = await replacement.supersede(await input());
  const successor = ragReplacementSuccessorFor(key);
  expect(applied).toEqual({ id: successor, predecessorId: 'backup-a', alreadyApplied: false });
  expect(rag.docs.get(successor)).toMatchObject({ source: 'nestor-memory', text: 'Synthetic backup runs on host B',
    metadata: { scope: 'owner', sensitivity: 'private', validFrom: '2026-10-25T00:00:00.000Z', sourceRefs: refs } });
  expect(rag.docs.get('backup-a')).toMatchObject({ text: 'Synthetic backup runs on host A',
    metadata: { invalidatedAt: '2026-10-25T00:00:00.000Z', supersededBy: successor, validFrom: '2026-01-05T00:00:00.000Z' } });
  expect(rag.calls.filter(([op]) => op !== 'get').map(([op]) => op)).toEqual(['upsert', 'validity']);
});

test('a retry after a lost reply resumes without a second link and a replay reports the original outcome', async () => {
  const reviewed = await input();
  const original = rag.setDocumentValidity;
  rag.setDocumentValidity = async () => { throw new Error('lost reply'); };
  await expect(replacement.supersede(reviewed)).rejects.toThrow('lost reply');
  rag.setDocumentValidity = original;
  expect((await replacement.supersede(reviewed)).alreadyApplied).toBe(false);
  expect(await replacement.supersede(reviewed)).toMatchObject({ alreadyApplied: true });
  expect(rag.calls.filter(([op]) => op === 'validity')).toHaveLength(1);
});

test('a changed source, other labels or an impossible validity date refuse before any write', async () => {
  const reviewed = await input();
  rag.docs.get('backup-a').text = 'Synthetic changed after review';
  await expect(replacement.supersede(reviewed)).rejects.toMatchObject({ statusCode: 409 });
  rag.docs.get('backup-a').text = 'Synthetic backup runs on host A';
  await expect(replacement.supersede({ ...reviewed, sensitivity: 'normal' })).rejects.toMatchObject({ statusCode: 409 });
  await expect(replacement.supersede({ ...reviewed, validFrom: '2026-12-01T00:00:00.000Z' })).rejects.toThrow(/known now/);
  await expect(replacement.supersede({ ...reviewed, validFrom: '2025-12-01T00:00:00.000Z' })).rejects.toThrow(/follow the previous fact/);
  expect(rag.calls.some(([op]) => op === 'upsert' || op === 'validity')).toBe(false);
  rag.seed('household-fact', 'Synthetic household fact', { scope: 'household', sensitivity: 'normal' });
  await expect(replacement.source('household-fact')).rejects.toThrow(/owner RAG fact/);
  await expect(replacement.source('missing')).rejects.toThrow(/owner RAG fact/);
});

test('restore clears the predecessor, removes the unchanged successor and resumes a partial restore', async () => {
  await replacement.supersede(await input());
  const successor = ragReplacementSuccessorFor(key);
  const original = rag.deleteDocument;
  rag.deleteDocument = async () => { throw new Error('lost reply'); };
  await expect(replacement.rollback({ ref: 'backup-a', key })).rejects.toThrow('lost reply');
  rag.deleteDocument = original;
  expect(rag.docs.get('backup-a').metadata).toMatchObject({ invalidatedAt: null, supersededBy: null });
  expect(await replacement.rollback({ ref: 'backup-a', key })).toMatchObject({ removedSuccessor: successor, alreadyRolledBack: false });
  expect(rag.docs.has(successor)).toBe(false);
  expect(await replacement.rollback({ ref: 'backup-a', key })).toMatchObject({ alreadyRolledBack: true });
});

test('restore refuses a successor that was itself replaced or a predecessor that changed', async () => {
  await replacement.supersede(await input());
  const successor = ragReplacementSuccessorFor(key);
  rag.docs.get(successor).metadata.supersededBy = 'later';
  rag.docs.get(successor).metadata.invalidatedAt = '2026-10-26T00:00:00.000Z';
  await expect(replacement.rollback({ ref: 'backup-a', key })).rejects.toThrow(/itself replaced/);
  rag.docs.get(successor).metadata = { ...rag.docs.get(successor).metadata, supersededBy: null, invalidatedAt: null };
  rag.docs.get('backup-a').metadata.supersededBy = 'someone-else';
  await expect(replacement.rollback({ ref: 'backup-a', key })).rejects.toThrow(/changed after replacement/);
});

test('the review preview is a live bounded RAG read', async () => {
  expect(await replacement.preview('backup-a')).toEqual({ text: 'Synthetic backup runs on host A', validFrom: '2026-01-05T00:00:00.000Z', invalidatedAt: null });
  expect(await replacement.preview('missing')).toEqual({ unavailable: true });
});
