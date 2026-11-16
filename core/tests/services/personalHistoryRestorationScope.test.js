'use strict';

const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const preservation = require('../../src/services/personalHistoryPreservation');
const scope = require('../../src/services/personalHistoryRestorationScope');
const privacy = require('../../src/services/personalHistoryPrivacy');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { proof, source } = require('../fixtures/historyPreservationProof');

const native = (copy, input) => ({ ...proof(copy, input), contract: 'secretary.archive-restoration/v1',
  restoration: { sourceFilesSha256: '2'.repeat(64), restoredFilesSha256: '2'.repeat(64),
    filesCopied: 4, bytesCopied: 1500, temporaryCopyRemoved: true } });

describe('complete selected restoration scope', () => {
  let checks, deps, probe;
  const input = extra => ({ observationId: randomUUID(), checks, ...extra });
  beforeAll(async () => { await Entry.createCollection(); await Entry.createIndexes(); await Suppression.createCollection(); });
  beforeEach(async () => {
    await Entry.deleteMany({}); await Suppression.deleteMany({});
    probe = jest.fn(async (copy, request) => native(copy, request));
    deps = { audience: 'owner', control: { probeRestoration: probe, probe: (copy, request) => proof(copy, request) } };
    checks = [];
    for (const mid of ['1234567890abcde0', '1234567890abcde1']) {
      const reference = { ...source, messageId: mid };
      const entryId = (await history.record({ kind: 'fact', text: `Synthetic ${mid}`, sourceDate: '2024-01-01T00:00:00Z', source: reference })).entry.id;
      const requestId = randomUUID();
      const { receipt } = await preservation.prepare(entryId, { requestId, revision: 0, source: 0, verification: 'restoration' }, deps);
      checks.push({ entryId, requestId, snapshotHash: receipt.snapshotHash,
        source: Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(key => [key, reference[key]])) });
    }
    probe.mockClear();
  });
  afterEach(() => jest.restoreAllMocks());

  test('rechecks every exact retained source and returns no acceptance or new stored receipts', async () => {
    const result = await scope.observe(input(), deps);
    expect(result).toMatchObject({ authority: 'agentx.core', contract: scope.CONTRACT, status: 'observed',
      coverage: 'complete-selected-source-set', atomicBatch: false, semanticAcceptance: false,
      authenticatedPerson: null, executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS });
    expect(result.snapshot.sourceSetSha256).toBe(digest(checks.map(check => check.source)));
    expect(result.fingerprint).toBe(digest(result.snapshot));
    expect(result.snapshot.members.map(member => member.requestId)).toEqual(checks.map(check => check.requestId));
    expect(probe).toHaveBeenCalledTimes(4);
    expect(new Set(probe.mock.calls.map(call => call[1].requestId)).size).toBe(2);
    const again = await scope.observe(input({ checks: [...checks].reverse(), expected: result.fingerprint }), deps);
    expect(again.status).toBe('observed_match'); expect(again.fingerprint).toBe(result.fingerprint);
    expect(again.observationId).not.toBe(result.observationId);
    for (const row of await Entry.find({}).lean()) expect(row.preservationChecks).toHaveLength(1);
  });

  test.each([[], new Array(21).fill({}), [null], [{ entryId: 'invalid' }]].map(value => [value]))('invalid or empty selection refuses before native reads', async value => {
    await expect(scope.observe(input({ checks: value }), deps)).rejects.toMatchObject({ statusCode: 400 });
    expect(probe).not.toHaveBeenCalled();
  });
  test.each([
    value => ({ ...value, observationId: null }),
    value => ({ ...value, expected: ['a'.repeat(64)] }),
    value => ({ ...value, accepted: true }),
    value => ({ ...value, checks: [value.checks[0], value.checks[0]] }),
    value => ({ ...value, checks: [{ ...value.checks[0], requestId: 'wrong' }] }),
    value => ({ ...value, checks: [{ ...value.checks[0], source: { ...value.checks[0].source, approved: true } }] })
  ])('caller flags, duplicate messages and malformed identities cannot widen selection', async mutate => {
    await expect(scope.observe(mutate(input()), deps)).rejects.toMatchObject({ statusCode: 400 });
    expect(probe).not.toHaveBeenCalled();
  });
  test('family audience cannot initiate temporary restoration', async () => {
    await expect(scope.observe(input(), { ...deps, audience: 'family' })).rejects.toMatchObject({ statusCode: 403 });
    expect(probe).not.toHaveBeenCalled();
  });
  test.each(['snapshot', 'source', 'missing', 'revision', 'v1', 'blocked'])('unqualified retained %s refuses before any native reads', async kind => {
    const selected = checks[0];
    if (kind === 'snapshot') selected.snapshotHash = '0'.repeat(64);
    if (kind === 'source') selected.source.threadId = 'f'.repeat(16);
    if (kind === 'missing') selected.requestId = randomUUID();
    if (kind === 'revision') await Entry.updateOne({ _id: selected.entryId }, { $inc: { revision: 1 } });
    if (kind === 'v1' || kind === 'blocked') {
      const row = await Entry.findById(selected.entryId).lean(), check = row.preservationChecks[0];
      if (kind === 'v1') check.snapshot.contract = 'agentx.history-preservation/v1';
      else check.snapshot.status = 'blocked';
      check.snapshotHash = digest(check.snapshot); selected.snapshotHash = check.snapshotHash;
      await Entry.updateOne({ _id: selected.entryId }, { $set: { preservationChecks: [check] } });
    }
    await expect(scope.observe(input(), deps)).rejects.toMatchObject({ statusCode: 409 });
    expect(probe).not.toHaveBeenCalled();
  });
  test.each(['unavailable', 'stale', 'same-machine'])('native %s on a later message cannot yield partial success', async kind => {
    probe.mockImplementation(async (copy, request) => {
      if (request.messageId === checks[1].source.messageId) {
        if (kind === 'unavailable') throw new Error('Synthetic private path must not leak');
        const value = native(copy, request);
        if (kind === 'stale') value.restoration.sourceFilesSha256 = value.restoration.restoredFilesSha256 = '3'.repeat(64);
        if (kind === 'same-machine') value.machineIdSha256 = 'c'.repeat(64);
        return value;
      }
      return native(copy, request);
    });
    await expect(scope.observe(input(), deps)).rejects.toMatchObject({ statusCode: 409 });
  });
  test.each(['revision', 'erase', 'context', 'receipt', 'suppression'])('final fence catches earlier-member %s during a later native call', async kind => {
    let changed = false;
    probe.mockImplementation(async (copy, request) => {
      if (!changed && request.messageId === checks[1].source.messageId) {
        changed = true;
        const filter = { _id: checks[0].entryId };
        if (kind === 'revision') await Entry.updateOne(filter, { $inc: { revision: 1 } });
        if (kind === 'erase') await privacy.suppress(filter);
        if (kind === 'context') await Entry.updateOne(filter, { $set: { context: { revision: 1, inputHash: '4'.repeat(64) } } });
        if (kind === 'receipt') await Entry.updateOne(filter, { $set: { 'preservationChecks.0.snapshotHash': '0'.repeat(64) } });
        if (kind === 'suppression') {
          const row = await Entry.findById(checks[0].entryId).lean();
          await Suppression.create({ scope: 'owner', noteId: 'f'.repeat(24), contentHash: row.contentHash, forgottenAt: new Date() });
        }
      }
      return native(copy, request);
    });
    await expect(scope.observe(input(), deps)).rejects.toMatchObject({ statusCode: 409 });
  });
  test('source-note erasure is enforced before temporary native writes', async () => {
    const row = await Entry.findById(checks[0].entryId).lean();
    await Suppression.create({ scope: 'owner', noteId: 'f'.repeat(24), contentHash: row.contentHash, forgottenAt: new Date() });
    await expect(scope.observe(input(), deps)).rejects.toMatchObject({ statusCode: 409 });
    expect(probe).not.toHaveBeenCalled();
  });
  test('oversized member is refused by the database projection before materialization', async () => {
    await Entry.updateOne({ _id: checks[0].entryId }, { $set: { text: 'x'.repeat(600 * 1024) } });
    await expect(scope.observe(input(), deps)).rejects.toMatchObject({ statusCode: 413 });
    expect(probe).not.toHaveBeenCalled();
  });
  test('expected fingerprint mismatch stays changed, never observed_match', async () => {
    expect((await scope.observe(input({ expected: '0'.repeat(64) }), deps)).status).toBe('changed');
  });
  test('individually current receipts on different archive pairs cannot form a global scope', async () => {
    probe.mockImplementation(async (copy, request) => {
      const value = native(copy, request);
      if (request.messageId === checks[1].source.messageId) value.archiveIdSha256 = '9'.repeat(64);
      return value;
    });
    const row = await Entry.findById(checks[1].entryId).lean(), check = row.preservationChecks[0];
    for (const copy of check.snapshot.copies) copy.archiveIdSha256 = '9'.repeat(64);
    check.snapshotHash = digest(check.snapshot); checks[1].snapshotHash = check.snapshotHash;
    await Entry.updateOne({ _id: row._id }, { $set: { preservationChecks: [check] } });
    await expect(scope.observe(input(), deps)).rejects.toMatchObject({ statusCode: 409 });
  });
});
