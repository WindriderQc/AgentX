'use strict';

const { fakeRag } = require('../helpers/fakeReplacementRag');

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
  const original = rag.deleteReplacementDocument;
  rag.deleteReplacementDocument = async () => { throw new Error('lost reply'); };
  await expect(replacement.rollback({ ref: 'backup-a', key })).rejects.toThrow('lost reply');
  rag.deleteReplacementDocument = original;
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

// Two reviewed replacements of the same predecessor, applied at once: the
// predecessor's conditional link lets one win; the other must not leave its
// successor behind as a second current fact.
const otherKey = 'memory-review:synthetic-run:candidate-2';
async function raceSecondAgainstFirst() {
  const first = await input();
  const second = await input({ key: otherKey, text: 'Synthetic backup runs on host C' });
  const upsert = rag.upsertDocumentWithChunks;
  rag.upsertDocumentWithChunks = async (text, m) => {
    const written = await upsert(text, m);
    if (m.documentId === ragReplacementSuccessorFor(otherKey)) {
      rag.upsertDocumentWithChunks = upsert;
      await replacement.supersede(first);
    }
    return written;
  };
  return second;
}

test('a concurrent replacement that loses the link leaves no current successor behind', async () => {
  const second = await raceSecondAgainstFirst();
  await expect(replacement.supersede(second)).rejects.toMatchObject({ statusCode: 409 });
  expect(rag.docs.get('backup-a').metadata.supersededBy).toBe(ragReplacementSuccessorFor(key));
  expect(rag.docs.has(ragReplacementSuccessorFor(key))).toBe(true);
  expect(rag.docs.has(ragReplacementSuccessorFor(otherKey))).toBe(false);
});

test('a retry removes an unlinked successor whose cleanup was interrupted', async () => {
  const second = await raceSecondAgainstFirst();
  const remove = rag.deleteReplacementDocument;
  rag.deleteReplacementDocument = async () => { throw new Error('lost reply'); };
  await expect(replacement.supersede(second)).rejects.toThrow('lost reply');
  rag.deleteReplacementDocument = remove;
  expect(rag.docs.has(ragReplacementSuccessorFor(otherKey))).toBe(true);
  await expect(replacement.supersede(second)).rejects.toMatchObject({ statusCode: 409 });
  expect(rag.docs.has(ragReplacementSuccessorFor(otherKey))).toBe(false);
  expect(rag.docs.has(ragReplacementSuccessorFor(key))).toBe(true);
});

test('a lost reply after the link committed reports the replacement as applied', async () => {
  const reviewed = await input();
  const link = rag.setDocumentValidity;
  rag.setDocumentValidity = async (...args) => { await link(...args); throw new Error('lost reply'); };
  expect(await replacement.supersede(reviewed)).toMatchObject({ id: ragReplacementSuccessorFor(key), alreadyApplied: false });
  expect(rag.docs.get('backup-a').metadata.supersededBy).toBe(ragReplacementSuccessorFor(key));
});

test('a predecessor deleted before linking leaves no successor behind', async () => {
  const reviewed = await input();
  const upsert = rag.upsertDocumentWithChunks;
  rag.upsertDocumentWithChunks = async (text, m) => { const written = await upsert(text, m); rag.docs.delete('backup-a'); return written; };
  await expect(replacement.supersede(reviewed)).rejects.toMatchObject({ statusCode: 409 });
  expect(rag.docs.has(ragReplacementSuccessorFor(key))).toBe(false);
});

test('an unlinked successor that was itself replaced is never deleted silently', async () => {
  const second = await raceSecondAgainstFirst();
  const remove = rag.deleteReplacementDocument;
  rag.deleteReplacementDocument = async () => { throw new Error('lost reply'); };
  await expect(replacement.supersede(second)).rejects.toThrow('lost reply');
  rag.deleteReplacementDocument = remove;
  rag.docs.get(ragReplacementSuccessorFor(otherKey)).metadata.supersededBy = 'later';
  await expect(replacement.supersede(second)).rejects.toThrow(/itself replaced/);
  expect(rag.docs.has(ragReplacementSuccessorFor(otherKey))).toBe(true);
});

test('an undated replacement keeps its validity unknown while the predecessor records the apply instant', async () => {
  const applied = await replacement.supersede(await input({ validFrom: null }));
  expect(rag.docs.get(applied.id).metadata.validFrom).toBeNull();
  expect(rag.docs.get('backup-a').metadata).toMatchObject({ invalidatedAt: now().toISOString(), supersededBy: applied.id,
    validFrom: '2026-01-05T00:00:00.000Z' });
});

test('a late cleanup retry preserves an orphan edited after the first cleanup failed', async () => {
  const second = await raceSecondAgainstFirst();
  const remove = rag.deleteReplacementDocument;
  rag.deleteReplacementDocument = async () => { throw new Error('cleanup unavailable'); };
  await expect(replacement.supersede(second)).rejects.toThrow('cleanup unavailable');
  rag.deleteReplacementDocument = remove;
  const orphanId = ragReplacementSuccessorFor(otherKey);
  rag.docs.get(orphanId).text = 'Synthetic independently edited successor';
  await expect(replacement.supersede(second)).rejects.toThrow(/reconcile/);
  expect(rag.docs.get(orphanId).text).toBe('Synthetic independently edited successor');
});

test('a lost create ACK resumes without writing again, and an intervening edit refuses a retry', async () => {
  const reviewed = await input();
  const create = rag.createReplacementDocument.bind(rag);
  rag.createReplacementDocument = async (...args) => { await create(...args); throw new Error('create ACK lost'); };
  await expect(replacement.supersede(reviewed)).rejects.toThrow('create ACK lost');
  const successor = ragReplacementSuccessorFor(key);
  rag.docs.get(successor).text = 'Synthetic intervening edit';
  rag.createReplacementDocument = create;
  await expect(replacement.supersede(reviewed)).rejects.toThrow(/reconcile/);
  expect(rag.docs.get(successor).text).toBe('Synthetic intervening edit');
  expect(rag.docs.get('backup-a').metadata.supersededBy).toBeNull();
  expect(rag.calls.filter(([op]) => op === 'upsert')).toHaveLength(1);
});

test('a lost create ACK without an edit resumes the same successor without a rewrite', async () => {
  const reviewed = await input();
  const create = rag.createReplacementDocument.bind(rag);
  rag.createReplacementDocument = async (...args) => { await create(...args); throw new Error('create ACK lost'); };
  await expect(replacement.supersede(reviewed)).rejects.toThrow('create ACK lost');
  rag.createReplacementDocument = create;
  expect(await replacement.supersede(reviewed)).toMatchObject({ id: ragReplacementSuccessorFor(key) });
  expect(rag.calls.filter(([op]) => op === 'upsert')).toHaveLength(1);
});

test('restore preserves an edited successor before changing the predecessor', async () => {
  await replacement.supersede(await input());
  const successor = ragReplacementSuccessorFor(key);
  rag.docs.get(successor).text = 'Synthetic independent edit';
  await expect(replacement.rollback({ ref: 'backup-a', key })).rejects.toThrow(/reconcile/);
  expect(rag.docs.get('backup-a').metadata.supersededBy).toBe(successor);
  expect(rag.docs.get(successor).text).toBe('Synthetic independent edit');
});

test('a late restore retry preserves an edit after predecessor restoration and interrupted cleanup', async () => {
  await replacement.supersede(await input());
  const remove = rag.deleteReplacementDocument.bind(rag);
  rag.deleteReplacementDocument = async () => { throw new Error('cleanup unavailable'); };
  await expect(replacement.rollback({ ref: 'backup-a', key })).rejects.toThrow('cleanup unavailable');
  const successor = ragReplacementSuccessorFor(key);
  rag.docs.get(successor).text = 'Synthetic late independent edit';
  rag.deleteReplacementDocument = remove;
  await expect(replacement.rollback({ ref: 'backup-a', key })).rejects.toThrow(/reconcile/);
  expect(rag.docs.get('backup-a').metadata.supersededBy).toBeNull();
  expect(rag.docs.get(successor).text).toBe('Synthetic late independent edit');
});

test.each(['cleanup', 'restore'])('an edit at conditional %s deletion is preserved and reported', async action => {
  const second = action === 'cleanup' ? await raceSecondAgainstFirst() : null;
  if (action === 'restore') await replacement.supersede(await input());
  const successor = ragReplacementSuccessorFor(action === 'cleanup' ? otherKey : key);
  const remove = rag.deleteReplacementDocument.bind(rag);
  rag.deleteReplacementDocument = async (...args) => {
    rag.docs.get(successor).text = 'Synthetic concurrent edit at removal';
    return remove(...args);
  };
  const result = action === 'cleanup' ? replacement.supersede(second) : replacement.rollback({ ref: 'backup-a', key });
  await expect(result).rejects.toThrow(/reconcile/);
  expect(rag.docs.get(successor).text).toBe('Synthetic concurrent edit at removal');
});

test('a lost delete ACK resumes rollback after the original successor is already absent', async () => {
  await replacement.supersede(await input());
  const remove = rag.deleteReplacementDocument.bind(rag);
  rag.deleteReplacementDocument = async (...args) => { await remove(...args); throw new Error('delete ACK lost'); };
  await expect(replacement.rollback({ ref: 'backup-a', key })).rejects.toThrow('delete ACK lost');
  rag.deleteReplacementDocument = remove;
  expect(await replacement.rollback({ ref: 'backup-a', key })).toMatchObject({ alreadyRolledBack: true });
});

test('a lost restoration ACK resumes without clearing predecessor validity twice', async () => {
  await replacement.supersede(await input());
  const restore = rag.setDocumentValidity.bind(rag);
  rag.setDocumentValidity = async (...args) => { await restore(...args); throw new Error('restore ACK lost'); };
  await expect(replacement.rollback({ ref: 'backup-a', key })).rejects.toThrow('restore ACK lost');
  rag.setDocumentValidity = restore;
  expect(await replacement.rollback({ ref: 'backup-a', key })).toMatchObject({ restored: 'backup-a' });
  expect(rag.calls.filter(([op, , successor]) => op === 'validity' && successor === null)).toHaveLength(1);
});

test.each(['cleanup', 'restore'])('a legacy successor without initial proof refuses %s', async action => {
  const second = action === 'cleanup' ? await raceSecondAgainstFirst() : null;
  if (action === 'restore') await replacement.supersede(await input());
  const successor = ragReplacementSuccessorFor(action === 'cleanup' ? otherKey : key);
  if (action === 'cleanup') {
    const remove = rag.deleteReplacementDocument;
    rag.deleteReplacementDocument = async () => { throw new Error('cleanup unavailable'); };
    await expect(replacement.supersede(second)).rejects.toThrow('cleanup unavailable');
    rag.deleteReplacementDocument = remove;
  }
  delete rag.docs.get(successor).replacementWrite;
  const result = action === 'cleanup' ? replacement.supersede(second) : replacement.rollback({ ref: 'backup-a', key });
  await expect(result).rejects.toThrow(/reconcile/);
  expect(rag.docs.has(successor)).toBe(true);
});
