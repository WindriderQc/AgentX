'use strict';
jest.mock('../../src/services/memoryNoteIndex', () => ({ createIndex: () => ({ indexNote: async () => false }) }));
jest.mock('../../src/services/souvenirRecallSync', () => ({ scheduleSouvenirRecallSync: jest.fn() }));
const express = require('express');
const request = require('supertest');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const Confirmation = require('../../models/PersonalHistoryManifestConfirmation');
const history = require('../../src/services/personalHistoryService');
const preservation = require('../../src/services/personalHistoryPreservation');
const privacy = require('../../src/services/personalHistoryPrivacy');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { manifestArchive } = require('../fixtures/historyReviewManifestArchive');
const URL = '/api/secretary/history/manifest-confirmations';

(process.platform === 'win32' ? describe.skip : describe)('real native human manifest confirmation without mailbox authority', () => {
  let fixture, app, id, noteId, checks;
  const selected = () => ({ checks, before: '2026-01-01T00:00:00.000Z' });
  const prepare = key => request(app).post(URL).send({ requestId: key, ...selected() });
  const confirm = (key, value) => request(app).post(`${URL}/${key}/confirm`).send({ ...selected(),
    bindingSha256: value.bindingSha256, confirmation: 'reviewed_selected_manifest' });
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression, Confirmation]) {
    await model.createCollection(); await model.createIndexes();
  } });
  beforeEach(async () => {
    for (const model of [Entry, MemoryNote, Suppression, Confirmation]) await model.deleteMany({});
    fixture = await manifestArchive();
    id = (await history.record({ kind: 'fact', text: 'Synthetic human selected manifest', sourceDate: null, source: fixture.source })).entry.id;
    noteId = (await history.keepAsSouvenir(id, { revision: 0 })).souvenirNoteId;
    const receipt = (await preservation.prepare(id, { requestId: randomUUID(), revision: 1, source: 0, verification: 'review-restoration' },
      { audience: 'owner', control: fixture.control })).receipt;
    const source = Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(k => [k, fixture.source[k]]));
    checks = [{ entryId: id, requestId: receipt.requestId, snapshotHash: receipt.snapshotHash, source }];
    app = express(); const router = express.Router(); app.use(express.json());
    registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience: 'owner', control: fixture.findings },
      preservationDeps: { audience: 'owner', control: fixture.control }, mailboxScopeDeps: { audience: 'owner', control: fixture.mailbox },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router);
  });
  afterEach(async () => { jest.restoreAllMocks(); await fixture.cleanup(); });
  const noCopies = async () => {
    expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
    expect((await Entry.db.db.listCollections().toArray()).filter(row => row.name.startsWith('__agentx_core_restore_'))).toEqual([]);
  };

  test('prepares and confirms the same native archive/provider/Core graph; canonical data stays unchanged', async () => {
    const entryBefore = await Entry.findById(id).lean(), noteBefore = await MemoryNote.findById(noteId).lean(), key = randomUUID();
    const preparedResponse = await prepare(key).expect(200), prepared = preparedResponse.body.data;
    expect(preparedResponse.headers['cache-control']).toBe('private, no-store');
    expect(prepared).toMatchObject({ state: 'prepared', nativeState: 'observed',
      preview: { manifest: { contract: 'agentx.history-review-manifest/v1' },
        coreRestoration: { contract: 'agentx.history-core-restoration/v1', restoration: { temporaryCopyRemoved: true } } } });
    expect(digest(prepared.preview.manifest)).toBe(prepared.manifestSha256);
    expect(digest(prepared.preview.coreRestoration)).toBe(prepared.coreRestorationSha256);
    const confirmed = (await confirm(key, prepared).expect(200)).body.data;
    expect(confirmed).toMatchObject({ state: 'confirmed', bindingSha256: prepared.bindingSha256,
      authenticatedPerson: null, recordedVia: 'private_lan_surface', semanticAcceptance: false, approvalBound: false,
      executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS, mailboxEffects: 0 });
    expect(confirmed.preview).toBeUndefined();
    expect(await Entry.findById(id).lean()).toEqual(entryBefore);
    expect(await MemoryNote.findById(noteId).lean()).toEqual(noteBefore);
    const stored = await Confirmation.findById(digest(key)).lean();
    expect(JSON.stringify(stored)).not.toMatch(/Synthetic|messageId|threadId|sourceSha256|checks|snapshot|preview/);
    const calls = fixture.mailboxCalls.length;
    expect((await confirm(key, prepared).expect(200)).body.data.state).toBe('confirmed');
    expect(fixture.mailboxCalls).toHaveLength(calls); await noCopies();
  });

  test.each(['body', 'vector'])('a %s edit without revision change blocks the original exact confirmation', async kind => {
    const key = randomUUID(), prepared = (await prepare(key).expect(200)).body.data;
    if (kind === 'body') await Entry.collection.updateOne({ _id: entryId() }, { $set: { syntheticUnversionedBody: 'changed synthetic source' } });
    else await MemoryNote.collection.updateOne({ _id: new Entry.base.Types.ObjectId(noteId) }, { $set: { embedding: [0.5] } });
    const result = (await confirm(key, prepared).expect(200)).body.data;
    expect(result).toMatchObject({ state: 'blocked', blockedCode: 'evidence_changed', bindingSha256: prepared.bindingSha256 });
    expect((await Confirmation.findById(digest(key)).lean()).confirmedAt).toBeNull(); await noCopies();
  });
  const entryId = () => new Entry.base.Types.ObjectId(id);

  test('forgetting during preparation storage acknowledgement cannot release the old private preview', async () => {
    const original = Confirmation.findOneAndUpdate.bind(Confirmation), key = randomUUID();
    jest.spyOn(Confirmation, 'findOneAndUpdate').mockImplementation((...args) => {
      const query = original(...args), lean = query.lean.bind(query);
      query.lean = async () => { const row = await lean();
        if (args[1].$set.state === 'prepared') await privacy.suppress({ _id: entryId() }); return row; };
      return query;
    });
    const response = await prepare(key).expect(409);
    expect(response.body.data).toBeUndefined();
    const retained = (await request(app).get(`${URL}/${key}`).expect(200)).body.data;
    expect(retained.state).toBe('prepared'); expect(retained.preview).toBeUndefined();
    expect(JSON.stringify(retained)).not.toMatch(/Synthetic|messageId|threadId/); await noCopies();
  });

  test('a forgotten source refuses fresh confirmation but keeps only its opaque historical intent', async () => {
    const key = randomUUID(), prepared = (await prepare(key).expect(200)).body.data;
    await privacy.suppress({ _id: entryId() });
    const result = (await confirm(key, prepared).expect(200)).body.data;
    expect(result.state).toBe('blocked'); expect(result.confirmedAt).toBeNull(); expect(result.preview).toBeUndefined();
    await noCopies();
  });
});
