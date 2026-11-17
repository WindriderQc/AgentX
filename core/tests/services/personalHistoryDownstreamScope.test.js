'use strict';

jest.mock('../../src/services/memoryNoteIndex', () => ({ createIndex: () => ({ indexNote: async () => false }) }));
jest.mock('../../src/services/souvenirRecallSync', () => ({ scheduleSouvenirRecallSync: jest.fn() }));
const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const context = require('../../src/services/personalHistoryContextService');
const memory = require('../../src/services/memoryNoteService');
const scope = require('../../src/services/personalHistoryDownstreamScope');
const messageScope = require('../../src/services/personalHistoryMessageScope');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { source, proof } = require('../fixtures/historyFindingProof');
const reference = Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(key => [key, source[key]]));
const { input: contextualInput } = require('../fixtures/personalHistoryContext');

describe('current downstream souvenir evidence for exact historical sources', () => {
  let id, noteId, deps, probe;
  const input = extra => ({ source: reference, observationId: randomUUID(), ...extra });
  const observe = extra => scope.discover(input(extra), deps);
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => {
    for (const model of [Entry, MemoryNote, Suppression]) await model.deleteMany({});
    id = (await history.record({ kind: 'fact', text: 'Synthetic secret retained assertion', sourceDate: null, source })).entry.id;
    noteId = (await history.keepAsSouvenir(id, { revision: 0 })).souvenirNoteId;
    probe = jest.fn(async value => proof(value)); deps = { audience: 'owner', control: { probe } };
  });
  afterEach(() => jest.restoreAllMocks());

  test('binds real native note state and provenance without returning text or writing a note', async () => {
    const before = await MemoryNote.findById(noteId).lean(), entryBefore = await Entry.findById(id).lean();
    const value = await observe();
    expect(value).toMatchObject({ contract: scope.CONTRACT, downstreamState: 'linked-souvenirs-observed',
      executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS,
      semanticAcceptance: false, atomicBatch: false, authenticatedPerson: null });
    expect(value.snapshot.entries).toEqual([expect.objectContaining({ entryId: id, state: 'current_link', blockers: [],
      note: expect.objectContaining({ id: noteId, revision: 0, sourceBinding: true, contextBinding: true }) })]);
    expect(value.fingerprint).toBe(digest(value.snapshot));
    expect(JSON.stringify(value)).not.toContain('Synthetic secret'); expect(probe).toHaveBeenCalledTimes(2);
    expect(await MemoryNote.findById(noteId).lean()).toEqual(before);
    expect(await Entry.findById(id).lean()).toEqual(entryBefore);
    expect((await observe({ expected: value.fingerprint })).status).toBe('observed_match');
  });
  test('owner note corrections are retained and produce a new native fingerprint', async () => {
    const first = await observe();
    await memory.personal().editSouvenir(noteId, { revision: 0, text: 'Synthetic corrected private note', eventDate: '2005', eventDatePrecision: 'year' });
    const next = await observe({ expected: first.fingerprint });
    expect(next.status).toBe('changed'); expect(next.snapshot.entries[0].state).toBe('current_link');
    expect(next.snapshot.entries[0].note.revision).toBe(1);
    expect((await MemoryNote.findById(noteId).lean()).text).toBe('Synthetic corrected private note');
    expect(JSON.stringify(next)).not.toContain('Synthetic corrected private note');
  });
  test.each([
    ['pending', { status: 'pending' }],
    ['expired', { expiresAt: new Date('2000-01-01') }],
    ['invalidated', { invalidatedAt: new Date('2000-01-01') }],
    ['family', { scopeId: 'family', packId: 'kidx_nestor' }], ['wrong kind', { kind: 'fact' }]
  ])('%s notes are equally unavailable under the existing memory boundary', async (_name, changes) => {
    await MemoryNote.updateOne({ _id: noteId }, { $set: changes });
    const value = await observe();
    expect(value.snapshot.entries[0]).toMatchObject({ state: 'unavailable', note: null, blockers: ['linked_souvenir_unavailable'] });
    expect(value.snapshot.coverage.blockers).toContain('linked_souvenirs_need_review');
  });
  test('a missing note or invalid retained link never becomes a current souvenir', async () => {
    await MemoryNote.deleteMany({});
    expect((await observe()).snapshot.entries[0].state).toBe('unavailable');
    await Entry.updateOne({ _id: id }, { $set: { souvenirNoteId: 'invalid-link' } });
    expect((await observe()).snapshot.entries[0].state).toBe('unavailable');
  });
  test('a forgotten note sharing source content triggers the existing erasure barrier', async () => {
    await MemoryNote.updateOne({ _id: noteId }, { $set: { status: 'forgotten' } });
    await expect(observe()).rejects.toMatchObject({ statusCode: 409 });
    expect((await Entry.findById(id).lean()).reviewState).toBe('forgotten');
  });
  test('an unlinked assertion creates no memory and claims no projection', async () => {
    await Entry.updateOne({ _id: id }, { $set: { souvenirNoteId: '' } });
    const before = await MemoryNote.countDocuments();
    expect((await observe()).snapshot.entries[0]).toMatchObject({ state: 'not_linked', note: null, blockers: [] });
    expect(await MemoryNote.countDocuments()).toBe(before);
  });
  test.each([
    [{ system: 'personal-history', id: 'f'.repeat(24) }, { system: 'gmail', id: source.sourceSha256 }],
    [{ system: 'personal-history', id: null }],
    [{ system: 'gmail', id: source.sourceSha256 }]
  ].map(value => [value]))('wrong or incomplete native source references hold review', async sourceRefs => {
    await MemoryNote.updateOne({ _id: noteId }, { $set: { sourceRefs } });
    expect((await observe()).snapshot.entries[0]).toMatchObject({ state: 'needs_review', blockers: ['linked_souvenir_source_mismatch'] });
  });
  test('related source hashes are required independently of the selected message', async () => {
    await Entry.updateOne({ _id: id }, { $set: { relatedSources: [{ ...source, messageId: '8'.repeat(16), sourceSha256: '8'.repeat(64) }] } });
    expect((await observe()).snapshot.entries[0].blockers).toContain('linked_souvenir_source_mismatch');
  });
  test('source context is bound to the complete original kept context, not merely its revision', async () => {
    const value = contextualInput(); value.entry.source = source;
    value.entryId = id; value.sourceKey = (await Entry.findById(id).lean()).key; delete value.entry;
    const result = await context.importBatch({ entries: [value] });
    const row = result.results[0].entry;
    await Entry.updateOne({ _id: id }, { $set: { souvenirNoteId: '' } });
    await MemoryNote.deleteMany({});
    noteId = (await history.keepAsSouvenir(id, { revision: row.revision, contextRevision: row.contextRevision })).souvenirNoteId;
    expect((await observe()).snapshot.entries[0].state).toBe('current_link');
    await MemoryNote.updateOne({ _id: noteId }, { $set: { 'historyContext.temporal.date': '2006' } });
    expect((await observe()).snapshot.entries[0].blockers).toContain('linked_souvenir_context_mismatch');
  });
  test('unfinished native replacements stay held', async () => {
    await MemoryNote.updateOne({ _id: noteId }, { $set: { replacement: { phase: 'preparing', key: 'synthetic' } } });
    expect((await observe()).snapshot.entries[0].blockers).toContain('linked_souvenir_replacement_pending');
  });
  test.each(['text', 'forget', 'expiry', 'source'])('late note %s between the two memory reads refuses an older successful scope', async kind => {
    const notes = memory.personal(); let reads = 0;
    deps.notes = { souvenirEvidence: async ids => {
      const result = await notes.souvenirEvidence(ids);
      if (++reads === 1) {
        const change = { text: { text: 'Synthetic changed note' }, forget: { status: 'forgotten' },
          expiry: { expiresAt: new Date('2000-01-01') }, source: { sourceRefs: [] } }[kind];
        await MemoryNote.updateOne({ _id: noteId }, { $set: change });
      }
      return result;
    } };
    await expect(observe()).rejects.toMatchObject({ statusCode: 409 });
  });
  test('final Core fence catches decisions or membership changed during the last memory read', async () => {
    const notes = memory.personal(); let reads = 0;
    deps.notes = { souvenirEvidence: async ids => {
      const result = await notes.souvenirEvidence(ids);
      if (++reads === 2) await Entry.updateOne({ _id: id }, { $inc: { revision: 1 } });
      return result;
    } };
    await expect(observe()).rejects.toMatchObject({ statusCode: 409 });
  });
  test('native source erasure during the second memory read cannot return historical identities', async () => {
    const notes = memory.personal(); let reads = 0;
    deps.notes = { souvenirEvidence: async ids => {
      const result = await notes.souvenirEvidence(ids);
      if (++reads === 2) await history.review(id, { state: 'forgotten', revision: 1 });
      return result;
    } };
    await expect(observe()).rejects.toMatchObject({ statusCode: 409 });
  });
  test('family and caller-provided acceptance flags refuse before native probes', async () => {
    await expect(scope.discover(input(), { ...deps, audience: 'family' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(observe({ accepted: true })).rejects.toMatchObject({ statusCode: 400 });
    expect(probe).not.toHaveBeenCalled();
  });
  test('oversized native note refuses without partial evidence', async () => {
    await MemoryNote.updateOne({ _id: noteId }, { $set: { text: 'x'.repeat(600 * 1024) } });
    await expect(observe()).rejects.toMatchObject({ statusCode: 413 });
  });
  test('the memory evidence capability rejects family and oversized or malformed selections', async () => {
    await expect(memory.forSpace({ audience: 'household', scopeId: 'family', packIds: ['kidx_nestor'] }).souvenirEvidence([noteId]))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(memory.personal().souvenirEvidence(new Array(101).fill(noteId))).rejects.toMatchObject({ statusCode: 400 });
    await expect(memory.personal().souvenirEvidence(['bad'])).rejects.toMatchObject({ statusCode: 400 });
    expect(await memory.personal().souvenirEvidence([])).toEqual([]);
  });
  test('the selected message includes linked entries with another primary source system', async () => {
    const secondId = (await history.record({ kind: 'fact', text: 'Synthetic separately sourced assertion', sourceDate: null,
      source: { system: 'document', id: 'synthetic-document', sourceSha256: '7'.repeat(64), findingId: '6'.repeat(64) },
      relatedSources: [source] })).entry.id;
    const secondNoteId = (await history.keepAsSouvenir(secondId, { revision: 0 })).souvenirNoteId;
    const result = await observe();
    expect(result.snapshot.entries).toHaveLength(2);
    expect(result.snapshot.entries.map(row => row.state)).toEqual(['current_link', 'current_link']);
    expect(result.snapshot.entries.map(row => row.note.id).sort()).toEqual([noteId, secondNoteId].sort());
  });
});
