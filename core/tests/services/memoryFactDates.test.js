'use strict';

const MemoryNote = require('../../models/MemoryNote');
const { forSpace } = require('../../src/services/memoryNoteService');

// Every vector operation is synthetic; this suite cannot reach inference.
const index = {
  indexNote: jest.fn().mockResolvedValue(true),
  nearest: jest.fn().mockResolvedValue({ results: [{ hits: [] }], indexed: 0, unindexed: 0 }),
};
const owner = forSpace({ audience: 'owner', scopeId: 'personal', packIds: ['personal_operator'], index });
const family = forSpace({ audience: 'household', scopeId: 'family', packIds: ['kidx_nestor'], index });
const sourceRefs = [{ system: 'memory-review', id: 'synthetic-run:synthetic-candidate' }];
const validFrom = '2026-01-05T09:00:00.000Z';

beforeEach(() => MemoryNote.deleteMany({}));

test('a change reported late retains fact time separately from server recording time, through reads and retries', async () => {
  const before = Date.now();
  const saved = await owner.remember({ text: 'Synthetic backup moved to B in January', validFrom, sourceRefs,
    recordedAt: '2000-01-01T00:00:00Z' });
  expect(new Date(saved.validFrom).toISOString()).toBe(validFrom);
  expect(new Date(saved.recordedAt).getTime()).toBeGreaterThanOrEqual(before);
  expect(saved.recordedAt).toEqual(saved.createdAt);
  expect(saved.sourceRefs).toEqual(sourceRefs);
  const replay = await owner.remember({ text: saved.text, validFrom, sourceRefs });
  expect(replay).toMatchObject({ id: saved.id, changed: false, recordedAt: saved.recordedAt, sourceRefs });
  const listed = (await owner.list()).notes[0];
  const searched = (await owner.search('backup')).notes[0];
  for (const note of [listed, searched]) expect(note).toMatchObject({ recordedAt: saved.recordedAt, sourceRefs });
  expect((await family.search('backup')).notes).toEqual([]);
});

test('content edits preserve the first recording time, known fact date and existing provenance', async () => {
  const first = await owner.remember({ text: 'Synthetic astronomy note', validFrom, sourceRefs });
  const edited = await owner.remember({ id: first.id, text: 'Synthetic astronomy corrected',
    sourceRefs: [{ system: 'memory-review', id: 'another-run:another-candidate' }] });
  expect(edited.recordedAt).toEqual(first.recordedAt);
  expect(new Date(edited.validFrom).toISOString()).toBe(validFrom);
  expect(edited.sourceRefs).toEqual([...sourceRefs, { system: 'memory-review', id: 'another-run:another-candidate' }]);
  const replay = await owner.remember({ id: first.id, text: edited.text, sourceRefs });
  expect(replay.changed).toBe(false);
  expect(replay.sourceRefs).toEqual(edited.sourceRefs);
});

test('legacy and undated facts never acquire an invented validity date', async () => {
  const old = await MemoryNote.create({ packId: 'personal_operator', scopeId: 'personal', scope: 'owner',
    sensitivity: 'private', text: 'Synthetic legacy astronomy' });
  const fresh = await owner.record({ text: 'Synthetic new astronomy' });
  expect(fresh.validFrom).toBeNull();
  const listed = (await owner.list()).notes;
  expect(listed.find(note => note.id === String(old._id))).toMatchObject({ validFrom: null, sourceRefs: [] });
});

test('the general note editor cannot change a kept souvenir\'s original source references', async () => {
  const refs = [{ system: 'gmail', id: 'synthetic-source' }];
  const kept = await owner.keepSouvenir({ text: 'Synthetic souvenir', sourceRefs: refs });
  const corrected = await owner.remember({ id: kept.id, text: 'Synthetic souvenir corrected', sourceRefs });
  expect(corrected.sourceRefs).toEqual(refs);
});

test.each([
  { validFrom: 'yesterday' }, { validFrom: '2026-01-01T12:00:00' }, { validFrom: '2026-02-31T00:00:00Z' }, { validFrom: { $gt: 0 } },
  { sourceRefs: [{ system: 'memory-review', id: 'x\nforged' }] },
])('invalid fact metadata is refused before a note or vector write: %j', async metadata => {
  index.indexNote.mockClear();
  await expect(owner.remember({ text: 'Synthetic rejected fact', ...metadata })).rejects.toMatchObject({ statusCode: 400 });
  expect(await MemoryNote.countDocuments()).toBe(0);
  expect(index.indexNote).not.toHaveBeenCalled();
});
