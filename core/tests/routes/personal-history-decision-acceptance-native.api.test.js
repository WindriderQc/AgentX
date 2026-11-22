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
const { GAP } = require('../../src/services/personalHistoryDecisionAcceptancePolicy');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { decisionArchive } = require('../fixtures/historyDecisionAcceptanceArchive');
const BASE = '/api/secretary/history/manifest-confirmations';

(process.platform === 'win32' ? describe.skip : describe)('native recorded-decision acceptance with real HTTP, files and disposable Mongo', () => {
  let fixture, app, checks, entries, calls;
  const ref = () => Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(k => [k, fixture.source[k]]));
  const selected = () => ({ checks, before: '2026-01-01T00:00:00.000Z' });
  const observe = (key, extra) => request(app).post(`${BASE}/${key}/decision-acceptance`).send({ ...selected(), observationId: randomUUID(), ...extra });
  async function prepareChecks() {
    const anchor = await Entry.findById(entries.fact).lean();
    const receipt = (await preservation.prepare(entries.fact, { requestId: randomUUID(), revision: anchor.revision,
      source: 0, verification: 'review-restoration' }, { audience: 'owner', control: fixture.control })).receipt;
    checks = [{ entryId: entries.fact, requestId: receipt.requestId, snapshotHash: receipt.snapshotHash, source: ref() }];
  }
  async function human() {
    const key = randomUUID();
    const prepared = (await request(app).post(BASE).send({ requestId: key, ...selected() }).expect(200)).body.data;
    expect(prepared).toMatchObject({ state: 'prepared' });
    await request(app).post(`${BASE}/${key}/confirm`).send({ ...selected(), bindingSha256: prepared.bindingSha256,
      confirmation: 'reviewed_selected_manifest' }).expect(200);
    return { key, prepared };
  }
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression, Confirmation]) {
    await model.createCollection(); await model.createIndexes();
  } });
  beforeEach(async () => {
    for (const model of [Entry, MemoryNote, Suppression, Confirmation]) await model.deleteMany({});
    fixture = await decisionArchive(); entries = {}; calls = [];
    for (const finding of fixture.inventory.findings) {
      const kind = SECTIONS[finding.section];
      const entry = (await history.record({ kind, text: `Synthetic ${kind} decision`, sourceDate: null,
        source: { ...fixture.source, findingId: finding.findingId } })).entry;
      entries[kind] = entry.id;
      await history.review(entry.id, { revision: 0, state: kind === 'fact' ? 'retained' : 'resolved', reason: 'Synthetic explicit dated decision' });
    }
    await history.keepAsSouvenir(entries.fact, { revision: 1 });
    await prepareChecks();
    app = express(); const router = express.Router(); app.use(express.json());
    app.use((req, res, next) => { calls.push(req.path); next(); });
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

  test('real Python accepts resolved actions, deliveries and invoices with a retained dated fact and current link', async () => {
    const { key, prepared } = await human(), before = await Confirmation.findById(digest(key)).lean();
    const rows = await Entry.find({}).lean(), notes = await MemoryNote.find({}).lean();
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
      calls.length = 0;
      const program = ['import sys,json', 'from datetime import datetime', 'sys.path.insert(0,sys.argv[1])',
        'from native_history_decision_acceptance import capture', 'a=json.loads(sys.argv[3])',
        'v=capture(sys.argv[2],a["key"],a["saved"],a["checks"],datetime.fromisoformat(a["before"].replace("Z","+00:00")),a["manifest"],a["restored"])',
        'print(json.dumps(v))'].join('\n');
      const args = { key, saved: [ref()], ...selected(), manifest: { snapshot: prepared.preview.manifest, fingerprint: prepared.manifestSha256 },
        restored: { snapshot: prepared.preview.coreRestoration, fingerprint: prepared.coreRestorationSha256 } };
      const result = await promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
        path.resolve(__dirname, '../../../integrations/secretary'), `http://127.0.0.1:${server.address().port}`, JSON.stringify(args)],
      { timeout: 120000, maxBuffer: 128 * 1024 });
      const value = JSON.parse(result.stdout), accepted = value.acceptance;
      expect(accepted).toMatchObject({ status: 'observed_match', decisionReconciliationAccepted: true,
        semanticAcceptance: false, executionAllowed: false, approvalBound: false, authenticatedPerson: null, mailboxEffects: 0,
        snapshot: { acceptanceStatus: 'accepted_scope', counts: { messages: 1, acceptedMessages: 1, blockedMessages: 0,
          recordedFindings: 4, records: 4, currentLinks: 1, notLinked: 3 } } });
      expect(accepted.nativeValidationGaps).toEqual(GAPS.filter(g => g !== GAP));
      expect(value.confirmation.snapshot.confirmationStatus).toBe('current');
      expect(calls).toEqual([`${BASE}/${key}/decision-acceptance`, `${BASE}/${key}/decision-acceptance`]);
      expect(JSON.stringify(accepted)).not.toMatch(/Synthetic|reviewPacket|preview|sourceSha256/);
      expect(await Confirmation.findById(digest(key)).lean()).toEqual(before);
      expect(await Entry.find({}).lean()).toEqual(rows); expect(await MemoryNote.find({}).lean()).toEqual(notes);
      await noCopies();
    } finally { await new Promise(resolve => server.close(resolve)); }
  }, 180000);

  test('an explicitly retained invoice blocks acceptance; an explicit dismissal can settle its proposal', async () => {
    await history.review(entries.invoice, { revision: 1, state: 'retained', reason: 'Synthetic still-open invoice' });
    await prepareChecks(); const { key } = await human();
    const response = await observe(key).expect(200), value = response.body.data;
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(value.snapshot.currentConfirmation.snapshot.confirmationStatus).toBe('current');
    expect(value.snapshot.messages[0].blockers).toContain('actionable_record_not_resolved');
    expect(value.decisionReconciliationAccepted).toBe(false); expect(value.nativeValidationGaps).toEqual(GAPS);
    await history.review(entries.invoice, { revision: 2, state: 'dismissed', reason: 'Synthetic explicitly dismissed proposal' });
    await prepareChecks(); const fresh = await human();
    const settled = (await observe(fresh.key).expect(200)).body.data;
    expect(settled.decisionReconciliationAccepted).toBe(true); expect(settled.executionAllowed).toBe(false); await noCopies();
  }, 180000);

  test('a changed human binding, unavailable mirror and late privacy suppression cannot release acceptance', async () => {
    const { key } = await human(), original = await Confirmation.findById(digest(key)).lean();
    await Entry.collection.updateOne({ _id: new Entry.base.Types.ObjectId(entries.invoice) }, { $set: { syntheticUnversionedBody: 'changed' } });
    const changed = (await observe(key).expect(200)).body.data;
    expect(changed.snapshot.messages[0].blockers).toContain('human_confirmation_not_current');
    expect(changed.nativeValidationGaps).toEqual(GAPS);
    const probe = fixture.control.probeReviewRestoration.bind(fixture.control);
    fixture.control.probeReviewRestoration = (copy, input) => { if (copy === 'mirror') throw new Error('Synthetic mirror unavailable'); return probe(copy, input); };
    expect((await observe(key).expect(503)).body.data).toBeUndefined(); fixture.control.probeReviewRestoration = probe;
    const get = confirmations.get; let reads = 0;
    jest.spyOn(confirmations, 'get').mockImplementation(async (...args) => {
      const value = await get(...args); if (++reads === 2) await privacy.suppress({ _id: entries.invoice }); return value;
    });
    expect((await observe(key).expect(503)).body.data).toBeUndefined();
    expect(await Confirmation.findById(digest(key)).lean()).toEqual(original); await noCopies();
  }, 180000);
});
