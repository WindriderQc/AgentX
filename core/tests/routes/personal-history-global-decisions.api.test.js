'use strict';
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const Suppression = require('../../models/PersonalHistorySuppression');
const MemoryNote = require('../../models/MemoryNote');
const history = require('../../src/services/personalHistoryService');
const privacy = require('../../src/services/personalHistoryPrivacy');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { source, proof } = require('../fixtures/historyFindingProof');
const URL = '/api/secretary/history/decision-state/global';

describe('global selected native decision observations', () => {
  let app, probe, ids, sources;
  const input = extra => ({ sources, observationId: randomUUID(), ...extra });
  const mount = audience => {
    const app = express(), router = express.Router(); app.use(express.json());
    registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience, control: { probe } },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router); return app;
  };
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => {
    for (const model of [Entry, MemoryNote, Suppression]) await model.deleteMany({});
    sources = [source, { ...source, messageId: 'f'.repeat(16) }].map(row => Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(key => [key, row[key]])));
    ids = [];
    for (const ref of sources) ids.push((await history.record({ kind: 'fact', text: 'Synthetic private global decision', sourceDate: null,
      source: { ...ref, findingId: source.findingId } })).entry.id);
    probe = jest.fn(async value => proof(value)); app = mount('owner');
  });
  afterEach(() => jest.restoreAllMocks());
  const observe = async extra => (await request(app).post(URL).send(input(extra)).expect(200)).body.data;

  test('two complete passes, globally unique entries, fresh producer nonces, no writes/content/acceptance', async () => {
    const before = await Entry.find().sort({ _id: 1 }).lean();
    const response = await request(app).post(URL).send(input({ sources: [...sources].reverse() })).expect(200), value = response.body.data;
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(value).toMatchObject({ contract: 'agentx.history-global-decisions/v1', semanticAcceptance: false, atomicBatch: false,
      authenticatedPerson: null, executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS });
    expect(value.snapshot.sources).toEqual(sources); expect(value.snapshot.sourceSetSha256).toBe(digest(sources));
    expect(value.snapshot.coverage.counts).toMatchObject({ messages: 2, entries: 2, heldMessages: 2 });
    expect(value.fingerprint).toBe(digest(value.snapshot)); expect(JSON.stringify(value)).not.toContain('Synthetic private');
    expect(await Entry.find().sort({ _id: 1 }).lean()).toEqual(before);
    expect(probe.mock.calls.map(([v]) => v.messageId)).toEqual([sources[0].messageId, sources[0].messageId, sources[1].messageId, sources[1].messageId,
      sources[0].messageId, sources[0].messageId, sources[1].messageId, sources[1].messageId]);
    expect(new Set(probe.mock.calls.map(([v]) => v.requestId)).size).toBe(8);
    expect((await observe({ expected: value.fingerprint })).status).toBe('observed_match');
  });
  test('a globally shared related-source entry is counted once and pins match across messages', async () => {
    await Entry.updateOne({ _id: ids[0] }, { $set: { relatedSources: [{ ...sources[1], findingId: source.findingId }] } });
    const result = await observe();
    expect(result.snapshot.coverage.counts.entries).toBe(2);
    expect(result.snapshot.coreScopes[1].members).toHaveLength(2);
    const pins = result.snapshot.coreScopes.flatMap(row => row.members).filter(row => row.entryId === ids[0]);
    expect(pins).toHaveLength(2); expect(pins[0]).toEqual(pins[1]);
  });
  test.each(['revision', 'forget', 'new-member', 'source-note', 'final-privacy'])('last producer %s change to an EARLIER message cannot escape the global fence', async kind => {
    if (kind === 'source-note') await Entry.updateOne({ _id: ids[0] }, { $set: { 'source.personalNoteId': '8'.repeat(24) } });
    let count = 0;
    probe.mockImplementation(async value => {
      if (++count === 8) {
        if (kind === 'revision') await Entry.updateOne({ _id: ids[0] }, { $inc: { revision: 1 } });
        if (kind === 'forget') await history.review(ids[0], { revision: 0, state: 'forgotten' });
        if (kind === 'new-member') await history.record({ kind: 'action', text: 'Synthetic new earlier member', sourceDate: null,
          source: { ...sources[0], findingId: '8'.repeat(64) } });
        if (kind === 'source-note') await privacy.forgetSourceNote({ _id: '8'.repeat(24), text: 'Synthetic source note' });
        if (kind === 'final-privacy') jest.spyOn(privacy, 'forgottenSource').mockImplementationOnce(async () => {
          await history.review(ids[0], { revision: 0, state: 'forgotten' }); return false;
        });
      }
      return proof(value);
    });
    const response = await request(app).post(URL).send(input()).expect(409);
    expect(JSON.stringify(response.body)).not.toContain('Synthetic');
  });
  test('earlier native archive evidence changing between complete passes refuses', async () => {
    let count = 0; probe.mockImplementation(async value => proof(value, { reviewSha256: (++count >= 5 ? '9' : 'a').repeat(64) }));
    await request(app).post(URL).send(input()).expect(409);
  });
  test('erasure during the final global privacy await is caught by the final selected-set query', async () => {
    const scope = require('../../src/services/personalHistoryMessageScope');
    const observe = scope.observeSelection; let count = 0;
    jest.spyOn(scope, 'observeSelection').mockImplementation(async refs => {
      if (++count === 2) jest.spyOn(privacy, 'forgottenSource').mockImplementationOnce(async () => {
        await history.review(ids[0], { revision: 0, state: 'forgotten' }); return false;
      });
      return observe(refs);
    });
    await request(app).post(URL).send(input()).expect(409);
    expect(count).toBe(2);
  });
  test('source conflicts and global entry limits refuse before any native producer', async () => {
    await Entry.updateOne({ _id: ids[0] }, { $set: { 'source.threadId': '8'.repeat(16) } });
    await request(app).post(URL).send(input()).expect(409); expect(probe).not.toHaveBeenCalled();
    await Entry.deleteMany({});
    for (let i = 0; i < 101; i++) await history.record({ kind: 'fact', text: `Synthetic bounded global row ${i}`, sourceDate: null,
      source: { ...sources[i % 2], findingId: i.toString(16).padStart(64, '0') } });
    await request(app).post(URL).send(input()).expect(413); expect(probe).not.toHaveBeenCalled();
  });
  test('family and malformed source selections cannot broaden or authorize a scope', async () => {
    await request(mount('family')).post(URL).set('x-service-caller', 'owner').send(input()).expect(403);
    for (const extra of [{ sources: [] }, { sources: [sources[0], sources[0]] }, { sources: Array(21).fill(sources[0]) },
      { observationId: 'old' }, { expected: [] }, { accepted: true }, { sources: [{ ...sources[0], query: 'anything' }] }]) {
      await request(app).post(URL).send(input(extra)).expect(400);
    }
    expect(probe).not.toHaveBeenCalled();
  });
  test('stable changes between observations remain changed, never accepted', async () => {
    const first = await observe(); await history.review(ids[0], { revision: 0, state: 'dismissed', reason: 'Synthetic new decision' });
    expect((await observe({ expected: first.fingerprint })).status).toBe('changed');
  });
});
