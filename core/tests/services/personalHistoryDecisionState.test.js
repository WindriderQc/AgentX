'use strict';

const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const privacy = require('../../src/services/personalHistoryPrivacy');
const state = require('../../src/services/personalHistoryDecisionState');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { source } = require('../fixtures/historyPreservationProof');

describe('native committed historical decision state', () => {
  let id;
  const get = input => state.get(id, input, { audience: 'owner' });
  beforeAll(async () => { await Entry.createCollection(); await Suppression.createCollection(); });
  beforeEach(async () => {
    await Entry.deleteMany({}); await MemoryNote.deleteMany({}); await Suppression.deleteMany({});
    id = (await history.record({ kind: 'fact', text: 'Synthetic é 🧭 historical assertion', sourceDate: '2024-01-01T00:00:00Z', source })).entry.id;
  });
  afterEach(() => jest.restoreAllMocks());

  test('one committed document supplies a deterministic bounded fingerprint without writing or granting cleanup', async () => {
    const before = await Entry.findById(id).lean(), first = await get();
    const projected = JSON.parse(JSON.stringify(history.project(before)));
    expect(first).toMatchObject({ authority: 'agentx.core', contract: state.CONTRACT,
      consistency: 'single-entry-committed-document', scope: 'selected-entry-only', status: 'observed',
      authenticatedPerson: null, executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS });
    expect(first.snapshot).toMatchObject({ entryId: id, entryRevision: 0, kind: 'fact', reviewState: 'candidate',
      entrySha256: digest(projected), source, pendingSourceDecisions: 0, downstreamState: 'not_rechecked' });
    expect(first.fingerprint).toBe(digest(first.snapshot));
    expect(JSON.stringify(first)).not.toContain('historical assertion');
    const replay = await get({ expected: first.fingerprint });
    expect(replay.status).toBe('observed_match'); expect(replay.snapshot).toEqual(first.snapshot);
    expect(await Entry.findById(id).lean()).toEqual(before);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(64 * 1024);
  });

  test('a real owner decision changes the fingerprint and never reuses the previous revision', async () => {
    const prior = await get();
    await history.review(id, { state: 'dismissed', revision: 0, reason: 'Synthetic owner decision' });
    const current = await get({ expected: prior.fingerprint });
    expect(current.status).toBe('changed');
    expect(current.snapshot).toMatchObject({ reviewState: 'dismissed', entryRevision: 1 });
    expect(current.snapshot.decisionSha256).not.toBe(prior.snapshot.decisionSha256);
    expect(current.snapshot.reviewHistorySha256).not.toBe(prior.snapshot.reviewHistorySha256);
    expect(JSON.stringify(current)).not.toContain('Synthetic owner decision');
  });

  test.each([
    ['decision.reason', 'Synthetic correction'], ['source.direction', 'draft'],
    ['source.sourceSha256', 'c'.repeat(64)], ['confirmation', { revision: 0, reason: 'Synthetic confirmation' }],
    ['souvenirNoteId', '8'.repeat(24)], ['context', { revision: 1, inputHash: 'c'.repeat(64) }],
    ['relatedSources', [{ ...source, findingId: 'c'.repeat(64) }]],
    ['reviewHistory', [{ revision: 0, state: 'dismissed', reason: 'Synthetic history change' }]]
  ])('detects %s changes even without an assertion revision increment', async (path, value) => {
    const prior = await get();
    await Entry.updateOne({ _id: id }, { $set: { [path]: value } }, { timestamps: false });
    expect((await get({ expected: prior.fingerprint })).status).toBe('changed');
  });

  test('an unaccepted pending source intent changes state but is never an accepted decision', async () => {
    const first = await get();
    await Entry.updateOne({ _id: id }, { $set: { sourceReviews: [{ requestId: '00000000-0000-4000-8000-000000000001',
      entryRevision: 0, basisHash: 'a'.repeat(64), snapshot: { contract: 'synthetic', sources: [] }, snapshotHash: 'b'.repeat(64),
      coverage: [], decisionIntent: { intentHash: 'c'.repeat(64), inputHash: 'd'.repeat(64), input: {} } }] } }, { timestamps: false });
    const result = await get({ expected: first.fingerprint });
    expect(result.status).toBe('changed'); expect(result.snapshot.pendingSourceDecisions).toBe(1);
    expect(result.snapshot.reviewState).toBe('candidate');
    expect(result.executionAllowed).toBe(false);
  });

  test('the final native read includes an owner decision committed during the privacy lookup', async () => {
    const first = await get();
    jest.spyOn(privacy, 'forgottenSource').mockImplementationOnce(async () => {
      await history.review(id, { state: 'retained', revision: 0, reason: 'Synthetic concurrent review' }); return false;
    });
    const result = await get({ expected: first.fingerprint });
    expect(result.status).toBe('changed'); expect(result.snapshot).toMatchObject({ entryRevision: 1, reviewState: 'retained' });
  });

  test('explicit forgetting during the final privacy await cannot return old decisions', async () => {
    jest.spyOn(privacy, 'forgottenSource').mockImplementationOnce(async () => {
      await history.review(id, { state: 'forgotten', revision: 0 }); return false;
    });
    await expect(get()).rejects.toMatchObject({ statusCode: 404, code: 'HISTORY_DECISION_UNAVAILABLE' });
  });

  test('source-note erasure suppresses old decisions; missing and forgotten are equally unavailable', async () => {
    const noteId = '8'.repeat(24);
    await Entry.updateOne({ _id: id }, { $set: { 'source.personalNoteId': noteId } });
    await privacy.forgetSourceNote({ _id: noteId, text: 'Synthetic erased source' });
    await expect(get()).rejects.toMatchObject({ statusCode: 404 });
    id = '9'.repeat(24); await expect(get()).rejects.toMatchObject({ statusCode: 404 });
  });

  test.each([{ expected: ['a'.repeat(64)] }, { expected: '' }, { expected: 'invalid' },
    { source: 0 }, { audience: 'owner' }, { verified: true }, []])('refuses client proof or malformed fingerprints: %p', async input => {
    await expect(get(input)).rejects.toMatchObject({ statusCode: 400 });
  });

  test('server-selected family scope refuses before reading any entry', async () => {
    const read = jest.spyOn(Entry, 'findOne');
    await expect(state.get(id, {}, { audience: 'family' })).rejects.toMatchObject({ statusCode: 403 });
    expect(read).not.toHaveBeenCalled();
  });

  test('Mongo unavailability is an error, never a successful missing or unchanged decision', async () => {
    jest.spyOn(Entry, 'findOne').mockImplementationOnce(() => { throw new Error('Synthetic Mongo outage'); });
    await expect(get()).rejects.toThrow('Synthetic Mongo outage');
  });
});
