'use strict';
jest.mock('../../src/services/memoryNoteIndex', () => ({ createIndex: () => ({ indexNote: async () => false }) }));
jest.mock('../../src/services/souvenirRecallSync', () => ({ scheduleSouvenirRecallSync: jest.fn() }));
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const downstream = require('../../src/services/personalHistoryDownstreamScope');
const memory = require('../../src/services/memoryNoteService');
const privacy = require('../../src/services/personalHistoryPrivacy');
const messageScope = require('../../src/services/personalHistoryMessageScope');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { source, proof } = require('../fixtures/historyFindingProof');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const URL = '/api/secretary/history/decision-state/downstream/global';

describe('global selected linked-souvenir evidence', () => {
  let sources, ids, noteIds, probe, app;
  const deps = () => ({ audience: 'owner', control: { probe } });
  const input = extra => ({ sources, observationId: randomUUID(), ...extra });
  const mount = (audience = 'owner') => {
    const app = express(), router = express.Router(); app.use(express.json());
    registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience, control: { probe } },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router); return app;
  };
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => {
    for (const model of [Entry, MemoryNote, Suppression]) await model.deleteMany({});
    sources = [source, { ...source, messageId: 'f'.repeat(16) }].map(row => Object.fromEntries(
      ['system', 'messageId', 'threadId', 'sourceSha256'].map(key => [key, row[key]])));
    ids = []; noteIds = [];
    for (const ref of sources) {
      const id = (await history.record({ kind: 'fact', text: 'Synthetic private global souvenir', sourceDate: null,
        source: { ...ref, findingId: source.findingId } })).entry.id;
      ids.push(id); noteIds.push((await history.keepAsSouvenir(id, { revision: 0 })).souvenirNoteId);
    }
    probe = jest.fn(async value => proof(value)); app = mount();
  });
  afterEach(() => jest.restoreAllMocks());
  const editEarlierNote = () => MemoryNote.updateOne({ _id: noteIds[0] },
    { $set: { text: 'Synthetic changed earlier souvenir' }, $inc: { revision: 1 } });

  test('per-message evidence cannot stand for a current global souvenir observation', async () => {
    let calls = 0;
    probe.mockImplementation(async value => { if (++calls === 4) await editEarlierNote(); return proof(value); });
    const collected = [];
    for (const ref of sources) collected.push(await downstream.discover({ source: ref, observationId: randomUUID() }, deps()));
    const current = await memory.personal().souvenirEvidence(noteIds);
    expect(collected[0].snapshot.entries[0].note.fingerprint).not.toBe(current.find(row => row.id === noteIds[0]).fingerprint);
    expect(calls).toBe(4);
  });
  test('global proof checks two complete passes and one final joined graph, without private content or writes', async () => {
    const before = await MemoryNote.find().sort({ _id: 1 }).lean();
    const aggregates = jest.spyOn(Entry, 'aggregate');
    const response = await request(app).post(URL).send(input({ sources: [...sources].reverse() })).expect(200);
    const value = response.body.data;
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(value).toMatchObject({ contract: 'agentx.history-global-downstream/v1', atomicBatch: false,
      semanticAcceptance: false, executionAllowed: false, cleanupStatus: 'blocked', authenticatedPerson: null, nativeValidationGaps: GAPS });
    expect(value.snapshot.sources).toEqual(sources);
    expect(value.snapshot.coverage.counts).toMatchObject({ messages: 2, entries: 2, currentLinks: 2, observedNotes: 2 });
    expect(value.fingerprint).toBe(digest(value.snapshot));
    expect(JSON.stringify(value)).not.toContain('Synthetic private');
    expect(probe.mock.calls.map(([row]) => row.messageId)).toEqual([sources[0].messageId, sources[0].messageId,
      sources[1].messageId, sources[1].messageId, sources[0].messageId, sources[0].messageId, sources[1].messageId, sources[1].messageId]);
    expect(aggregates.mock.calls.at(-1)[0].some(stage => stage.$lookup?.as === 'souvenirEvidence')).toBe(true);
    expect(await MemoryNote.find().sort({ _id: 1 }).lean()).toEqual(before);
    const repeated = (await request(app).post(URL).send(input({ expected: value.fingerprint })).expect(200)).body.data;
    expect(repeated.status).toBe('observed_match');
  });
  test.each(['edit', 'pending', 'expire', 'forget', 'context', 'replacement'])('last producer %s of an EARLIER souvenir refuses globally', async kind => {
    let calls = 0;
    probe.mockImplementation(async value => {
      if (++calls === 8) {
        if (kind === 'edit') await editEarlierNote();
        if (kind === 'pending') await MemoryNote.updateOne({ _id: noteIds[0] }, { $set: { status: 'pending' } });
        if (kind === 'expire') await MemoryNote.updateOne({ _id: noteIds[0] }, { $set: { expiresAt: new Date(0) } });
        if (kind === 'forget') await memory.personal().forget(noteIds[0]);
        if (kind === 'context') await MemoryNote.updateOne({ _id: noteIds[0] }, { $set: { 'historyContext.inputHash': 'f'.repeat(64) } });
        if (kind === 'replacement') await MemoryNote.updateOne({ _id: noteIds[0] }, { $set: { replacement: { phase: 'linked' } } });
      }
      return proof(value);
    });
    const response = await request(app).post(URL).send(input()).expect(409);
    expect(JSON.stringify(response.body)).not.toContain('Synthetic');
  });
  test.each(['note', 'core'])('final global privacy await cannot hide a late %s change', async kind => {
    const original = messageScope.observeSelection; let calls = 0;
    jest.spyOn(messageScope, 'observeSelection').mockImplementation(async (refs, options) => {
      if (options?.souvenirs && ++calls === 2) jest.spyOn(privacy, 'forgottenSource').mockImplementationOnce(async () => {
        if (kind === 'note') await editEarlierNote();
        else await history.review(ids[0], { revision: 1, state: 'forgotten' });
        return false;
      });
      return original(refs, options);
    });
    await request(app).post(URL).send(input()).expect(409);
    expect(calls).toBe(2);
  });
  test('shared entries and notes are counted once and unselected note bytes are not inspected', async () => {
    await Entry.updateOne({ _id: ids[0] }, { $set: { relatedSources: [{ ...sources[1], findingId: source.findingId }] } });
    const entry = history.project(await Entry.findById(ids[0]).lean());
    await MemoryNote.updateOne({ _id: noteIds[0] }, { $set: { sourceRefs: require('../../src/services/personalHistorySouvenirContext').sourceRefs(entry) } });
    await MemoryNote.collection.insertOne({ scopeId: 'personal', packId: 'personal_operator', kind: 'souvenir', status: 'active', text: 'x'.repeat(600 * 1024) });
    const value = (await request(app).post(URL).send(input()).expect(200)).body.data;
    expect(value.snapshot.members.flatMap(row => row.snapshot.entries)).toHaveLength(3);
    expect(value.snapshot.coverage.counts).toMatchObject({ messages: 2, entries: 2, observedNotes: 2, currentLinks: 2 });
  });
  test('oversized selected note fails inside Mongo before any native producer', async () => {
    await MemoryNote.collection.updateOne({ _id: new MemoryNote.base.Types.ObjectId(noteIds[0]) }, { $set: { text: 'x'.repeat(600 * 1024) } });
    await request(app).post(URL).send(input()).expect(413); expect(probe).not.toHaveBeenCalled();
  });
  test('aggregate joined-note capacity refuses repeated copies even below individual limits', async () => {
    await MemoryNote.collection.updateOne({ _id: new MemoryNote.base.Types.ObjectId(noteIds[0]) }, { $set: { text: 'x'.repeat(100 * 1024) } });
    const base = await Entry.findById(ids[0]).lean();
    await Entry.collection.insertMany(Array.from({ length: 85 }, (_, i) => ({ ...base,
      _id: new Entry.base.Types.ObjectId(), key: `synthetic-joined-capacity-${i}` })));
    await request(app).post(URL).send(input()).expect(413); expect(probe).not.toHaveBeenCalled();
  });
  test('family and malformed inputs refuse before memory/producer work', async () => {
    await request(mount('family')).post(URL).set('x-service-caller', 'owner').send(input()).expect(403);
    for (const extra of [{ sources: [] }, { sources: [sources[0], sources[0]] }, { sources: Array(21).fill(sources[0]) },
      { accepted: true }, { sources: [{ ...sources[0], path: '/untrusted' }] }, { expected: [] }]) {
      await request(app).post(URL).send(input(extra)).expect(400);
    }
    expect(probe).not.toHaveBeenCalled();
  });
});
