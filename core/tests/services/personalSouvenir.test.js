'use strict';

const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { personal, forSpace } = require('../../src/services/memoryNoteService');

const input = (n = 1, kind = 'fact') => ({ kind, text: `Synthetic family event ${n}`, actor: 'Synthetic correspondent',
  sourceDate: '2018-05-23T10:00:00-04:00', source: { system: 'gmail', threadId: 'thread01', messageId: `message${n}`,
    sourceSha256: String(n).repeat(64), findingId: 'f'.repeat(64), direction: 'received' } });

describe('souvenirs kept from historical review', () => {
  beforeAll(async () => {
    for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); }
  });
  beforeEach(async () => { await Entry.deleteMany({}); await MemoryNote.deleteMany({}); await Suppression.deleteMany({}); });

  test('keeps a dated owner souvenir with its people and sources, once', async () => {
    const { entry } = await history.record(input());
    const kept = await history.keepAsSouvenir(entry.id, { revision: 0, eventDate: '2018-06-02', eventDatePrecision: 'day',
      places: ['Synthetic town'] });
    expect(kept).toMatchObject({ created: true, entry: { reviewState: 'retained', revision: 1, eventDate: '2018-06-02' } });
    const note = await MemoryNote.findById(kept.souvenirNoteId).lean();
    expect(note).toMatchObject({ kind: 'souvenir', scope: 'owner', sensitivity: 'private', status: 'active', expiresAt: null,
      text: '2018-06-02 : Synthetic family event 1', eventDate: '2018-06-02', eventDatePrecision: 'day',
      people: ['Synthetic correspondent'], places: ['Synthetic town'], source: 'secretary-history' });
    expect(note.sourceRefs).toEqual([{ system: 'personal-history', id: entry.id }, { system: 'gmail', id: '1'.repeat(64) }]);
    const again = await history.keepAsSouvenir(entry.id, { revision: 1 });
    expect(again).toMatchObject({ created: false, souvenirNoteId: kept.souvenirNoteId });
    expect(await MemoryNote.countDocuments()).toBe(1);
    expect(kept.entry.souvenirNoteId).toBe(kept.souvenirNoteId);
  });

  test('a souvenir is recalled and listed in the owner space, never in a family space, and never expires', async () => {
    const { entry } = await history.record(input());
    const { souvenirNoteId } = await history.keepAsSouvenir(entry.id, { revision: 0 });
    const owner = personal();
    expect((await owner.list({ kind: 'souvenir' })).notes.map(n => n.id)).toEqual([souvenirNoteId]);
    expect((await owner.search('synthetic family event')).notes[0]).toMatchObject({ id: souvenirNoteId, kind: 'souvenir' });
    const family = forSpace({ audience: 'household', scopeId: 'personal', packIds: ['personal_operator'] });
    expect((await family.list()).total).toBe(0);
    await expect(family.keepSouvenir({ text: 'x', sourceRefs: [{ system: 'gmail', id: 'a'.repeat(64) }] })).rejects.toMatchObject({ statusCode: 403 });
    const corrected = await owner.remember({ id: souvenirNoteId, text: 'Synthetic family event, corrected', expiresAt: '2999-01-01T00:00:00Z' });
    expect(corrected).toMatchObject({ kind: 'souvenir', expiresAt: null });
  });

  test('a revision fence protects the decision and a retried keep links the same note', async () => {
    const { entry } = await history.record(input());
    await expect(history.keepAsSouvenir(entry.id, { revision: 4 })).rejects.toMatchObject({ statusCode: 409 });
    expect(await MemoryNote.countDocuments()).toBe(0);
    await history.review(entry.id, { state: 'dismissed', reason: 'Synthetic first look', revision: 0 });
    const kept = await history.keepAsSouvenir(entry.id, { revision: 1 });
    expect(kept.entry).toMatchObject({ reviewState: 'retained', revision: 2 });
  });

  test('forgetting the souvenir forgets its source assertion, and forgetting the source forgets the souvenir', async () => {
    const first = (await history.record(input(1))).entry;
    const second = (await history.record(input(2))).entry;
    const one = await history.keepAsSouvenir(first.id, { revision: 0, text: 'Synthetic souvenir worded by the owner' });
    const two = await history.keepAsSouvenir(second.id, { revision: 0 });
    await personal().forget(one.souvenirNoteId);
    expect((await Entry.findById(first.id).lean())).toMatchObject({ reviewState: 'forgotten', text: '' });
    await history.review(second.id, { state: 'forgotten', revision: 1 });
    expect((await MemoryNote.findById(two.souvenirNoteId).lean()).status).toBe('forgotten');
    await expect(history.keepAsSouvenir(second.id, { revision: 2 })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('rejects actions, invalid dates and invalid sources', async () => {
    const action = (await history.record(input(1, 'action'))).entry;
    await expect(history.keepAsSouvenir(action.id, { revision: 0 })).rejects.toMatchObject({ statusCode: 400 });
    const fact = (await history.record(input(2))).entry;
    await expect(history.keepAsSouvenir(fact.id, { revision: 0, eventDate: '2018-02-30', eventDatePrecision: 'day' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(history.keepAsSouvenir(fact.id, {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(personal().keepSouvenir({ text: 'Synthetic', sourceRefs: [{ system: 'web', id: 'a'.repeat(64) }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(personal().keepSouvenir({ text: 'Synthetic', sourceRefs: [] })).rejects.toMatchObject({ statusCode: 400 });
    expect(await MemoryNote.countDocuments()).toBe(0);
  });
});
