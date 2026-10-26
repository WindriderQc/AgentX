'use strict';
const express = require('express');
const request = require('supertest');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { input, hash } = require('../fixtures/personalHistoryContext');
// No inference, embedding, or selected-memory service is invoked by this suite.
jest.mock('../../src/services/memoryNoteIndex', () => ({ createIndex: () => ({
  indexNote: jest.fn().mockResolvedValue(false), remove: jest.fn().mockResolvedValue(false)
}) }));
const app = express(); app.use(express.json({ limit: '5mb' })); const router = express.Router();
registerSecretaryHistoryRoutes({ router, envelope: (res, data) => res.json({ status: 'success', data }),
  fail: (res, status, message, code) => res.status(status).json({ status: 'error', message, code }) });
app.use('/api/secretary', router);
const path = '/api/secretary/history';
const publish = (entries, status = 200) => request(app).post(`${path}/context/import`).send({ entries }).expect(res => { if (res.status !== status) throw new Error(`${res.status}: ${res.body.message}`); }).expect(status);

describe('native owner timeline contexts with isolated Mongo', () => {
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => { await Entry.deleteMany({}); await MemoryNote.deleteMany({}); await Suppression.deleteMany({}); });

  test('imports a complete nonmail moment once, exposes metadata pages and verifies exact source reads', async () => {
    const value = input(); const first = (await publish([value])).body.data.results[0];
    expect(first).toMatchObject({ created: true, changed: true, replayed: false, contextRevision: 1,
      entry: { reviewState: 'candidate', assertionState: 'unknown', revision: 0, souvenirNoteId: '',
        timeline: { date: '2004', precision: 'year', endDate: null, reviewState: 'confirmed' } } });
    expect(await MemoryNote.countDocuments()).toBe(0);
    const replay = (await publish([value])).body.data.results[0];
    expect(replay).toMatchObject({ entryId: first.entryId, replayed: true, changed: false, contextHash: first.contextHash });
    expect(await Entry.countDocuments()).toBe(1);
    const page = (await request(app).get(`${path}?importId=${value.importId}`).expect(200)).body.data;
    expect(page.total).toBe(1); expect(page.entries[0].sourceKey).toBe(first.sourceKey);
    expect(page.entries[0].context.sources[0].body).toBeUndefined();
    expect((await request(app).get(`${path}?sourceKey=${first.sourceKey}`).expect(200)).body.data.total).toBe(1);
    const detail = (await request(app).get(`${path}/${first.entryId}?includeSourceBodies=true`).expect(200)).body.data.entry;
    expect(detail.context.sources[0].body).toBe(value.sourceRecords[0].body);
    const source = (await request(app).get(`${path}/${first.entryId}/sources/source-1`).expect(200)).body.data;
    expect(source).toMatchObject({ authority: 'agentx.core', source: { body: value.sourceRecords[0].body, bodySha256: hash(value.sourceRecords[0].body) } });
    await request(app).get(`${path}/${first.entryId}/sources/absent`).expect(404);
    await Entry.updateOne({ _id: first.entryId }, { $set: { 'context.sources.0.body': 'corrupted synthetic text' } });
    await request(app).get(`${path}/${first.entryId}/sources/source-1`).expect(500);
  });

  test('enriches a legacy record without changing its identity, review decision, revision or souvenir', async () => {
    const value = input(); value.entry.source = { system: 'gmail', threadId: 'thread01', messageId: 'message01', sourceSha256: 'a'.repeat(64), findingId: 'b'.repeat(64) };
    value.entry.sourceDate = '2025-01-01T00:00:00Z';
    const old = await history.record(value.entry);
    await history.review(old.entry.id, { revision: 0, state: 'retained', assertionState: 'confirmed', reason: 'Explicit synthetic owner review' });
    await Entry.updateOne({ _id: old.entry.id }, { $set: { souvenirNoteId: '1'.repeat(24) } });
    const before = await Entry.findById(old.entry.id).lean();
    const enrichment = { ...value, entryId: old.entry.id, sourceKey: old.sourceKey }; delete enrichment.entry;
    const result = (await publish([enrichment])).body.data.results[0];
    expect(result).toMatchObject({ created: false, changed: true, entryId: old.entry.id, sourceKey: old.sourceKey,
      entry: { revision: 1, reviewState: 'retained', assertionState: 'unknown', recordedAssertionState: 'confirmed', confirmationCurrent: false, souvenirNoteId: '1'.repeat(24) } });
    const after = await Entry.findById(old.entry.id).lean();
    expect(after.decision).toEqual(before.decision); expect(after.reviewHistory).toEqual(before.reviewHistory);
    await publish([{ ...enrichment, sourceKey: 'c'.repeat(64) }], 409);
    const changed = structuredClone(enrichment); changed.timeline.description = 'More source context';
    await publish([changed], 409); changed.expectedContextRevision = 1;
    expect((await publish([changed])).body.data.results[0].contextRevision).toBe(2);
  });

  test('source enrichment cannot replace or drop an archived body under its existing identity', async () => {
    const value = input(); await publish([value]);
    const changed = structuredClone(value); changed.expectedContextRevision = 1;
    changed.sourceRecords[0].body += '\nRevised extraction'; changed.sourceRecords[0].bodySha256 = hash(changed.sourceRecords[0].body);
    await publish([changed], 409);
    const replacement = { ...changed.sourceRecords[0], id: 'source-new' };
    changed.sourceRecords = [replacement]; changed.timeline.sourceIds = [replacement.id];
    changed.timeline.claimsWithExactQuotes = [{ sourceId: replacement.id, quote: 'Revised extraction' }];
    await publish([changed], 409);
    changed.sourceRecords.unshift(value.sourceRecords[0]);
    const result = (await publish([changed])).body.data.results[0];
    expect(result.contextRevision).toBe(2); expect(result.entry.context.sources).toHaveLength(2);
  });

  test('reconciles concurrent and lost replies and fences reused import identities', async () => {
    const value = input(); const pair = await Promise.all([publish([value]), publish([value])]);
    expect(new Set(pair.map(r => r.body.data.results[0].entryId)).size).toBe(1);
    expect(await Entry.countDocuments()).toBe(1);
    const other = input(2); other.importId = value.importId;
    await publish([other], 409);
    expect(await Entry.countDocuments()).toBe(1);
    const alternate = structuredClone(value); alternate.importId = 'example:alternate';
    await publish([alternate], 409);
    expect(await Entry.countDocuments()).toBe(1);
  });

  test('owner corrections remain separate from imported claims and survive replay and source enrichment', async () => {
    const value = input(); const first = (await publish([value])).body.data.results[0];
    const editPath = `${path}/${first.entryId}/context`;
    await request(app).post(editPath).send({ revision: 1, changes: { timeline: { date: '2004-06-12', precision: 'day' } } }).expect(400);
    const patch = { title: 'Owner corrected synthetic title', date: '2004-06-12', precision: 'day', ageStartWindow: null, dateWindow: null,
      endDate: null, endPrecision: 'unknown', links: [{ label: 'Example', href: 'https://example.org/record' }] };
    const edited = (await request(app).post(editPath).send({ revision: 1, changes: { timeline: patch } }).expect(200)).body.data.entry;
    expect(edited).toMatchObject({ revision: 0, contextRevision: 2, assertionState: 'unknown', timeline: { ...patch },
      context: { importedTimeline: { title: value.timeline.title, date: '2004', precision: 'year' } } });
    await request(app).post(editPath).send({ revision: 1, changes: { timeline: patch } }).expect(409);
    await request(app).post(editPath).send({ revision: 2, changes: { timeline: { sourceIds: [] } } }).expect(400);
    await request(app).post(editPath).send({ revision: 2, changes: { timeline: { reviewState: 'confirmed' } } }).expect(400);
    const replay = (await publish([value])).body.data.results[0];
    expect(replay).toMatchObject({ replayed: true, contextRevision: 2, entry: { timeline: { title: patch.title } } });
    const changed = structuredClone(value); changed.expectedContextRevision = 2; changed.timeline.description = 'Synthetic enrichment';
    const updated = (await publish([changed])).body.data.results[0];
    expect(updated).toMatchObject({ contextRevision: 3, entry: { revision: 0, timeline: { title: patch.title, description: 'Synthetic enrichment' } } });
    expect(await MemoryNote.countDocuments()).toBe(0);
  });

  test('validates native owner cross references and never confirms during edits', async () => {
    const [a, b] = (await publish([input(), input(2)])).body.data.results;
    const route = `${path}/${a.entryId}/context`;
    await request(app).post(route).send({ revision: 1, changes: { timeline: { relatedEventIds: ['legacy-2'] } } }).expect(400);
    await request(app).post(route).send({ revision: 1, changes: { timeline: { relatedEventIds: ['f'.repeat(24)] } } }).expect(400);
    const edited = (await request(app).post(route).send({ revision: 1, changes: { timeline: { relatedEventIds: [b.entryId], hypothesis: false } } }).expect(200)).body.data.entry;
    expect(edited.assertionState).toBe('unknown'); expect(edited.reviewState).toBe('candidate');
    const reviewed = (await request(app).post(`${path}/${a.entryId}/review`).send({ revision: 0, contextRevision: 2, state: 'retained', assertionState: 'confirmed', reason: 'Explicit owner confirmation' }).expect(200)).body.data.entry;
    expect(reviewed).toMatchObject({ revision: 1, contextRevision: 2, assertionState: 'confirmed', souvenirNoteId: '' });
  });

  test('confirmation binds both revisions and later context changes require an explicit review again', async () => {
    const value = input(); const first = (await publish([value])).body.data.results[0];
    const review = { revision: 0, state: 'retained', assertionState: 'confirmed', reason: 'Explicit synthetic owner confirmation' };
    await request(app).post(`${path}/${first.entryId}/review`).send(review).expect(400);
    await request(app).post(`${path}/${first.entryId}/review`).send({ ...review, contextRevision: 2 }).expect(409);
    const confirmed = (await request(app).post(`${path}/${first.entryId}/review`).send({ ...review, contextRevision: 1 }).expect(200)).body.data.entry;
    expect(confirmed).toMatchObject({ assertionState: 'confirmed', confirmationCurrent: true, confirmation: { contextRevision: 1 } });
    expect((await publish([value])).body.data.results[0].entry.confirmationCurrent).toBe(true);
    const edited = (await request(app).post(`${path}/${first.entryId}/context`).send({ revision: 1, changes: { timeline: { title: 'Different owner claim' } } }).expect(200)).body.data.entry;
    expect(edited).toMatchObject({ revision: 1, contextRevision: 2, assertionState: 'unknown', recordedAssertionState: 'confirmed', confirmationCurrent: false,
      confirmation: { reason: review.reason, contextRevision: 1 } });
    await request(app).post(`${path}/${first.entryId}/review`).send({ ...review, revision: 1, contextRevision: 1 }).expect(409);
    const again = (await request(app).post(`${path}/${first.entryId}/review`).send({ ...review, revision: 1, contextRevision: 2 }).expect(200)).body.data.entry;
    expect(again).toMatchObject({ assertionState: 'confirmed', confirmationCurrent: true, revision: 2 });
    const enriched = structuredClone(value); enriched.expectedContextRevision = 2; enriched.timeline.description = 'Another proposed source detail';
    const result = (await publish([enriched])).body.data.results[0].entry;
    expect(result).toMatchObject({ assertionState: 'unknown', recordedAssertionState: 'confirmed', confirmationCurrent: false, revision: 2 });
    expect(await MemoryNote.countDocuments()).toBe(0);
  });

  test('confirmation refuses a context edit between loading and the native decision write', async () => {
    const first = (await publish([input()])).body.data.results[0];
    const write = Entry.findOneAndUpdate.bind(Entry);
    const spy = jest.spyOn(Entry, 'findOneAndUpdate').mockImplementationOnce((...args) => ({ lean: async () => {
      await Entry.updateOne({ _id: first.entryId }, { $inc: { 'context.revision': 1 } });
      return write(...args).lean();
    } }));
    try {
      await request(app).post(`${path}/${first.entryId}/review`).send({ revision: 0, contextRevision: 1,
        state: 'retained', assertionState: 'confirmed', reason: 'Synthetic stale content' }).expect(409);
    } finally { spy.mockRestore(); }
    const row = await Entry.findById(first.entryId).lean();
    expect(row.assertionState).toBe('unknown'); expect(row.confirmation).toBeNull(); expect(row.revision).toBe(0);
  });

  test('owner can explicitly keep a nonmail month-precision source as a souvenir', async () => {
    const value = input(); value.entry.eventDate = '2004-06'; value.entry.eventDatePrecision = 'month'; value.timeline.date = '2004-06-01'; value.timeline.precision = 'month';
    const first = (await publish([value])).body.data.results[0];
    const kept = (await request(app).post(`${path}/${first.entryId}/souvenir`).send({ revision: 0, contextRevision: 1 }).expect(200)).body.data;
    const note = await MemoryNote.findById(kept.souvenirNoteId).lean();
    expect(note).toMatchObject({ kind: 'souvenir', eventDate: '2004-06', eventDatePrecision: 'month' });
    expect(note.sourceRefs.some(ref => ref.system === 'document')).toBe(true);
    expect(kept.entry.assertionState).toBe('unknown');
  });

  test('keeping uses the corrected context and preserves uncertain periods without confirming them', async () => {
    const value = input(); value.timeline.date = null; value.timeline.precision = 'unknown';
    value.timeline.endDate = '2005'; value.timeline.endPrecision = 'year';
    const first = (await publish([value])).body.data.results[0];
    await request(app).post(`${path}/${first.entryId}/context`).send({ revision: 1, changes: { timeline: { title: 'Owner kept title', description: 'Owner corrected account' } } }).expect(200);
    await request(app).post(`${path}/${first.entryId}/souvenir`).send({ revision: 0 }).expect(400);
    await request(app).post(`${path}/${first.entryId}/souvenir`).send({ revision: 0, contextRevision: 1 }).expect(409);
    const kept = (await request(app).post(`${path}/${first.entryId}/souvenir`).send({ revision: 0, contextRevision: 2 }).expect(200)).body.data;
    const note = await MemoryNote.findById(kept.souvenirNoteId).lean();
    expect(note).toMatchObject({ text: 'Owner kept title\n\nOwner corrected account', status: 'active', eventDate: '', eventDatePrecision: 'unknown',
      historyContext: { contextRevision: 2, temporal: { endDate: '2005', endPrecision: 'year',
        ageStartWindow: { start: '2003-01-01', end: '2005-12-31' } } } });
    expect(note.historyContext.claimsWithExactQuotes[0].quote).toBe(value.timeline.claimsWithExactQuotes[0].quote);
    expect(kept.souvenir.historyContext.contextRevision).toBe(2);
    const page = (await request(app).get(`${path}?importId=${value.importId}`).expect(200)).body.data;
    expect(page.entries[0].souvenir.historyContext.contextRevision).toBe(2);
    expect(kept.entry.assertionState).toBe('unknown');
  });

  test('a context race leaves no active souvenir and a fresh request resumes its pending note', async () => {
    const first = (await publish([input()])).body.data.results[0];
    const write = Entry.findOneAndUpdate.bind(Entry);
    const spy = jest.spyOn(Entry, 'findOneAndUpdate').mockImplementationOnce((...args) => ({ lean: async () => {
      await Entry.updateOne({ _id: first.entryId }, { $set: { 'context.overrides.description': 'Newer owner context' }, $inc: { 'context.revision': 1 } });
      return write(...args).lean();
    } }));
    try { await request(app).post(`${path}/${first.entryId}/souvenir`).send({ revision: 0, contextRevision: 1 }).expect(409); }
    finally { spy.mockRestore(); }
    expect(await MemoryNote.countDocuments({ status: 'active' })).toBe(0);
    expect(await MemoryNote.countDocuments({ status: 'pending' })).toBe(1);
    const kept = (await request(app).post(`${path}/${first.entryId}/souvenir`).send({ revision: 0, contextRevision: 2 }).expect(200)).body.data;
    const note = await MemoryNote.findById(kept.souvenirNoteId).lean();
    expect(note.text).toContain('Newer owner context'); expect(note.historyContext.contextRevision).toBe(2);
    expect(await MemoryNote.countDocuments()).toBe(1); expect(note.status).toBe('active');
  });

  test('a lost activation reply resumes the same linked pending souvenir', async () => {
    const first = (await publish([input()])).body.data.results[0];
    const write = MemoryNote.findOneAndUpdate.bind(MemoryNote);
    let failed = false;
    const spy = jest.spyOn(MemoryNote, 'findOneAndUpdate').mockImplementation((filter, change, options) => {
      if (!failed && filter.status === 'pending' && change.$set?.status === 'active') { failed = true; return Promise.reject(new Error('Synthetic interrupted activation')); }
      return write(filter, change, options);
    });
    try { await request(app).post(`${path}/${first.entryId}/souvenir`).send({ revision: 0, contextRevision: 1 }).expect(500); }
    finally { spy.mockRestore(); }
    expect(await MemoryNote.countDocuments({ status: 'active' })).toBe(0);
    const kept = (await request(app).post(`${path}/${first.entryId}/souvenir`).send({ revision: 0, contextRevision: 1 }).expect(200)).body.data;
    expect(kept.created).toBe(false); expect(await MemoryNote.countDocuments()).toBe(1);
    expect(await MemoryNote.countDocuments({ status: 'active' })).toBe(1);
  });

  test('forget erases context and its bodies, and stable imports cannot resurrect it', async () => {
    const value = input(); const first = (await publish([value])).body.data.results[0];
    await history.review(first.entryId, { revision: 0, state: 'forgotten' });
    await request(app).get(`${path}/${first.entryId}`).expect(404);
    await request(app).get(`${path}/${first.entryId}/sources/source-1`).expect(404);
    await publish([value], 404);
    const forgotten = await Entry.findById(first.entryId).lean();
    expect(forgotten.context).toBeNull(); expect(forgotten.contextImportKey).toBe(hash(value.importId));
    expect((await history.list()).total).toBe(0);
  });

  test('a source-note forget during enrichment cannot retain source text', async () => {
    const note = await MemoryNote.create({ packId: 'synthetic', scopeId: 'owner', text: 'Synthetic source note' });
    const value = input(); value.entry.source.personalNoteId = String(note._id);
    const first = (await publish([value])).body.data.results[0];
    const changed = structuredClone(value); changed.expectedContextRevision = 1; changed.timeline.description = 'Synthetic change';
    const write = Entry.findOneAndUpdate.bind(Entry);
    const spy = jest.spyOn(Entry, 'findOneAndUpdate').mockImplementationOnce((...args) => ({ lean: async () => {
      await require('../../src/services/personalHistoryPrivacy').forgetSourceNote(note);
      return write(...args).lean();
    } }));
    try { await publish([changed], 404); } finally { spy.mockRestore(); }
    const saved = await Entry.findById(first.entryId).lean(); expect(saved.context).toBeNull(); expect(saved.reviewState).toBe('forgotten');
  });

  test('prevalidates every source and native provenance in a batch before writing', async () => {
    const invalid = input(2); invalid.sourceRecords[0].bodySha256 = 'a'.repeat(64);
    await publish([input(), invalid], 400); expect(await Entry.countDocuments()).toBe(0);
    const badNative = input(2); badNative.entry.source = {};
    await publish([input(), badNative], 400); expect(await Entry.countDocuments()).toBe(0);
    await publish([input(), input()], 400); expect(await Entry.countDocuments()).toBe(0);
  });
});
