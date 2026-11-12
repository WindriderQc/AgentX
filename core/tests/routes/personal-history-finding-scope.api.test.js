'use strict';

const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const Suppression = require('../../models/PersonalHistorySuppression');
const MemoryNote = require('../../models/MemoryNote');
const history = require('../../src/services/personalHistoryService');
const privacy = require('../../src/services/personalHistoryPrivacy');
const findings = require('../../src/services/personalHistoryFindingScope');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { source, proof } = require('../fixtures/historyFindingProof');
const reference = { system: 'gmail', messageId: source.messageId, threadId: source.threadId, sourceSha256: source.sourceSha256 };
const URL = '/api/secretary/history/decision-state/findings';
const input = extra => ({ source: reference, observationId: randomUUID(), ...extra });

describe('native recorded finding to Core decision review', () => {
  let app, id, probe, deps;
  const mount = (audience = 'owner') => {
    const app = express(), router = express.Router(); app.use(express.json());
    registerSecretaryHistoryRoutes({ router, findingScopeDeps: { ...deps, audience },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router); return app;
  };
  beforeAll(async () => { await Entry.createCollection(); await Entry.createIndexes(); await Suppression.createCollection(); });
  beforeEach(async () => {
    await Entry.deleteMany({}); await Suppression.deleteMany({}); await MemoryNote.deleteMany({});
    id = (await history.record({ kind: 'fact', text: 'Synthetic secret assertion', sourceDate: '2024-01-01T00:00:00Z', source })).entry.id;
    await history.review(id, { revision: 0, state: 'retained', reason: 'Synthetic secret decision reason' });
    probe = jest.fn(async value => proof(value)); deps = { audience: 'owner', control: { probe } }; app = mount();
  });
  afterEach(() => jest.restoreAllMocks());

  test('native finding inventory exposes an unrepresented finding and thread question, without writes or source text', async () => {
    const before = await Entry.findById(id).lean(), body = input();
    const response = await request(app).post(URL).send(body).expect(200), result = response.body.data;
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(result).toMatchObject({ authority: 'agentx.core', contract: findings.CONTRACT, observationId: body.observationId,
      atomicBatch: false, authenticatedPerson: null, semanticAcceptance: false, downstreamState: 'not_rechecked',
      executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS });
    expect(result.fingerprint).toBe(digest(result.snapshot));
    expect(result.snapshot.coverage.counts).toMatchObject({ recordedFindings: 2, noCoreReference: 1, observedDecision: 1, threadQuestions: 1 });
    expect(result.snapshot.coverage.findings.find(row => row.section === 'actions').status).toBe('no_core_reference');
    expect(result.snapshot.coverage.blockers).toEqual(expect.arrayContaining(['recorded_findings_need_review', 'thread_questions_unresolved']));
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[0][0].requestId).not.toBe(probe.mock.calls[1][0].requestId);
    expect(probe.mock.calls.every(([value]) => value.requestId !== body.observationId)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Synthetic secret|decision reason/);
    expect(await Entry.findById(id).lean()).toEqual(before);
  });

  test('every recorded finding can have an observed decision while cleanup and semantic acceptance remain false', async () => {
    probe.mockImplementation(async value => proof(value, { threadQuestions: [] }));
    const action = (await history.record({ kind: 'action', text: 'Synthetic resolved action', sourceDate: null, source: { ...source, findingId: 'f'.repeat(64) } })).entry;
    await history.review(action.id, { revision: 0, state: 'resolved', reason: 'Synthetic action resolution' });
    const first = await findings.discover(input(), deps);
    expect(first.snapshot.coverage.counts).toMatchObject({ observedDecision: 2, noCoreReference: 0, needsReview: 0, threadQuestions: 0 });
    expect(first.snapshot.coverage.blockers).toEqual([]);
    expect(first.executionAllowed).toBe(false); expect(first.semanticAcceptance).toBe(false); expect(first.nativeValidationGaps).toEqual(GAPS);
    const next = await findings.discover(input({ expected: first.fingerprint }), deps);
    expect(next.status).toBe('observed_match'); expect(next.observationId).not.toBe(first.observationId);
    await history.review(action.id, { revision: 1, state: 'retained', reason: 'Synthetic reopened historical action' });
    const changed = await findings.discover(input({ expected: first.fingerprint }), deps);
    expect(changed.status).toBe('changed'); expect(changed.snapshot.coverage.counts.needsReview).toBe(1);
  });

  test('a linked open action is preserved and its kind mismatch cannot make a memory finding addressed', async () => {
    const linked = (await history.record({ kind: 'action', text: 'Synthetic linked obligation', sourceDate: null,
      source: { system: 'document', id: 'synthetic-doc', sourceSha256: '1'.repeat(64), findingId: '2'.repeat(64) },
      relatedSources: [source] })).entry.id;
    const result = await findings.discover(input(), deps);
    const memory = result.snapshot.coverage.findings.find(row => row.section === 'memories');
    expect(memory.status).toBe('needs_review');
    expect(memory.records.find(row => row.entryId === linked).blockers).toEqual(expect.arrayContaining([
      'kind_differs_from_native_import_kind', 'owner_decision_not_recorded'
    ]));
  });

  test('pending source-review intents and Core references absent from the current native inventory stay explicit', async () => {
    await Entry.updateOne({ _id: id }, { $set: { sourceReviews: [{ requestId: randomUUID(), entryRevision: 1,
      basisHash: 'a'.repeat(64), snapshot: { contract: 'synthetic', sources: [] }, snapshotHash: 'b'.repeat(64), coverage: [],
      decisionIntent: { intentHash: 'c'.repeat(64), inputHash: 'd'.repeat(64), input: {} } }] } });
    const extra = (await history.record({ kind: 'fact', text: 'Synthetic older finding retained for review', sourceDate: null,
      source: { ...source, findingId: '1'.repeat(64) } })).entry.id;
    const result = await findings.discover(input(), deps);
    expect(result.snapshot.coverage.unmatchedEntries).toContain(extra);
    expect(result.snapshot.coverage.blockers).toContain('core_references_outside_recorded_finding_set');
    const memory = result.snapshot.coverage.findings.find(row => row.section === 'memories');
    expect(memory.records[0].blockers).toContain('pending_source_review_intent');
  });

  test('an empty recorded finding set never becomes semantic acceptance', async () => {
    await Entry.deleteMany({}); probe.mockImplementation(async value => proof(value, { findings: [], threadQuestions: [] }));
    const result = await findings.discover(input(), deps);
    expect(result.snapshot.coverage.counts.recordedFindings).toBe(0);
    expect(result.snapshot.coverage.blockers).toContain('empty_recorded_finding_set_not_semantic_acceptance');
    expect(result.executionAllowed).toBe(false);
  });

  test.each(['decision', 'forget', 'source-note', 'final-privacy-await'])('an intervening %s before final delivery cannot return old Core findings', async change => {
    if (change === 'source-note') await Entry.updateOne({ _id: id }, { $set: { 'source.personalNoteId': '8'.repeat(24) } });
    let calls = 0;
    probe.mockImplementation(async value => {
      if (++calls === 2) {
        if (change === 'source-note') await privacy.forgetSourceNote({ _id: '8'.repeat(24), text: 'Synthetic source note' });
        else if (change === 'final-privacy-await') jest.spyOn(privacy, 'forgottenSource').mockImplementationOnce(async () => {
          await history.review(id, { revision: 1, state: 'forgotten' }); return false;
        });
        else await history.review(id, { revision: 1, state: change === 'forget' ? 'forgotten' : 'dismissed',
          ...(change === 'decision' ? { reason: 'Synthetic intervening decision' } : {}) });
      }
      return proof(value);
    });
    const response = await request(app).post(URL).send(input()).expect(409);
    expect(JSON.stringify(response.body)).not.toContain('Synthetic secret');
  });

  test('native metadata changing between the two fresh reads refuses instead of reusing a report', async () => {
    let count = 0; probe.mockImplementation(async value => proof(value, { metadataSha256: (++count === 1 ? 'a' : 'b').repeat(64) }));
    await request(app).post(URL).send(input()).expect(409);
  });

  test.each([{ sourceSha256: 'b'.repeat(64) }, { requestId: randomUUID() }, { semanticAcceptance: true }, { executionAllowed: true },
    { evidenceHash: ['a'.repeat(64)] }, { findings: [{ findingId: 'b'.repeat(64), section: 'unknown' }] },
    { findings: [{ findingId: 'b'.repeat(64), section: 'memories' }, { findingId: 'b'.repeat(64), section: 'actions' }] },
    { threadQuestions: [{ questionId: '9'.repeat(64) }, { questionId: '9'.repeat(64) }] }])('native malformed or uncorrelated inventory is unknown: %p', async change => {
    probe.mockImplementation(async value => proof(value, change));
    await request(app).post(URL).send(input()).expect(503);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test('an unavailable producer refuses, with no provider fallback or private host error leak', async () => {
    probe.mockRejectedValue(new Error('PRIVATE HOST PATH'));
    const response = await request(app).post(URL).send(input()).expect(503);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE HOST PATH'); expect(probe).toHaveBeenCalledTimes(1);
  });

  test('server-selected family and pinned-family boundary refuse before native access', async () => {
    await request(mount('family')).post(URL).set('x-agentx-caller', 'owner').send(input()).expect(403);
    const guarded = express(); guarded.use(require('cookie-parser')());
    require('../../surfaces/household/family-device').register({ app: guarded, mongoose: require('mongoose'),
      standardJsonParser: express.json(), ownerUnlock: { activeUntil: async () => null },
      envelope: (res, data, status = 200) => res.status(status).json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    await require('mongoose').model('AgentXHouseholdFamilyDevice').createCollection(); guarded.use(app);
    const cookie = (await request(guarded).post('/api/household/family-device/pin').send({ label: 'Synthetic family screen' }).expect(201)).headers['set-cookie'];
    await request(guarded).post(URL).set('Cookie', cookie).send(input()).expect(403);
    expect(probe).not.toHaveBeenCalled();
  });
});
