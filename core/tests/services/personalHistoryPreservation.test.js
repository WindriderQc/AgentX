'use strict';

const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const checks = require('../../src/services/personalHistoryPreservation');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');

const { proof, source } = require('../fixtures/historyPreservationProof');

describe('native exact-source preservation receipts', () => {
  let id, deps, probe;
  const prepare = (requestId = randomUUID(), extra = {}) => checks.prepare(id, { requestId, revision: 0, source: 0, ...extra }, deps);
  beforeAll(async () => { await Entry.createCollection(); await Entry.createIndexes(); await Suppression.createCollection(); });
  beforeEach(async () => {
    await Entry.deleteMany({}); await MemoryNote.deleteMany({}); await Suppression.deleteMany({});
    id = (await history.record({ kind: 'fact', text: 'Synthetic historical assertion', sourceDate: '2024-01-01T00:00:00Z', source })).entry.id;
    probe = jest.fn(async (copy, input) => proof(copy, input)); deps = { audience: 'owner', control: { probe } };
  });

  test('derives exact native identities from Core, stores one bounded receipt and never grants cleanup', async () => {
    const key = randomUUID(), first = await prepare(key), receipt = first.receipt;
    expect(receipt.snapshot.status).toBe('verified_scope');
    expect(receipt).toMatchObject({ requestId: key, entryRevision: 0, nativeState: 'observed', entryCurrent: true,
      executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS });
    expect(receipt.observationId).not.toBe(key);
    for (const [copy, input] of probe.mock.calls) {
      expect(['primary', 'mirror']).toContain(copy);
      expect(input).toEqual({ requestId: receipt.observationId, messageId: source.messageId,
        threadId: source.threadId, sourceSha256: source.sourceSha256 });
    }
    const replay = await prepare(key);
    expect(replay.replayed).toBe(true); expect(probe).toHaveBeenCalledTimes(2);
    expect(replay.receipt.snapshotHash).toBe(receipt.snapshotHash);
    expect((await Entry.findById(id).lean()).preservationChecks).toHaveLength(1);
    expect((await checks.list(id, deps)).receipts).toHaveLength(1);
    await expect(prepare(key, { source: 1 })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('fresh reads use a new server nonce and an outage cannot return an old current proof', async () => {
    const { receipt } = await prepare();
    expect((await checks.get(id, receipt.requestId, deps)).receipt.nativeState).toBe('current');
    expect(probe.mock.calls[2][1].requestId).not.toBe(receipt.observationId);
    probe.mockRejectedValue(Object.assign(new Error('private host path must not leak'), { code: 'BAD PRIVATE PATH' }));
    const unavailable = await checks.get(id, receipt.requestId, deps);
    expect(unavailable.receipt.nativeState).toBe('unknown');
    expect(JSON.stringify(unavailable)).not.toContain('private host path');
    expect((await Entry.findById(id).lean()).preservationChecks[0].snapshotHash).toBe(receipt.snapshotHash);
  });

  test('the same machine under two roots is not independent, even with identical bytes', async () => {
    probe.mockImplementation(async (copy, input) => ({ ...proof(copy, input), machineIdSha256: 'c'.repeat(64),
      archiveIdSha256: (copy === 'primary' ? 'e' : 'f').repeat(64) }));
    const { receipt } = await prepare();
    expect(receipt.snapshot).toMatchObject({ status: 'blocked', blockers: ['native_copies_on_same_machine'] });
  });

  test('copy metadata or attachment differences stay blocked; a later change never rewrites old proof', async () => {
    const { receipt } = await prepare();
    probe.mockImplementation(async (copy, input) => ({ ...proof(copy, input),
      metadataSha256: (copy === 'mirror' ? '2' : '1').repeat(64) }));
    expect((await checks.get(id, receipt.requestId, deps)).receipt.nativeState).toBe('stale');
    expect((await prepare()).receipt.snapshot.blockers).toContain('native_copy_content_mismatch');
    probe.mockImplementation(async (copy, input) => ({ ...proof(copy, input),
      attachments: [{ partId: '1', sha256: (copy === 'mirror' ? '3' : 'f').repeat(64), bytes: 20 }] }));
    expect((await prepare()).receipt.snapshot.blockers).toContain('native_copy_content_mismatch');
    expect((await Entry.findById(id).lean()).preservationChecks[0].snapshotHash).toBe(receipt.snapshotHash);
  });

  test.each([
    value => ({ ...value, requestId: randomUUID() }),
    value => ({ ...value, threadId: '0123456789abcdef' }),
    value => ({ ...value, sourceSha256: '0'.repeat(64) }),
    value => ({ ...value, raw: { ...value.raw, bytes: true } }),
    value => ({ ...value, partsDecoded: 0 }),
    value => ({ ...value, attachmentsDecoded: 0 }),
    value => ({ ...value, attachments: [...value.attachments, ...value.attachments] }),
    value => ({ ...value, attachments: [{ ...value.attachments[0], bytes: 16 * 1024 * 1024 }] }),
    value => ({ ...value, verified: true }),
    value => ({ ...value, machineIdSha256: ['c'.repeat(64)] }),
    value => ({ ...value, archiveIdSha256: [value.archiveIdSha256] }),
    value => ({ ...value, metadataSha256: [value.metadataSha256] }),
    value => ({ ...value, attachments: [{ ...value.attachments[0], sha256: [value.attachments[0].sha256] }] }),
  ])('malformed, stale or forged native responses cannot produce verified_scope', async mutate => {
    probe.mockImplementation(async (copy, input) => mutate(proof(copy, input)));
    expect((await prepare()).receipt.snapshot).toMatchObject({ status: 'blocked', blockers: ['native_copy_unavailable'] });
  });

  test('caller-supplied proof/host/flags and family audience refuse before a native read', async () => {
    for (const extra of [{ verified: true }, { host: 'other' }, { snapshot: {} }, { revision: true }, { source: -1 }]) {
      await expect(prepare(randomUUID(), extra)).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(checks.prepare(id, { requestId: randomUUID(), revision: 0, source: 0 }, { ...deps, audience: 'family' }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(probe).not.toHaveBeenCalled();
  });

  test('a changed assertion revision refuses late receipt creation', async () => {
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    probe.mockImplementation(async (copy, input) => { await barrier; return proof(copy, input); });
    const pending = prepare();
    while (probe.mock.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
    await history.review(id, { revision: 0, state: 'dismissed', reason: 'Synthetic newer decision' });
    release(); await expect(pending).rejects.toMatchObject({ statusCode: 409 });
    expect((await Entry.findById(id).lean()).preservationChecks).toHaveLength(0);
  });

  test('a context version change fences a native read even without changing the assertion revision', async () => {
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    probe.mockImplementation(async (copy, input) => { await barrier; return proof(copy, input); });
    const pending = prepare();
    while (probe.mock.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
    await Entry.updateOne({ _id: id }, { $set: { context: { revision: 1, inputHash: '5'.repeat(64) } } });
    release(); await expect(pending).rejects.toMatchObject({ statusCode: 409 });
    expect((await Entry.findById(id).lean()).preservationChecks).toHaveLength(0);
  });

  test('the selected original does not broaden to other messages in its thread or related sources', async () => {
    const newer = { ...source, messageId: '1234567890abcdff', sourceSha256: '5'.repeat(64), findingId: '6'.repeat(64) };
    await Entry.updateOne({ _id: id }, { $set: { relatedSources: [newer] } });
    await prepare();
    expect(probe.mock.calls.map(call => call[1].messageId)).toEqual([source.messageId, source.messageId]);
    expect(probe.mock.calls.map(call => call[1].sourceSha256)).toEqual([source.sourceSha256, source.sourceSha256]);
  });

  test('a stored proof integrity failure refuses before contacting a native reader', async () => {
    const { receipt } = await prepare();
    await Entry.updateOne({ _id: id }, { $set: { 'preservationChecks.0.snapshot.copies.0.content.raw.bytes': 999 } });
    probe.mockClear();
    await expect(checks.get(id, receipt.requestId, deps)).rejects.toMatchObject({ code: 'HISTORY_PRESERVATION_INTEGRITY' });
    expect(probe).not.toHaveBeenCalled();
  });

  test('source-note erasure uses the same native-proof erasure boundary', async () => {
    const noteId = '7'.repeat(24);
    await Entry.updateOne({ _id: id }, { $set: { 'source.personalNoteId': noteId } });
    const { receipt } = await prepare();
    await require('../../src/services/personalHistoryPrivacy').forgetSourceNote({ _id: noteId, text: 'Synthetic source note' });
    expect((await Entry.findById(id).lean()).preservationChecks).toEqual([]);
    expect(await checks.get(id, receipt.requestId, deps)).toEqual({ erased: true, requestId: receipt.requestId, executionAllowed: false });
  });

  test('a lost Mongo acknowledgment reconciles the original receipt without another write', async () => {
    const original = Entry.findOneAndUpdate.bind(Entry);
    const spy = jest.spyOn(Entry, 'findOneAndUpdate').mockImplementationOnce((...args) => ({ lean: async () => {
      await original(...args).lean(); throw new Error('Synthetic lost acknowledgement');
    } }));
    const key = randomUUID();
    await expect(prepare(key)).rejects.toThrow('Synthetic lost acknowledgement'); spy.mockRestore();
    expect((await checks.get(id, key, deps)).receipt.nativeState).toBe('current');
    expect((await prepare(key)).replayed).toBe(true);
    expect((await Entry.findById(id).lean()).preservationChecks).toHaveLength(1);
  });

  test('concurrent identical intents keep only the winning immutable receipt; another assertion cannot reuse its UUID', async () => {
    const key = randomUUID(), [a, b] = await Promise.all([prepare(key), prepare(key)]);
    expect(a.receipt.snapshotHash).toBe(b.receipt.snapshotHash);
    expect((await Entry.findById(id).lean()).preservationChecks).toHaveLength(1);
    const other = (await history.record({ kind: 'fact', text: 'Another assertion', sourceDate: '2024-01-01T00:00:00Z',
      source: { ...source, findingId: '4'.repeat(64) } })).entry.id;
    await expect(checks.prepare(other, { requestId: key, revision: 0, source: 0 }, deps)).rejects.toMatchObject({ statusCode: 409 });
  });

  test('receipt capacity preserves earlier receipts and prevents a 21st native launch', async () => {
    for (let i = 0; i < 20; i++) await prepare();
    probe.mockClear(); await expect(prepare()).rejects.toMatchObject({ code: 'HISTORY_PRESERVATION_CAPACITY' });
    expect(probe).not.toHaveBeenCalled(); expect((await Entry.findById(id).lean()).preservationChecks).toHaveLength(20);
  });

  test('forgetting clears native receipts and retains only an opaque same-intent erasure acknowledgment', async () => {
    const { receipt } = await prepare();
    await history.review(id, { revision: 0, state: 'forgotten' });
    const row = await Entry.findById(id).lean();
    expect(row.preservationChecks).toEqual([]); expect(row.preservationRequestKeys).toHaveLength(1);
    expect(JSON.stringify(row.preservationRequestKeys)).not.toContain(source.messageId);
    expect(await checks.get(id, receipt.requestId, deps)).toEqual({ erased: true, requestId: receipt.requestId, executionAllowed: false });
    await expect(checks.get(id, randomUUID(), deps)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('forgetting during the last native read prevents any late content or receipt', async () => {
    const { receipt } = await prepare();
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    probe.mockClear().mockImplementation(async (copy, input) => { await barrier; return proof(copy, input); });
    const pending = checks.get(id, receipt.requestId, deps);
    while (probe.mock.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
    await history.review(id, { revision: 0, state: 'forgotten' });
    release(); await expect(pending).rejects.toMatchObject({ statusCode: 404 });
    expect((await Entry.findById(id).lean()).preservationChecks).toEqual([]);
  });

  test.each(['prepare', 'get'])('forgetting during the final privacy lookup prevents late %s output', async operation => {
    const key = randomUUID();
    if (operation === 'get') await prepare(key);
    const privacy = require('../../src/services/personalHistoryPrivacy');
    const original = privacy.forgottenSource;
    let calls = 0;
    const spy = jest.spyOn(privacy, 'forgottenSource').mockImplementation(async input => {
      const result = await original(input);
      if (++calls === 2) await history.review(id, { revision: 0, state: 'forgotten' });
      return result;
    });
    try {
      await expect(operation === 'get' ? checks.get(id, key, deps) : prepare(key)).rejects.toMatchObject({ statusCode: 404 });
      expect((await Entry.findById(id).lean()).preservationChecks).toEqual([]);
    } finally { spy.mockRestore(); }
  });
});
