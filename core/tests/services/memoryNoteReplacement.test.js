'use strict';

const MemoryNote = require('../../models/MemoryNote');
const { forSpace } = require('../../src/services/memoryNoteService');
const noIndex = { indexNote: async () => {}, nearest: async () => ({ results: [{ hits: [] }], indexed: 0, unindexed: 0 }) };
const owner = forSpace({ audience: 'owner', scopeId: 'personal', packIds: ['personal_operator'], index: noIndex });
const family = forSpace({ audience: 'household', scopeId: 'family', packIds: ['kidx_nestor'], index: noIndex });
const other = forSpace({ audience: 'owner', scopeId: 'other', packIds: ['personal_operator'], index: noIndex });
let old, input;

beforeAll(async () => { await MemoryNote.createCollection(); await MemoryNote.createIndexes(); });
beforeEach(async () => {
  await MemoryNote.deleteMany({});
  old = await owner.remember({ text: 'Synthetic backup uses host A', validFrom: '2025-01-01T00:00:00Z' });
  const source = await owner.replacementSource(old.id);
  input = { id: old.id, expectedFingerprint: source.fingerprint, key: 'synthetic:review:one',
    text: 'Synthetic backup uses host B', scope: 'owner', sensitivity: 'private',
    validFrom: '2026-01-01T00:00:00Z', sourceRefs: [{ system: 'memory-review', id: 'synthetic-run:candidate' }] };
});

test('replacement keeps dated history and the first recording time separate from validity', async () => {
  const start = Date.now();
  const result = await owner.supersede(input);
  const current = (await owner.list()).notes;
  expect(current.map(note => note.id)).toEqual([result.id]);
  expect(current[0]).toMatchObject({ text: input.text, sourceRefs: input.sourceRefs });
  expect(Number(new Date(current[0].recordedAt))).toBeGreaterThanOrEqual(start);
  expect(new Date(current[0].validFrom).toISOString()).toBe(input.validFrom.replace('Z', '.000Z'));
  const prior = (await owner.list({ includeHistory: true })).notes.find(note => note.id === old.id);
  expect(prior).toMatchObject({ text: old.text, supersededBy: result.id });
  expect(prior.recordedAt).toEqual(old.recordedAt);
  expect(prior.invalidatedAt).toEqual(new Date(input.validFrom));
  expect((await family.search('backup')).notes).toEqual([]);
});

test('same-key retries preserve both identities and recording time; altered content refuses', async () => {
  const first = await owner.supersede(input);
  const stored = await MemoryNote.findById(first.id).lean();
  expect(await owner.supersede(input)).toMatchObject({ id: first.id, alreadyApplied: true });
  expect((await MemoryNote.findById(first.id).lean()).createdAt).toEqual(stored.createdAt);
  expect(await MemoryNote.countDocuments()).toBe(2);
  await expect(owner.supersede({ ...input, text: 'Synthetic changed retry' })).rejects.toMatchObject({ statusCode: 409 });
});

test('a changed source, wrong space, household access or relabelled replacement refuses before creating a successor', async () => {
  await expect(other.supersede(input)).rejects.toMatchObject({ statusCode: 409 });
  await expect(family.supersede(input)).rejects.toMatchObject({ statusCode: 403 });
  await expect(owner.supersede({ ...input, sensitivity: 'normal' })).rejects.toMatchObject({ statusCode: 409 });
  await owner.remember({ id: old.id, text: 'Synthetic corrected backup source' });
  await expect(owner.supersede(input)).rejects.toMatchObject({ statusCode: 409 });
  expect(await MemoryNote.countDocuments()).toBe(1);
});

test('competing replacements cannot both reserve the same reviewed source', async () => {
  const outcomes = await Promise.allSettled([owner.supersede(input),
    owner.supersede({ ...input, key: 'synthetic:review:other', text: 'Synthetic backup uses host C' })]);
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect((await owner.list()).total).toBe(1);
  expect(await MemoryNote.countDocuments()).toBe(2);
});

test('concurrent delivery of the same operation converges on one successor', async () => {
  const results = await Promise.allSettled([owner.supersede(input), owner.supersede(input)]);
  expect(results.some(item => item.status === 'fulfilled')).toBe(true);
  const replay = await owner.supersede(input);
  expect((await owner.list()).notes.map(note => note.id)).toEqual([replay.id]);
  expect(await MemoryNote.countDocuments()).toBe(2);
});

test.each(['preparing', 'linked', 'active'])('an interrupted %s stage resumes the original operation without duplicating or exposing a staged note', async phase => {
  const original = MemoryNote.findOneAndUpdate;
  let interrupted = false;
  const spy = jest.spyOn(MemoryNote, 'findOneAndUpdate').mockImplementation(function (filter, update, options) {
    const match = phase === 'preparing' ? update.$setOnInsert?.replacementKey
      : phase === 'linked' ? update.$set?.['replacement.phase'] === 'linked'
        : update.$set?.status === 'active';
    if (!interrupted && match) {
      interrupted = true;
      // Commit the write, then lose its reply. The next call must reconcile.
      const query = original.call(this, filter, update, options);
      return { lean: async () => { await query.lean(); throw new Error('Synthetic lost response'); } };
    }
    return original.call(this, filter, update, options);
  });
  try { await expect(owner.supersede(input)).rejects.toThrow('Synthetic lost response'); }
  finally { spy.mockRestore(); }
  expect(interrupted).toBe(true);
  expect((await owner.list()).total).toBeLessThanOrEqual(1);
  const result = await owner.supersede(input);
  expect((await owner.list()).notes.map(note => note.id)).toEqual([result.id]);
  expect(await MemoryNote.countDocuments()).toBe(2);
});

test('rollback restores the predecessor, forgets the successor, and replays without reapplying it', async () => {
  const result = await owner.supersede(input);
  expect(await owner.rollbackSupersession({ id: old.id, key: input.key })).toMatchObject({ id: old.id, forgottenSuccessorId: result.id });
  expect((await owner.list()).notes.map(note => note.id)).toEqual([old.id]);
  expect((await MemoryNote.findById(result.id).lean()).status).toBe('forgotten');
  expect(await owner.rollbackSupersession({ id: old.id, key: input.key })).toMatchObject({ alreadyRolledBack: true });
  await expect(owner.supersede(input)).rejects.toMatchObject({ statusCode: 409 });
});

test('rollback refuses if the successor changed or was itself replaced', async () => {
  const result = await owner.supersede(input);
  await owner.remember({ id: result.id, text: 'Synthetic independently corrected backup' });
  await expect(owner.rollbackSupersession({ id: old.id, key: input.key })).rejects.toMatchObject({ statusCode: 409 });
  expect((await owner.list()).notes.map(note => note.id)).toEqual([result.id]);
});

test('a later replacement protects the chain from an older rollback', async () => {
  const second = await owner.supersede(input);
  const source = await owner.replacementSource(second.id);
  const child = { ...input, id: second.id, expectedFingerprint: source.fingerprint,
    key: 'synthetic:review:child', text: 'Synthetic backup uses host C', validFrom: '2026-02-01T00:00:00Z' };
  const third = await owner.supersede(child);
  await expect(owner.rollbackSupersession({ id: old.id, key: input.key })).rejects.toMatchObject({ statusCode: 409 });
  expect((await owner.list()).notes.map(note => note.id)).toEqual([third.id]);
  expect((await owner.list({ includeHistory: true })).notes).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: old.id, supersededBy: second.id }),
    expect.objectContaining({ id: second.id, supersededBy: third.id })]));
});

test('a source forgotten after reservation cancels its staged successor without reviving either fact', async () => {
  const original = MemoryNote.findOneAndUpdate;
  const spy = jest.spyOn(MemoryNote, 'findOneAndUpdate').mockImplementation(function (filter, update, options) {
    const query = original.call(this, filter, update, options);
    if (update.$setOnInsert?.replacementKey) return { lean: async () => {
      const next = await query.lean();
      await owner.forget(old.id);
      return next;
    } };
    return query;
  });
  try { await expect(owner.supersede(input)).rejects.toMatchObject({ statusCode: 409 }); }
  finally { spy.mockRestore(); }
  expect((await owner.list()).notes).toEqual([]);
  expect(await MemoryNote.countDocuments({ status: 'pending' })).toBe(0);
});

test('rollback resumes after restoration committed but its reply was lost', async () => {
  await owner.supersede(input);
  const original = MemoryNote.findOneAndUpdate;
  const spy = jest.spyOn(MemoryNote, 'findOneAndUpdate').mockImplementation(function (filter, update, options) {
    const query = original.call(this, filter, update, options);
    if (update.$set?.['replacement.phase'] === 'undoing') {
      return { lean: async () => { await query.lean(); throw new Error('Synthetic lost rollback response'); } };
    }
    return query;
  });
  try { await expect(owner.rollbackSupersession({ id: old.id, key: input.key })).rejects.toThrow('Synthetic lost rollback response'); }
  finally { spy.mockRestore(); }
  expect((await owner.list()).notes.map(note => note.id)).toEqual([old.id]);
  await owner.rollbackSupersession({ id: old.id, key: input.key });
  expect((await owner.list()).notes.map(note => note.id)).toEqual([old.id]);
});

test('a forgotten predecessor cannot be revived by replacement or rollback', async () => {
  await owner.forget(old.id);
  await expect(owner.supersede(input)).rejects.toMatchObject({ statusCode: 409 });
  expect((await owner.list({ includeHistory: true })).notes).toEqual([]);
});
