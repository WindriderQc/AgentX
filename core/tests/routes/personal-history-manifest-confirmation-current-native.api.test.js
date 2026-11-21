'use strict';
jest.mock('../../src/services/memoryNoteIndex', () => ({ createIndex: () => ({ indexNote: async () => false }) }));
jest.mock('../../src/services/souvenirRecallSync', () => ({ scheduleSouvenirRecallSync: jest.fn() }));
const express = require('express');
const request = require('supertest');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const Confirmation = require('../../models/PersonalHistoryManifestConfirmation');
const history = require('../../src/services/personalHistoryService');
const preservation = require('../../src/services/personalHistoryPreservation');
const privacy = require('../../src/services/personalHistoryPrivacy');
const confirmations = require('../../src/services/personalHistoryManifestConfirmation');
const evidence = require('../../src/services/personalHistoryManifestConfirmationEvidence');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { manifestArchive } = require('../fixtures/historyReviewManifestArchive');
const BASE = '/api/secretary/history/manifest-confirmations';

(process.platform === 'win32' ? describe.skip : describe)('real current native human confirmation and private Python consumer', () => {
  let fixture, app, id, noteId, checks;
  const ref = () => Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(k => [k, fixture.source[k]]));
  const selected = () => ({ checks, before: '2026-01-01T00:00:00.000Z' });
  const observe = (key, extra) => request(app).post(`${BASE}/${key}/current`).send({ ...selected(), observationId: randomUUID(), ...extra });
  async function human() {
    const key = randomUUID();
    const prepared = (await request(app).post(BASE).send({ requestId: key, ...selected() }).expect(200)).body.data;
    const receipt = (await request(app).post(`${BASE}/${key}/confirm`).send({ ...selected(),
      bindingSha256: prepared.bindingSha256, confirmation: 'reviewed_selected_manifest' }).expect(200)).body.data;
    expect(receipt.state).toBe('confirmed'); return { key, prepared, receipt };
  }
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression, Confirmation]) {
    await model.createCollection(); await model.createIndexes();
  } });
  beforeEach(async () => {
    for (const model of [Entry, MemoryNote, Suppression, Confirmation]) await model.deleteMany({});
    fixture = await manifestArchive();
    id = (await history.record({ kind: 'fact', text: 'Synthetic current human receipt source', sourceDate: null, source: fixture.source })).entry.id;
    noteId = (await history.keepAsSouvenir(id, { revision: 0 })).souvenirNoteId;
    const receipt = (await preservation.prepare(id, { requestId: randomUUID(), revision: 1, source: 0, verification: 'review-restoration' },
      { audience: 'owner', control: fixture.control })).receipt;
    checks = [{ entryId: id, requestId: receipt.requestId, snapshotHash: receipt.snapshotHash, source: ref() }];
    app = express(); const router = express.Router(); app.use(express.json());
    registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience: 'owner', control: fixture.findings },
      preservationDeps: { audience: 'owner', control: fixture.control }, mailboxScopeDeps: { audience: 'owner', control: fixture.mailbox },
      envelope: (res, data) => res.json({ ok: true, status: 'success', data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, status: 'error', message, code }) });
    app.use('/api/secretary', router);
  });
  afterEach(async () => { jest.restoreAllMocks(); await fixture.cleanup(); });
  const noCopies = async () => {
    expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
    expect((await Entry.db.db.listCollections().toArray()).filter(row => row.name.startsWith('__agentx_core_restore_'))).toEqual([]);
  };

  test('fresh exact observations retain the historical human receipt and source data unchanged', async () => {
    const { key, receipt } = await human();
    const before = await Confirmation.findById(digest(key)).lean(), entry = await Entry.findById(id).lean();
    const response = await observe(key).expect(200), first = response.body.data;
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(first).toMatchObject({ status: 'observed', snapshot: { confirmationStatus: 'current', selectedMessages: 1,
      confirmation: { requestId: key, bindingSha256: receipt.bindingSha256, confirmedAt: receipt.confirmedAt },
      current: { bindingSha256: receipt.bindingSha256 } }, nativeValidationGaps: GAPS,
      approvalBound: false, executionAllowed: false, semanticAcceptance: false, authenticatedPerson: null, mailboxEffects: 0 });
    const second = (await observe(key, { expected: first.fingerprint }).expect(200)).body.data;
    expect(second.status).toBe('observed_match'); expect(second.snapshot).toEqual(first.snapshot);
    expect(second.observationId).not.toBe(first.observationId);
    expect(await Confirmation.findById(digest(key)).lean()).toEqual(before);
    expect(await Entry.findById(id).lean()).toEqual(entry); expect(await Confirmation.countDocuments()).toBe(1);
    expect(JSON.stringify(first)).not.toContain(fixture.source.messageId);
    expect(JSON.stringify(first)).not.toMatch(/Synthetic|reviewPacket|preview|sourceSha256/); await noCopies();
  }, 120000);

  test('a full unversioned source edit changes current binding without changing the original confirmation', async () => {
    const { key, receipt } = await human(), before = await Confirmation.findById(digest(key)).lean();
    await Entry.collection.updateOne({ _id: new Entry.base.Types.ObjectId(id) }, { $set: { syntheticUnversionedBody: 'changed synthetic body' } });
    const value = (await observe(key, { expected: receipt.bindingSha256 }).expect(200)).body.data;
    expect(value.snapshot.confirmationStatus).toBe('changed');
    expect(value.snapshot.confirmation.bindingSha256).toBe(receipt.bindingSha256);
    expect(value.snapshot.current.bindingSha256).not.toBe(receipt.bindingSha256);
    expect(value.approvalBound).toBe(false); expect(value.executionAllowed).toBe(false);
    expect(await Confirmation.findById(digest(key)).lean()).toEqual(before); await noCopies();
  }, 120000);

  test('a real legacy mirror409 becomes unavailable; recovery preserves the same confirmed identity', async () => {
    const { key, receipt } = await human(), before = await Confirmation.findById(digest(key)).lean();
    const original = fixture.control.probeReviewRestoration.bind(fixture.control);
    fixture.control.probeReviewRestoration = (copy, input) => {
      if (copy === 'mirror') throw new Error('Synthetic unavailable native mirror'); return original(copy, input);
    };
    const failed = await observe(key).expect(503);
    expect(failed.body.data).toBeUndefined(); expect(failed.body.code).toBe('HISTORY_MANIFEST_CONFIRMATION_CURRENT_UNAVAILABLE');
    expect(await Confirmation.findById(digest(key)).lean()).toEqual(before);
    fixture.control.probeReviewRestoration = original;
    const recovered = (await observe(key).expect(200)).body.data;
    expect(recovered.snapshot).toMatchObject({ confirmationStatus: 'current', confirmation: { requestId: key, bindingSha256: receipt.bindingSha256 } });
    await noCopies();
  }, 120000);

  test('late source erasure during the final receipt read cannot release a currency claim', async () => {
    const { key } = await human(), original = confirmations.get; let calls = 0;
    jest.spyOn(confirmations, 'get').mockImplementation(async (...args) => {
      const value = await original(...args);
      if (++calls === 2) await privacy.suppress({ _id: id }); return value;
    });
    const failed = await observe(key).expect(503);
    expect(failed.body.data).toBeUndefined(); expect(calls).toBe(2);
    expect((await Confirmation.findById(digest(key)).lean()).state).toBe('confirmed'); await noCopies();
  }, 120000);

  test('real Python validates the native HTTP proof against the already verified manifest and Core graph', async () => {
    const { key, prepared } = await human();
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
      const program = ['import sys,json', 'from datetime import datetime', 'sys.path.insert(0,sys.argv[1])',
        'from native_history_manifest_confirmation import capture',
        'args=json.loads(sys.argv[3])',
        'v=capture(sys.argv[2],args["key"],args["saved"],args["checks"],datetime.fromisoformat(args["before"].replace("Z","+00:00")),args["manifest"],args["restored"])',
        'print(json.dumps({"status":v["status"],"current":v["snapshot"]["confirmationStatus"],"messages":v["snapshot"]["selectedMessages"]}))'].join('\n');
      const args = { key, saved: [ref()], ...selected(),
        manifest: { snapshot: prepared.preview.manifest, fingerprint: prepared.manifestSha256 },
        restored: { snapshot: prepared.preview.coreRestoration, fingerprint: prepared.coreRestorationSha256 } };
      const result = await promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
        path.resolve(__dirname, '../../../integrations/secretary'), `http://127.0.0.1:${server.address().port}`, JSON.stringify(args)],
      { timeout: 120000, maxBuffer: 4096 });
      expect(JSON.parse(result.stdout)).toEqual({ status: 'observed_match', current: 'current', messages: 1 });
      expect(await Confirmation.countDocuments()).toBe(1); await noCopies();
    } finally { await new Promise(resolve => server.close(resolve)); }
  }, 150000);
});
