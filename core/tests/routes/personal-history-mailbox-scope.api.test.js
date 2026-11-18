'use strict';
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const Suppression = require('../../models/PersonalHistorySuppression');
const MemoryNote = require('../../models/MemoryNote');
const history = require('../../src/services/personalHistoryService');
const privacy = require('../../src/services/personalHistoryPrivacy');
const contract = require('../../src/services/personalHistoryMailboxContract');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { source, reference, proof } = require('../fixtures/historyMailboxProof');
const URL = '/api/secretary/history/decision-state/mailbox';

describe('exact live Gmail source observation on the owner history surface', () => {
  let id, probe, app;
  const input = extra => ({ source: reference, observationId: randomUUID(), ...extra });
  const mount = audience => {
    const app = express(), router = express.Router(); app.use(express.json());
    registerSecretaryHistoryRoutes({ router, mailboxScopeDeps: { audience, control: { probe } },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router); return app;
  };
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => {
    for (const model of [Entry, MemoryNote, Suppression]) await model.deleteMany({});
    id = (await history.record({ kind: 'fact', text: 'Synthetic private assertion', sourceDate: null, source })).entry.id;
    probe = jest.fn(async value => proof(value)); app = mount('owner');
  });
  afterEach(() => jest.restoreAllMocks());
  const observe = async extra => (await request(app).post(URL).send(input(extra)).expect(200)).body.data;

  test('two fresh provider nonces, real Core membership and no content/write/acceptance claims', async () => {
    const before = await Entry.findById(id).lean();
    const response = await request(app).post(URL).send(input()).expect(200), value = response.body.data;
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(value).toMatchObject({ contract: 'agentx.history-mailbox-scope/v1', mailboxEffects: 0, approvalBound: false,
      atomicBatch: false, authenticatedPerson: null, semanticAcceptance: false, executionAllowed: false,
      cleanupStatus: 'blocked', nativeValidationGaps: GAPS });
    expect(value.snapshot.coverage).toEqual({ sourceMatches: true, direction: 'unknown', blockers: [] });
    expect(value.snapshot.coreScope.members).toEqual([expect.objectContaining({ entryId: id, sourceBinding: 'exact' })]);
    expect(value.fingerprint).toBe(digest(value.snapshot)); expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[0][0].requestId).not.toBe(probe.mock.calls[1][0].requestId);
    expect(probe.mock.calls[0][0].requestId).not.toBe(value.observationId);
    expect(JSON.stringify(value)).not.toContain('Synthetic private');
    expect(await Entry.findById(id).lean()).toEqual(before);
    expect((await observe({ expected: value.fingerprint })).status).toBe('observed_match');
  });
  test.each([
    ['raw', { sha256: 'b'.repeat(64), bytes: 1000 }, 'live_source_hash_mismatch'],
    ['threadId', 'f'.repeat(16), 'live_thread_mismatch'],
    ['labelIds', ['DRAFT'], 'live_message_is_draft'], ['labelIds', ['TRASH'], 'live_message_in_trash']
  ])('%s mismatch remains explicit and cannot allow execution', async (key, value, blocker) => {
    probe.mockImplementation(async input => { const native = proof(input); native.current[key] = value; return native; });
    const observed = await observe(); expect(observed.snapshot.coverage.blockers).toContain(blocker);
    expect(observed.executionAllowed).toBe(false);
  });
  test('a typed absence is held, distinct from unknown provider failure', async () => {
    probe.mockImplementation(async input => ({ ...proof(input), status: 'not_found', current: null }));
    expect((await observe()).snapshot.coverage).toEqual({ sourceMatches: null, direction: 'unknown', blockers: ['live_message_not_found'] });
    probe.mockRejectedValue(new Error('PRIVATE PROVIDER STDERR'));
    const response = await request(app).post(URL).send(input()).expect(503);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE PROVIDER');
  });
  test('SENT and DRAFT are label observations, not actor or received classification', async () => {
    probe.mockImplementation(async input => { const value = proof(input); value.current.labelIds = ['SENT']; return value; });
    expect((await observe()).snapshot.coverage.direction).toBe('sent');
    probe.mockImplementation(async input => { const value = proof(input); value.current.labelIds = ['DRAFT', 'SENT']; return value; });
    expect((await observe()).snapshot.coverage.direction).toBe('draft');
  });
  test.each(['labels', 'raw', 'historyId', 'internalDate', 'selector', 'presence'])('provider %s changes during reads refuse', async kind => {
    let count = 0;
    probe.mockImplementation(async input => {
      const value = proof(input);
      if (++count === 2) {
        if (kind === 'selector') value.accountSelectionSha256 = 'd'.repeat(64);
        else if (kind === 'presence') { value.status = 'not_found'; value.current = null; }
        else value.current[{ labels: 'labelIds', raw: 'raw', historyId: 'historyId', internalDate: 'internalDate' }[kind]] =
          { labels: ['INBOX', 'UNREAD'], raw: { sha256: 'd'.repeat(64), bytes: 1001 }, historyId: '3', internalDate: '4' }[kind];
      }
      return value;
    });
    await request(app).post(URL).send(input()).expect(409);
  });
  test.each(['decision', 'forget', 'membership', 'source-note', 'final-privacy'])('late Core %s is caught after the last provider read', async kind => {
    if (kind === 'source-note') await Entry.updateOne({ _id: id }, { $set: { 'source.personalNoteId': '8'.repeat(24) } });
    let count = 0;
    probe.mockImplementation(async input => {
      if (++count === 2) {
        if (kind === 'membership') await history.record({ kind: 'action', text: 'Synthetic new member', sourceDate: null,
          source: { ...source, findingId: '7'.repeat(64) } });
        else if (kind === 'source-note') await privacy.forgetSourceNote({ _id: '8'.repeat(24), text: 'Synthetic source note' });
        else if (kind === 'final-privacy') jest.spyOn(privacy, 'forgottenSource').mockImplementationOnce(async () => {
          await history.review(id, { revision: 0, state: 'forgotten' }); return false;
        });
        else await history.review(id, { revision: 0, state: kind === 'forget' ? 'forgotten' : 'dismissed', reason: 'Synthetic late decision' });
      }
      return proof(input);
    });
    const response = await request(app).post(URL).send(input()).expect(409);
    expect(JSON.stringify(response.body)).not.toContain('Synthetic');
  });
  test('conflicting recorded source refuses before contacting Gmail', async () => {
    await Entry.updateOne({ _id: id }, { $set: { 'source.threadId': 'f'.repeat(16) } });
    await request(app).post(URL).send(input()).expect(409); expect(probe).not.toHaveBeenCalled();
  });
  test('an empty Core member set observes no implicit semantic acceptance', async () => {
    await Entry.deleteMany({}); const value = await observe();
    expect(value.snapshot.coreScope.members).toEqual([]); expect(value.semanticAcceptance).toBe(false);
  });
  test('a stable change between separate calls returns changed against the old fingerprint', async () => {
    const first = await observe();
    probe.mockImplementation(async input => { const value = proof(input); value.current.labelIds = ['SENT']; return value; });
    expect((await observe({ expected: first.fingerprint })).status).toBe('changed');
  });
  test('family and caller-supplied account, permission or query refuse before provider access', async () => {
    await request(mount('family')).post(URL).set('x-service-caller', 'owner').send(input()).expect(403);
    for (const extra of [{ approvalBound: true }, { account: 'auto' }, { query: 'in:anywhere' }, { source: { ...reference, host: 'fake' } }]) {
      await request(app).post(URL).send(input(extra)).expect(400);
    }
    expect(probe).not.toHaveBeenCalled();
  });
  test('a pinned family device cannot reach the owner mailbox observation', async () => {
    const guarded = express(); guarded.use(require('cookie-parser')());
    require('../../surfaces/household/family-device').register({ app: guarded, mongoose: require('mongoose'),
      standardJsonParser: express.json(), ownerUnlock: { activeUntil: async () => null },
      envelope: (res, data, status = 200) => res.status(status).json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    await require('mongoose').model('AgentXHouseholdFamilyDevice').createCollection(); guarded.use(app);
    const cookie = (await request(guarded).post('/api/household/family-device/pin').send({ label: 'Synthetic family screen' }).expect(201)).headers['set-cookie'];
    await request(guarded).post(URL).set('Cookie', cookie).set('x-service-caller', 'owner').send(input()).expect(403);
    expect(probe).not.toHaveBeenCalled();
  });
  test('native contract rejects aliases, extra content, noncanonical and substituted JSON types', () => {
    const args = { ...reference, requestId: randomUUID() };
    const bad = [v => { v.requestId = randomUUID(); }, v => { v.accountSelectionSha256 = ['a'.repeat(64)]; },
      v => { v.current.messageId = source.threadId; }, v => { v.current.raw.sha256 = ['a'.repeat(64)]; },
      v => { v.current.raw.bytes = true; }, v => { v.mailboxEffects = false; }, v => { v.approvalBound = 0; },
      v => { v.current.historyId = 999; }, v => { v.current.internalDate = '01'; },
      v => { v.current.internalDate = '253402300800000'; }, v => { v.current.labelIds = ['INBOX', 'INBOX']; },
      v => { v.current.labelIds = ['Z', 'A']; }, v => { v.current.labelIds = ['L'.repeat(129)]; },
      v => { v.current.labelIds = Array.from({ length: 257 }, (_, i) => 'L' + i).sort(); },
      v => { v.current.raw.bytes = 16 * 1024 * 1024 + 1; }, v => { v.subject = 'Synthetic private'; },
      v => { v.current.raw.content = 'Synthetic private'; }, v => { v.current = null; }, v => { v.status = 'not_found'; }];
    for (const mutate of bad) { const native = proof(args); mutate(native); expect(() => contract.describe(native, args.requestId, reference)).toThrow(); }
  });
});
