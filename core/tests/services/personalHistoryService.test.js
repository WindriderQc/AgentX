'use strict';

const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');

const input = (n = 1) => ({ kind: 'fact', text: `Synthetic source assertion ${n}`, actor: 'Synthetic correspondent',
  sourceDate: `2025-01-${String(n).padStart(2, '0')}T10:00:00-05:00`, eventDateAsWritten: 'vendredi prochain',
  sourceStatus: 'uncertain', source: { system: 'gmail', threadId: 'thread01', messageId: `message${n}`,
    sourceSha256: 'a'.repeat(64), findingId: String(n).repeat(64), direction: 'received' } });

describe('owner historical source assertions', () => {
  beforeAll(async () => { await Entry.createCollection(); await Entry.createIndexes(); await Suppression.createCollection(); await Suppression.createIndexes(); });
  beforeEach(async () => { await Entry.deleteMany({}); await MemoryNote.deleteMany({}); await Suppression.deleteMany({}); });

  test('imports once, preserves source dates and never infers the event date or an accepted fact', async () => {
    const source = { ...input(), scope: 'household', reviewState: 'retained', assertionState: 'confirmed' };
    const first = await history.record(source);
    expect(first).toMatchObject({ created: true, entry: { reviewState: 'candidate', assertionState: 'unknown',
      eventDate: '', eventDatePrecision: 'unknown', eventDateAsWritten: 'vendredi prochain' } });
    expect((await Entry.findById(first.entry.id).lean()).scope).toBe('owner');
    expect(await history.record(source)).toMatchObject({ created: false, entry: { id: first.entry.id } });
    expect(await Entry.countDocuments()).toBe(1);
  });

  test('concurrent replay shares one identity', async () => {
    const results = await Promise.all([history.record(input()), history.record(input())]);
    expect(new Set(results.map(r => r.entry.id)).size).toBe(1);
    expect(results.filter(r => r.created)).toHaveLength(1);
  });

  test('orders review from oldest source to newest and preserves unknown event dates', async () => {
    await history.record(input(2)); await history.record(input(1)); await history.record(input(3));
    const first = await history.list({ limit: 2, state: 'candidate' });
    expect(first.entries.map(r => r.text)).toEqual(['Synthetic source assertion 1', 'Synthetic source assertion 2']);
    expect(first.nextOffset).toBe(2);
    expect((await history.list({ offset: 2 })).entries).toHaveLength(1);
    expect((await history.list({ before: '2025-01-02T00:00:00-05:00' })).total).toBe(1);
  });

  test('review uses a revision fence and import never overwrites the decision', async () => {
    const { entry } = await history.record(input());
    const accepted = await history.review(entry.id, { state: 'retained', reason: 'Synthetic source checked', revision: 0,
      eventDate: '2025-01-10', eventDatePrecision: 'day', assertionState: 'reported' });
    expect(accepted.entry).toMatchObject({ revision: 1, reviewState: 'retained', eventDate: '2025-01-10', assertionState: 'reported' });
    await expect(history.review(entry.id, { state: 'dismissed', reason: 'Stale decision', revision: 0 })).rejects.toMatchObject({ statusCode: 409 });
    expect((await history.record(input())).entry.reviewState).toBe('retained');
    const saved = await Entry.findById(entry.id).lean();
    expect(saved.reviewHistory).toHaveLength(1);
  });

  test('forget retains a suppression identity and reimport cannot resurrect its text', async () => {
    const { entry } = await history.record(input());
    await history.review(entry.id, { state: 'forgotten', revision: 0 });
    expect((await history.list()).total).toBe(0);
    expect((await history.record(input())).entry).toMatchObject({ reviewState: 'forgotten', text: '', source: null });
    const saved = await Entry.findById(entry.id).lean();
    expect(saved.text).toBe(''); expect(saved.actor).toBe(''); expect(saved.reviewHistory).toHaveLength(0);
  });

  test('a forgotten selected note suppresses a linked history import', async () => {
    const note = await MemoryNote.create({ packId: 'synthetic', scopeId: 'owner', text: 'Synthetic forgotten note', status: 'forgotten' });
    const source = input(); source.source.personalNoteId = String(note._id);
    expect(await history.record(source)).toMatchObject({ suppressed: true, entry: { reviewState: 'forgotten', text: '' } });
    expect((await history.list()).total).toBe(0);
  });

  test('forgetting a selected owner note suppresses existing linked history too', async () => {
    const owner = require('../../src/services/memoryNoteService').personal();
    const note = await owner.remember({ text: 'Synthetic linked source note' });
    const source = input(); source.source.personalNoteId = note.id;
    const { entry } = await history.record(source);
    await owner.forget(note.id);
    expect((await history.list()).total).toBe(0);
    expect((await history.record(source)).entry).toMatchObject({ id: entry.id, reviewState: 'forgotten', text: '' });
  });

  test('source forgetting survives the selected-note retention sweep before first history import', async () => {
    const owner = require('../../src/services/memoryNoteService').personal();
    const note = await owner.remember({ text: 'Synthetic note forgotten before history ingestion' });
    await owner.forget(note.id);
    await MemoryNote.deleteMany({ _id: note.id });
    const source = input(); source.source.personalNoteId = note.id;
    expect(await history.record(source)).toMatchObject({ suppressed: true, entry: { reviewState: 'forgotten', text: '' } });
    expect(await Suppression.countDocuments()).toBe(1);
  });

  test('forgetting between the import check and insert cannot resurrect source text', async () => {
    const owner = require('../../src/services/memoryNoteService').personal();
    const note = await owner.remember({ text: 'Synthetic note forgotten during import' });
    const source = input(); source.source.personalNoteId = note.id;
    const write = Entry.findOneAndUpdate.bind(Entry);
    const spy = jest.spyOn(Entry, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
      await owner.forget(note.id);
      return write(...args);
    });
    try {
      expect(await history.record(source)).toMatchObject({ suppressed: true, entry: { reviewState: 'forgotten', text: '' } });
    } finally { spy.mockRestore(); }
  });

  test('rejects ambiguous dates, invalid provenance and resolving a fact as an action', async () => {
    await expect(history.record({ ...input(), sourceDate: '2025-01-01' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(history.record({ ...input(), sourceDate: '2025-02-30T12:00:00Z' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(history.record({ ...input(), source: {} })).rejects.toMatchObject({ statusCode: 400 });
    const { entry } = await history.record(input());
    await expect(history.review(entry.id, { state: 'resolved', reason: 'Synthetic', revision: 0 })).rejects.toMatchObject({ statusCode: 400 });
  });
});
