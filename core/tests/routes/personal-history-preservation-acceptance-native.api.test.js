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
const confirmations = require('../../src/services/personalHistoryManifestConfirmation');
const privacy = require('../../src/services/personalHistoryPrivacy');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { SECTIONS } = require('../../src/services/personalHistoryFindingContract');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { GAP } = require('../../src/services/personalHistoryPreservationAcceptancePolicy');
const { GAP: DECISION_GAP } = require('../../src/services/personalHistoryDecisionAcceptancePolicy');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { preservationAcceptanceArchive } = require('../fixtures/historyPreservationAcceptanceArchive');
const BASE = '/api/secretary/history/manifest-confirmations';

(process.platform === 'win32' ? describe.skip : describe)('approved native preservation: real production files/HTTP/Mongo and synthetic kernel identities', () => {
  let fixture, app, checks, entries, calls;
  const ref = () => Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(key => [key, fixture.source[key]]));
  const selected = () => ({ checks, before: '2026-01-01T00:00:00.000Z' });
  const observe = (key, extra) => request(app).post(`${BASE}/${key}/preservation-acceptance`).send({ ...selected(), observationId: randomUUID(), ...extra });
  async function prepareChecks() {
    const anchor = await Entry.findById(entries.fact).lean();
    const receipt = (await preservation.prepare(entries.fact, { requestId: randomUUID(), revision: anchor.revision,
      source: 0, verification: 'review-restoration' }, { audience: 'owner', control: fixture.control })).receipt;
    checks = [{ entryId: entries.fact, requestId: receipt.requestId, snapshotHash: receipt.snapshotHash, source: ref() }];
  }
  async function human() {
    const key = randomUUID();
    const prepared = (await request(app).post(BASE).send({ requestId: key, ...selected() }).expect(200)).body.data;
    expect(prepared.state).toBe('prepared');
    const confirmed = (await request(app).post(`${BASE}/${key}/confirm`).send({ ...selected(), bindingSha256: prepared.bindingSha256,
      confirmation: 'reviewed_selected_manifest' }).expect(200)).body.data;
    expect(confirmed.state).toBe('confirmed'); return { key, prepared };
  }
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression, Confirmation]) {
    await model.createCollection(); await model.createIndexes();
  } });
  beforeEach(async () => {
    for (const model of [Entry, MemoryNote, Suppression, Confirmation]) await model.deleteMany({});
    fixture = await preservationAcceptanceArchive(); entries = {}; calls = [];
    for (const finding of fixture.inventory.findings) {
      const kind = SECTIONS[finding.section];
      const entry = (await history.record({ kind, text: `Synthetic preserved ${kind} decision`, sourceDate: null,
        source: { ...fixture.source, findingId: finding.findingId } })).entry;
      entries[kind] = entry.id;
      await history.review(entry.id, { revision: 0, state: kind === 'fact' ? 'retained' : 'resolved', reason: 'Synthetic explicit decision' });
    }
    await history.keepAsSouvenir(entries.fact, { revision: 1 }); await prepareChecks();
    app = express(); const router = express.Router(); app.use(express.json()); app.use((req, res, next) => { calls.push(req.path); next(); });
    registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience: 'owner', control: fixture.findings },
      preservationDeps: { audience: 'owner', control: fixture.control }, mailboxScopeDeps: { audience: 'owner', control: fixture.mailbox },
      envelope: (res, data) => res.json({ ok: true, status: 'success', data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router);
  });
  afterEach(async () => { jest.restoreAllMocks(); await fixture.cleanup(); });
  const noCopies = async () => {
    expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
    expect((await Entry.db.db.listCollections().toArray()).filter(row => row.name.startsWith('__agentx_core_restore_'))).toEqual([]);
  };

  test('strict private Python consumes two native parent observations and accepts only the selected two contracts', async () => {
    const { key, prepared } = await human(), receipt = await Confirmation.findById(digest(key)).lean();
    const rows = await Entry.find({}).lean(), notes = await MemoryNote.find({}).lean();
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
      calls.length = 0;
      const program = ['import sys,json', 'from datetime import datetime', 'sys.path.insert(0,sys.argv[1])',
        'from native_history_preservation_acceptance import capture', 'a=json.loads(sys.argv[3])',
        'v=capture(sys.argv[2],a["key"],a["saved"],a["checks"],datetime.fromisoformat(a["before"].replace("Z","+00:00")),a["manifest"],a["restored"])',
        'print(json.dumps(v))'].join('\n');
      const args = { key, saved: [ref()], ...selected(), manifest: { snapshot: prepared.preview.manifest, fingerprint: prepared.manifestSha256 },
        restored: { snapshot: prepared.preview.coreRestoration, fingerprint: prepared.coreRestorationSha256 } };
      const result = await promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
        path.resolve(__dirname, '../../../integrations/secretary'), `http://127.0.0.1:${server.address().port}`, JSON.stringify(args)],
      { timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
      const value = JSON.parse(result.stdout), accepted = value.preservation;
      expect(accepted).toMatchObject({ status: 'observed_match', preservationAccepted: true, decisionReconciliationAccepted: true,
        semanticAcceptance: false, authenticatedPerson: null, approvalBound: false, executionAllowed: false, mailboxEffects: 0,
        snapshot: { preservationStatus: 'accepted_scope', counts: { messages: 1, primaryDisks: 1, mirrorDisks: 1, heldMessages: 0 }, blockers: [] } });
      expect(accepted.nativeValidationGaps).toEqual(GAPS.filter(gap => ![GAP, DECISION_GAP].includes(gap)));
      expect(value.storage.physicalIndependenceAccepted).toBe(false); expect(value.storage.nativeValidationGaps).toEqual(GAPS);
      expect(value.confirmation.snapshot.confirmationStatus).toBe('current');
      expect(calls).toEqual([`${BASE}/${key}/preservation-acceptance`, `${BASE}/${key}/preservation-acceptance`]);
      expect(await Confirmation.findById(digest(key)).lean()).toEqual(receipt);
      expect(await Entry.find({}).lean()).toEqual(rows); expect(await MemoryNote.find({}).lean()).toEqual(notes); await noCopies();
    } finally { await new Promise(resolve => server.close(resolve)); }
  }, 240000);

  test('shared physical identifiers and unsupported topology hold preservation while current decisions remain accepted', async () => {
    const { key } = await human();
    await fs.writeFile(path.join(fixture.kernels.mirror.disk, 'wwid'), 'naa.5000000000000001\n');
    const response = await observe(key).expect(200), shared = response.body.data;
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(shared.preservationAccepted).toBe(false); expect(shared.decisionReconciliationAccepted).toBe(true);
    expect(shared.snapshot.blockers).toContain('selected_device_identity_overlap'); expect(shared.nativeValidationGaps).toContain(GAP);
    await fs.writeFile(fixture.kernels.mirror.mountinfo, (await fs.readFile(fixture.kernels.mirror.mountinfo, 'utf8')).replace(' - ext4 ', ' - overlay '));
    const unknown = (await observe(key).expect(200)).body.data;
    expect(unknown.preservationAccepted).toBe(false); expect(unknown.snapshot.blockers).toContain('storage_topology_unqualified'); await noCopies();
  }, 180000);

  test('an open invoice does not invent closure and does not erase verified preservation', async () => {
    await history.review(entries.invoice, { revision: 1, state: 'retained', reason: 'Synthetic still-open invoice' });
    await prepareChecks(); const { key } = await human();
    const value = (await observe(key).expect(200)).body.data;
    expect(value.preservationAccepted).toBe(true); expect(value.decisionReconciliationAccepted).toBe(false);
    expect(value.nativeValidationGaps).toContain(DECISION_GAP); expect(value.nativeValidationGaps).not.toContain(GAP);
    expect(value.executionAllowed).toBe(false); expect(value.approvalBound).toBe(false); await noCopies();
  }, 180000);

  test('a changed original human binding cannot endorse current preservation or decisions', async () => {
    const { key } = await human();
    await Entry.collection.updateOne({ _id: new Entry.base.Types.ObjectId(entries.invoice) }, { $set: { syntheticUnversioned: 'changed' } });
    const value = (await observe(key).expect(200)).body.data;
    expect(value.preservationAccepted).toBe(false); expect(value.snapshot.blockers).toContain('human_confirmation_not_current');
    expect(value.nativeValidationGaps).toEqual(GAPS); await noCopies();
  }, 180000);

  test('native storage loss returns unavailable; erasure during the last receipt read is fenced after all storage probes', async () => {
    const { key } = await human(), before = await Confirmation.findById(digest(key)).lean();
    const original = fixture.control.probeStorageEvidence.bind(fixture.control);
    fixture.control.probeStorageEvidence = () => { throw new Error('Synthetic private storage outage'); };
    const failed = (await observe(key).expect(503)).body;
    expect(failed.data).toBeUndefined(); expect(JSON.stringify(failed)).not.toContain('private storage');
    fixture.control.probeStorageEvidence = original;
    const get = confirmations.get; let reads = 0;
    jest.spyOn(confirmations, 'get').mockImplementation(async (...args) => {
      const value = await get(...args); if (++reads === 3) await privacy.suppress({ _id: entries.fact }); return value;
    });
    const erased = (await observe(key).expect(503)).body;
    expect(reads).toBe(3); expect(erased.data).toBeUndefined();
    expect(await Confirmation.findById(digest(key)).lean()).toEqual(before); await noCopies();
  }, 180000);
});
