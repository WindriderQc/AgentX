'use strict';

const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const checks = require('../../src/services/personalHistoryPreservation');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { proof, source } = require('../fixtures/historyPreservationProof');

const restored = (copy, input) => ({ ...proof(copy, input), contract: 'secretary.archive-restoration/v1',
  restoration: { sourceFilesSha256: '2'.repeat(64), restoredFilesSha256: '2'.repeat(64),
    filesCopied: 4, bytesCopied: 1500, temporaryCopyRemoved: true } });

describe('native selected-source disk restoration receipts', () => {
  let id, deps, probeRestoration, probe;
  const prepare = (key = randomUUID(), extra = {}) => checks.prepare(id,
    { requestId: key, revision: 0, source: 0, verification: 'restoration', ...extra }, deps);
  beforeAll(async () => { await Entry.createCollection(); await Entry.createIndexes(); await Suppression.createCollection(); });
  beforeEach(async () => {
    await Entry.deleteMany({}); await Suppression.deleteMany({});
    id = (await history.record({ kind: 'fact', text: 'Synthetic restoration assertion', sourceDate: '2024-01-01T00:00:00Z', source })).entry.id;
    probeRestoration = jest.fn(async (copy, input) => restored(copy, input)); probe = jest.fn();
    deps = { audience: 'owner', control: { probeRestoration, probe } };
  });

  test('retains native disk-reopen evidence separately from frozen v1 without granting acceptance', async () => {
    const key = randomUUID(), { receipt } = await prepare(key);
    expect(receipt).toMatchObject({ verification: 'restoration', nativeState: 'observed',
      executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS,
      snapshot: { contract: 'agentx.history-preservation/v2', status: 'verified_scope' } });
    expect(probe).not.toHaveBeenCalled(); expect(probeRestoration).toHaveBeenCalledTimes(2);
    expect(receipt.observationId).not.toBe(key);
    for (const copy of receipt.snapshot.copies) expect(copy.restoration).toEqual(restored('primary', { ...source, requestId: key }).restoration);
    const replay = await prepare(key);
    expect(replay.replayed).toBe(true); expect(replay.receipt.snapshotHash).toBe(receipt.snapshotHash);
    expect(probeRestoration).toHaveBeenCalledTimes(2);
    expect((await checks.list(id, deps)).receipts[0].verification).toBe('restoration');
    await expect(prepare(key, { verification: 'preservation' })).rejects.toMatchObject({ statusCode: 409 });
    expect((await Entry.findById(id).lean()).preservationChecks).toHaveLength(1);
  });

  test('a frozen v1 UUID cannot be upgraded or relabeled as disk restoration', async () => {
    const key = randomUUID(); probe.mockImplementation(async (copy, input) => proof(copy, input));
    const first = await prepare(key, { verification: 'preservation' });
    await expect(prepare(key)).rejects.toMatchObject({ statusCode: 409 });
    expect(first.receipt.snapshot.contract).toBe('agentx.history-preservation/v1');
    expect(probeRestoration).not.toHaveBeenCalled();
    expect((await checks.get(id, key, deps)).receipt.verification).toBe('preservation');
    expect(probeRestoration).not.toHaveBeenCalled();
  });

  test('GET selects the retained restoration contract and uses a fresh server nonce', async () => {
    const { receipt } = await prepare();
    expect((await checks.get(id, receipt.requestId, deps)).receipt.nativeState).toBe('current');
    expect(probeRestoration.mock.calls[2][1].requestId).not.toBe(receipt.observationId);
    expect(probe).not.toHaveBeenCalled();
    probeRestoration.mockImplementation(async (copy, input) => ({ ...restored(copy, input), restoration: {
      ...restored(copy, input).restoration, sourceFilesSha256: '3'.repeat(64), restoredFilesSha256: '3'.repeat(64) } }));
    expect((await checks.get(id, receipt.requestId, deps)).receipt.nativeState).toBe('stale');
    expect((await Entry.findById(id).lean()).preservationChecks[0].snapshotHash).toBe(receipt.snapshotHash);
  });

  test('an unavailable restoration command never downgrades to byte-only preservation', async () => {
    delete deps.control.probeRestoration;
    expect((await prepare()).receipt.snapshot).toMatchObject({ status: 'blocked', blockers: ['native_copy_unavailable'] });
    expect(probe).not.toHaveBeenCalled();
  });

  test.each([
    value => ({ ...value, contract: 'secretary.archive-preservation/v1' }),
    value => ({ ...value, requestId: randomUUID() }),
    value => ({ ...value, restoration: undefined }),
    value => ({ ...value, restoration: { ...value.restoration, sourceFilesSha256: ['2'.repeat(64)] } }),
    value => ({ ...value, restoration: { ...value.restoration, restoredFilesSha256: '3'.repeat(64) } }),
    value => ({ ...value, restoration: { ...value.restoration, temporaryCopyRemoved: false } }),
    value => ({ ...value, restoration: { ...value.restoration, temporaryCopyRemoved: 'true' } }),
    value => ({ ...value, restoration: { ...value.restoration, filesCopied: true } }),
    value => ({ ...value, restoration: { ...value.restoration, filesCopied: 2 } }),
    value => ({ ...value, restoration: { ...value.restoration, filesCopied: 5 } }),
    value => ({ ...value, restoration: { ...value.restoration, bytesCopied: 999 } }),
    value => ({ ...value, restoration: { ...value.restoration, bytesCopied: 16 * 1024 * 1024 + 1 } }),
    value => ({ ...value, restoration: { ...value.restoration, path: '/private/never-return' } }),
    value => ({ ...value, verified: true }),
  ])('incomplete or forged restoration evidence cannot create a verified receipt', async mutate => {
    probeRestoration.mockImplementation(async (copy, input) => mutate(restored(copy, input)));
    const result = await prepare();
    expect(result.receipt.snapshot).toMatchObject({ status: 'blocked', blockers: ['native_copy_unavailable'] });
    expect(JSON.stringify(result)).not.toContain('/private/never-return');
    expect(probe).not.toHaveBeenCalled();
  });

  test('both native restoration results must still be on distinct machines and the same selected bytes', async () => {
    probeRestoration.mockImplementation(async (copy, input) => ({ ...restored(copy, input), machineIdSha256: 'c'.repeat(64) }));
    expect((await prepare()).receipt.snapshot.blockers).toContain('native_copies_on_same_machine');
    probeRestoration.mockImplementation(async (copy, input) => ({ ...restored(copy, input),
      metadataSha256: (copy === 'primary' ? '1' : '3').repeat(64) }));
    expect((await prepare()).receipt.snapshot.blockers).toContain('native_copy_content_mismatch');
  });

  test('family scope and client proof/configuration refuse before any disk probe', async () => {
    for (const extra of [{ verification: true }, { verification: null }, { verification: 'restore' },
      { restoration: {} }, { directory: '/private' }, { verified: true }]) {
      await expect(prepare(randomUUID(), extra)).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(checks.prepare(id, { requestId: randomUUID(), revision: 0, source: 0, verification: 'restoration' },
      { ...deps, audience: 'family' })).rejects.toMatchObject({ statusCode: 403 });
    expect(probeRestoration).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  test('lost storage acknowledgment replays the same disk-probe receipt without a second write', async () => {
    const original = Entry.findOneAndUpdate.bind(Entry), key = randomUUID();
    const spy = jest.spyOn(Entry, 'findOneAndUpdate').mockImplementationOnce((...args) => ({ lean: async () => {
      await original(...args).lean(); throw new Error('Synthetic lost acknowledgment');
    } }));
    try { await expect(prepare(key)).rejects.toThrow('Synthetic lost acknowledgment'); } finally { spy.mockRestore(); }
    expect((await prepare(key)).replayed).toBe(true); expect(probeRestoration).toHaveBeenCalledTimes(2);
    expect((await checks.get(id, key, deps)).receipt.nativeState).toBe('current');
    expect((await Entry.findById(id).lean()).preservationChecks).toHaveLength(1);
  });

  test('racing different modes under one UUID retain exactly one mode and reject the other intent', async () => {
    const key = randomUUID(); probe.mockImplementation(async (copy, input) => proof(copy, input));
    const outcomes = await Promise.allSettled([prepare(key), prepare(key, { verification: 'preservation' })]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(result => result.status === 'rejected').reason.statusCode).toBe(409);
    const row = await Entry.findById(id).lean(); expect(row.preservationChecks).toHaveLength(1);
    expect((await checks.list(id, deps)).receipts[0].verification).toBe(outcomes.find(result => result.status === 'fulfilled').value.receipt.verification);
  });

  test.each(['prepare', 'get'])('forgetting during disk probes fences late %s output and retains only the opaque UUID key', async operation => {
    const key = randomUUID();
    if (operation === 'get') await prepare(key);
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    probeRestoration.mockClear().mockImplementation(async (copy, input) => { await barrier; return restored(copy, input); });
    const pending = operation === 'get' ? checks.get(id, key, deps) : prepare(key);
    while (probeRestoration.mock.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
    await history.review(id, { revision: 0, state: 'forgotten' });
    release(); await expect(pending).rejects.toMatchObject({ statusCode: 404 });
    expect((await Entry.findById(id).lean()).preservationChecks).toEqual([]);
    if (operation === 'get') expect(await checks.get(id, key, deps)).toEqual({ erased: true, requestId: key, executionAllowed: false });
  });
});
