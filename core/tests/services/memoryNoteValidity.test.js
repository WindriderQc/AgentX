'use strict';

// Both explicit recall and the native context path use this CPU-only index.
jest.mock('../../src/services/memoryNoteIndex', () => {
  const actual = jest.requireActual('../../src/services/memoryNoteIndex');
  return { ...actual, createIndex: () => actual.createIndex({
    embed: async () => [1, 0], model: () => 'synthetic-validity-index',
  }) };
});

const MemoryNote = require('../../models/MemoryNote');
const { Types } = require('mongoose');
const { forSpace, personal, operatePersonal } = require('../../src/services/memoryNoteService');
const { createIndex } = require('../../src/services/memoryNoteIndex');
const owner = personal();
const family = forSpace({ audience: 'household', scopeId: 'family', packIds: ['kidx_nestor'] });
const past = new Date('2025-01-01T00:00:00Z');
const future = new Date('2099-01-01T00:00:00Z');

beforeEach(() => MemoryNote.deleteMany({}));

async function replacedPair() {
  const old = await owner.remember({ text: 'Synthetic backup runs on host A', kind: 'preference' });
  const current = await owner.remember({ text: 'Synthetic backup runs on host B' });
  // An existing canonical record can carry replacement metadata independently
  // of the reviewed write workflow. Do not launch a synthesis or embedding host.
  await MemoryNote.collection.updateOne({ _id: new Types.ObjectId(old.id) }, {
    $set: { invalidatedAt: past, supersededBy: current.id },
  });
  for (const note of [old, current]) await createIndex().indexNote(note.id, note.text);
  return { old, current };
}

test('current list, count, keyword and semantic recall exclude a replaced fact, including native preferences', async () => {
  const { current } = await replacedPair();
  expect((await owner.list()).notes.map(note => note.id)).toEqual([current.id]);
  expect(await owner.count()).toBe(1);
  expect((await owner.search('backup')).notes.map(note => note.id)).toEqual([current.id]);
  expect((await owner.similar(['backup'])).results[0].notes.map(note => note.id)).toEqual([current.id]);
  expect((await operatePersonal({ operation: 'context', query: 'backup' })).notes.map(note => note.id)).toEqual([current.id]);
});

test('an explicit owner history read retains the dated predecessor and successor reference', async () => {
  const { old, current } = await replacedPair();
  const history = await owner.list({ includeHistory: true });
  expect(history.total).toBe(2);
  expect(history.notes.find(note => note.id === old.id)).toMatchObject({
    text: old.text, invalidatedAt: past, supersededBy: current.id,
  });
  expect(history.notes.find(note => note.id === current.id)).toMatchObject({ invalidatedAt: null, supersededBy: null });
  expect((await operatePersonal({ operation: 'list', includeHistory: true })).total).toBe(2);
});

test('history remains inside the owner space and does not expose forgotten or expired notes', async () => {
  const { old, current } = await replacedPair();
  await family.record({ text: 'Synthetic family backup' });
  await forSpace({ audience: 'owner', scopeId: 'another-owner', packIds: ['personal_operator'] })
    .record({ text: 'Synthetic other owner backup' });
  await MemoryNote.updateOne({ _id: current.id }, { $set: { expiresAt: past } });
  expect((await owner.list({ includeHistory: true })).notes.map(note => note.id)).toEqual([old.id]);
  await owner.forget(old.id);
  expect((await owner.list({ includeHistory: true })).notes).toEqual([]);
});

test('household reads cannot opt into history, even for a correctly labelled household predecessor', async () => {
  const shared = await family.record({ text: 'Synthetic family backup' });
  await MemoryNote.collection.updateOne({ _id: new Types.ObjectId(shared.id) },
    { $set: { invalidatedAt: past } });
  expect((await family.list()).notes).toEqual([]);
  await expect(family.list({ includeHistory: true })).rejects.toMatchObject({ statusCode: 403 });
});

test('unknown validity stays current and a future invalidation does not end a fact early', async () => {
  const legacy = await owner.record({ text: 'Synthetic undated backup fact' });
  const planned = await owner.record({ text: 'Synthetic future backup change' });
  await MemoryNote.collection.updateOne({ _id: new Types.ObjectId(planned.id) },
    { $set: { invalidatedAt: future } });
  expect(new Set((await owner.list()).notes.map(note => note.id))).toEqual(new Set([legacy.id, planned.id]));
});

test('the general editor cannot rewrite a predecessor or revive it through its deterministic text identity', async () => {
  const { old, current } = await replacedPair();
  await expect(owner.remember({ id: old.id, text: 'Synthetic overwrite' })).rejects.toMatchObject({ statusCode: 409 });
  await expect(owner.remember({ text: old.text, kind: old.kind })).rejects.toMatchObject({ statusCode: 409 });
  const stored = await MemoryNote.findById(old.id).lean();
  expect(stored).toMatchObject({ text: old.text, status: 'active', invalidatedAt: past, supersededBy: current.id });
});

test('a history flag must be a boolean and cannot silently widen an ordinary read', async () => {
  await replacedPair();
  for (const includeHistory of ['false', 'true', 1, {}]) {
    await expect(owner.list({ includeHistory })).rejects.toMatchObject({ statusCode: 400 });
  }
});

test('a fact invalidated after the editor read is not overwritten by its stale write', async () => {
  const note = await owner.remember({ text: 'Synthetic concurrent backup fact' });
  const update = MemoryNote.findOneAndUpdate;
  const spy = jest.spyOn(MemoryNote, 'findOneAndUpdate').mockImplementationOnce(async function (...args) {
    await MemoryNote.collection.updateOne({ _id: new Types.ObjectId(note.id) }, { $set: { invalidatedAt: past } });
    return update.apply(this, args);
  });
  try {
    await expect(owner.remember({ id: note.id, text: 'Synthetic stale correction' })).rejects.toMatchObject({ statusCode: 404 });
    expect(await MemoryNote.findById(note.id).lean()).toMatchObject({ text: note.text, invalidatedAt: past });
  } finally { spy.mockRestore(); }
});
