'use strict';
jest.mock('../../src/services/memoryNoteIndex', () => ({ createIndex: () => ({ indexNote: async () => false }) }));
jest.mock('../../src/services/souvenirRecallSync', () => ({ scheduleSouvenirRecallSync: jest.fn() }));
const express = require('express'), request = require('supertest');
const fs = require('node:fs/promises'), path = require('node:path');
const { execFile } = require('node:child_process'), { promisify } = require('node:util');
const { randomUUID, createHash } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry'), MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression'), Confirmation = require('../../models/PersonalHistoryManifestConfirmation');
const Review = require('../../models/PersonalHistorySemanticReview');
const history = require('../../src/services/personalHistoryService'), preservation = require('../../src/services/personalHistoryPreservation');
const privacy = require('../../src/services/personalHistoryPrivacy'), current = require('../../src/services/personalHistoryManifestConfirmationCurrent');
const semantic = require('../../src/services/personalHistorySemanticReview');
const manifestEvidence = require('../../src/services/personalHistoryManifestConfirmationEvidence');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { SECTIONS } = require('../../src/services/personalHistoryFindingContract');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { semanticReviewArchive } = require('../fixtures/historySemanticReviewArchive');
const BASE = '/api/secretary/history', sha = bytes => createHash('sha256').update(bytes).digest('hex');
const models = [Entry, MemoryNote, Suppression, Confirmation, Review];
(process.platform === 'win32' ? describe.skip : describe)('explicit human semantics: real source bytes/native parser/HTTP/Mongo, synthetic device identity', () => {
  let fixture, app, checks, entries, manifestRequestId, manifestPrepared, paths;
  const selected = () => ({ checks, before: '2026-01-01T00:00:00.000Z' });
  const scope = () => ({ manifestRequestId, ...selected() });
  const call = (id, action, body) => request(app).post(`${BASE}/semantic-reviews/${id}/${action}`).send({ ...scope(), ...body });
  const observe = id => request(app).post(`${BASE}/manifest-confirmations/${manifestRequestId}/semantic-acceptance`)
    .send({ ...selected(), semanticRequestId: id, observationId: randomUUID() });
  async function prepare() {
    const requestId = randomUUID();
    const result = await request(app).post(`${BASE}/manifest-confirmations/${manifestRequestId}/semantic-reviews`).send({ ...selected(), requestId }).expect(200);
    expect(result.body.data.state).toBe('prepared'); return result.body.data;
  }
  async function readAll(prepared) {
    const values = [];
    for (const [source, member] of prepared.preview.sources.entries()) for (const [resource, descriptor] of member.resources.entries()) {
      let offset = 0; const chunks = [];
      do {
        const result = (await call(prepared.requestId, 'read', { source, resource, offset }).expect(200)).body.data;
        const bytes = Buffer.from(result.page.contentBase64, 'base64'); expect(sha(bytes)).toBe(result.page.chunkSha256);
        chunks.push(bytes); offset = result.page.nextOffset;
      } while (offset !== null);
      const bytes = Buffer.concat(chunks); expect(bytes.length).toBe(descriptor.bytes); expect(sha(bytes)).toBe(descriptor.sha256);
      values.push({ descriptor, bytes });
    }
    return values;
  }
  beforeAll(async () => { for (const model of models) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => {
    for (const model of models) await model.deleteMany({});
    fixture = await semanticReviewArchive(); entries = {}; paths = [];
    for (const finding of fixture.inventory.findings) {
      const kind = SECTIONS[finding.section];
      const entry = (await history.record({ kind, text: `Synthetic semantic ${kind}`, sourceDate: null, source: { ...fixture.source, findingId: finding.findingId } })).entry;
      entries[kind] = entry.id;
      await history.review(entry.id, { revision: 0, state: kind === 'fact' ? 'retained' : 'resolved', reason: 'Synthetic resolved decision' });
    }
    const anchor = await Entry.findById(entries.fact).lean();
    const receipt = (await preservation.prepare(entries.fact, { requestId: randomUUID(), revision: anchor.revision, source: 0, verification: 'review-restoration' }, { audience: 'owner', control: fixture.control })).receipt;
    checks = [{ entryId: entries.fact, requestId: receipt.requestId, snapshotHash: receipt.snapshotHash,
      source: Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(k => [k, fixture.source[k]])) }];
    app = express(); app.use(express.json()); app.use((req, res, next) => { paths.push(req.path); next(); }); const router = express.Router();
    registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience: 'owner', control: fixture.findings },
      preservationDeps: { audience: 'owner', control: fixture.control }, mailboxScopeDeps: { audience: 'owner', control: fixture.mailbox },
      envelope: (res, data) => res.json({ ok: true, data }), fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router); manifestRequestId = randomUUID();
    const nativeErrors = [], nativeObserve = manifestEvidence.observe;
    jest.spyOn(manifestEvidence, 'observe').mockImplementation(async (...args) => {
      try { return await nativeObserve(...args); } catch (error) { nativeErrors.push({ code: error.code, message: error.message, stack: error.stack }); throw error; }
    });
    const prepared = (await request(app).post(`${BASE}/manifest-confirmations`).send({ requestId: manifestRequestId, ...selected() }).expect(200)).body.data;
    manifestPrepared = prepared;
    expect(prepared.state === 'prepared' ? null : { receipt: prepared, nativeErrors }).toBeNull();
    await request(app).post(`${BASE}/manifest-confirmations/${manifestRequestId}/confirm`).send({ ...selected(), bindingSha256: prepared.bindingSha256, confirmation: 'reviewed_selected_manifest' }).expect(200);
  });
  afterEach(async () => { jest.restoreAllMocks(); await fixture.cleanup(); });

  test('new explicit judgment requires every exact source and analysis, preserves canonical records and lifts only the semantic gap', async () => {
    const before = await Entry.find({}).lean(), old = await Confirmation.find({}).lean();
    const prepared = await prepare();
    const body = { bindingSha256: prepared.bindingSha256, decision: 'accepted_selected_semantics' };
    await call(prepared.requestId, 'decide', body).expect(409);
    const resources = await readAll(prepared);
    const analysis = JSON.parse(resources.find(r => r.descriptor.kind === 'analysis').bytes);
    expect(analysis.findings).toHaveLength(4); expect(analysis.pages.length).toBeGreaterThan(0);
    expect(analysis.findings.every(r => r.item.messageId === fixture.source.messageId)).toBe(true);
    expect(resources.filter(r => r.descriptor.kind === 'attachment').length).toBeGreaterThan(0);
    const accepted = (await call(prepared.requestId, 'decide', body).expect(200)).body.data;
    expect(accepted).toMatchObject({ state: 'accepted', semanticAcceptance: false, approvalBound: false, executionAllowed: false, coverage: { complete: true } });
    const replay = (await call(prepared.requestId, 'decide', body).expect(200)).body.data;
    expect(replay.decidedAt).toBe(accepted.decidedAt);
    const observation = (await observe(prepared.requestId).expect(200)).body.data;
    expect(observation).toMatchObject({ semanticAcceptance: true, decisionReconciliationAccepted: true, preservationAccepted: true,
      authenticatedPerson: null, approvalBound: false, executionAllowed: false, mailboxEffects: 0 });
    expect(observation.nativeValidationGaps).toEqual(['native_manifest_approval_binding_unavailable']);
    expect(observation.snapshot.bindingSha256).toBe(digest(observation.snapshot.reviewBinding));
    const again = (await request(app).post(`${BASE}/manifest-confirmations/${manifestRequestId}/semantic-acceptance`).send({ ...selected(), semanticRequestId: prepared.requestId, observationId: randomUUID(), expected: observation.fingerprint }).expect(200)).body.data;
    expect(again.status).toBe('observed_match');
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
      paths.length = 0;
      const program = ['import sys,json', 'from datetime import datetime', 'sys.path.insert(0,sys.argv[1])',
        'from native_history_semantic_acceptance import capture', 'a=json.loads(sys.argv[3])',
        'v=capture(sys.argv[2],a["manifestId"],a["semanticId"],a["saved"],a["checks"],datetime.fromisoformat(a["before"].replace("Z","+00:00")),a["manifest"],a["restored"])', 'print(json.dumps(v))'].join('\n');
      const args = { manifestId: manifestRequestId, semanticId: prepared.requestId, saved: checks.map(r => r.source), ...selected(),
        manifest: { snapshot: manifestPrepared.preview.manifest, fingerprint: manifestPrepared.manifestSha256 },
        restored: { snapshot: manifestPrepared.preview.coreRestoration, fingerprint: manifestPrepared.coreRestorationSha256 } };
      const result = await promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
        path.resolve(__dirname, '../../../integrations/secretary'), `http://127.0.0.1:${server.address().port}`, JSON.stringify(args)],
      { timeout: 180000, maxBuffer: 5 * 1024 * 1024 });
      const retained = JSON.parse(result.stdout);
      expect(retained.semantic).toMatchObject({ status: 'observed_match', semanticAcceptance: true, executionAllowed: false,
        nativeValidationGaps: ['native_manifest_approval_binding_unavailable'] });
      expect(retained.semantic.initialObservationId).not.toBe(retained.semantic.observationId);
      expect(paths).toEqual([`${BASE}/manifest-confirmations/${manifestRequestId}/semantic-acceptance`, `${BASE}/manifest-confirmations/${manifestRequestId}/semantic-acceptance`]);
    } finally { await new Promise(resolve => server.close(resolve)); }
    expect(await Entry.find({}).lean()).toEqual(before); expect(await Confirmation.find({}).lean()).toEqual(old);
    expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
    const load = semantic.load; let reads = 0;
    jest.spyOn(semantic, 'load').mockImplementation(async (...args) => {
      const row = await load(...args);
      if (++reads === 2) await privacy.suppress({ _id: entries.fact });
      return row;
    });
    const erased = await observe(prepared.requestId).expect(503);
    expect(reads).toBe(2); expect(erased.body.data).toBeUndefined();
  }, 360000);

  test('old inspection, held ambiguity and missing source delivery do not turn into semantic acceptance', async () => {
    const prepared = await prepare();
    const missing = (await observe(prepared.requestId).expect(200)).body.data;
    expect(missing.semanticAcceptance).toBe(false); expect(missing.nativeValidationGaps).toContain('native_semantic_acceptance_unavailable');
    await call(prepared.requestId, 'read', { source: 0, resource: 0, offset: 1 }).expect(400);
    const held = (await call(prepared.requestId, 'decide', { bindingSha256: prepared.bindingSha256, decision: 'held_ambiguous' }).expect(200)).body.data;
    expect(held.state).toBe('held');
    await call(prepared.requestId, 'decide', { bindingSha256: prepared.bindingSha256, decision: 'accepted_selected_semantics' }).expect(409);
    expect((await observe(prepared.requestId).expect(200)).body.data.semanticAcceptance).toBe(false);
  }, 180000);

  test('lost page acknowledgement rereads original bytes; historical receipt stays opaque after source changes or erasure', async () => {
    const prepared = await prepare();
    const first = (await call(prepared.requestId, 'read', { source: 0, resource: 0, offset: 0 }).expect(200)).body.data;
    const replay = (await call(prepared.requestId, 'read', { source: 0, resource: 0, offset: 0 }).expect(200)).body.data;
    expect(replay.page).toEqual(first.page); expect(replay.receipt.coverage).toEqual(first.receipt.coverage);
    await Entry.collection.updateOne({ _id: new Entry.base.Types.ObjectId(entries.invoice) }, { $set: { syntheticUnversioned: 'changed' } });
    await call(prepared.requestId, 'reopen').expect(409);
    await privacy.suppress({ _id: entries.fact });
    const retained = (await request(app).get(`${BASE}/semantic-reviews/${prepared.requestId}`).expect(200)).body.data;
    expect(retained.preview).toBeUndefined(); expect(retained.semanticAcceptance).toBe(false);
    expect(retained.bindingSha256).toBe(prepared.bindingSha256);
    const unavailable = await call(prepared.requestId, 'read', { source: 0, resource: 0, offset: 0 });
    expect([409, 503]).toContain(unavailable.status); expect(unavailable.body.data).toBeUndefined();
  }, 180000);

  test('changed analysis or invalid source bytes cannot release an earlier private page', async () => {
    const prepared = await prepare(), native = fixture.control.probeSemanticReview;
    fixture.control.probeSemanticReview = async (...args) => { const value = await native(...args); if (value.page) value.page.chunkSha256 = '0'.repeat(64); return value; };
    const bad = await call(prepared.requestId, 'read', { source: 0, resource: 0, offset: 0 }).expect(503);
    expect(bad.body.data).toBeUndefined();
    fixture.control.probeSemanticReview = native;
    const reviewPath = path.join(fixture.roots.primary, 'reviews', fixture.source.threadId + '.json');
    const content = JSON.parse(await fs.readFile(reviewPath)); content.actions[0].text += ' changed'; await fs.writeFile(reviewPath, JSON.stringify(content));
    const changed = await call(prepared.requestId, 'read', { source: 0, resource: 0, offset: 0 });
    expect([409, 503]).toContain(changed.status); expect(changed.body.data).toBeUndefined();
  }, 180000);

  test('erasure during progress acknowledgement is fenced; an uncertain decision claim never restarts native work', async () => {
    const prepared = await prepare(), original = Review.findOneAndUpdate.bind(Review);
    let erased = false;
    jest.spyOn(Review, 'findOneAndUpdate').mockImplementation((query, update, options) => ({ lean: async () => {
      const row = await original(query, update, options).lean();
      if (update.$set.sources && !erased) { erased = true; await privacy.suppress({ _id: entries.fact }); }
      return row;
    } }));
    const response = await call(prepared.requestId, 'read', { source: 0, resource: 0, offset: 0 }).expect(503);
    expect(erased).toBe(true); expect(response.body.data).toBeUndefined(); jest.restoreAllMocks();
    // A held verdict can be requested without source delivery, but even a lost
    // reservation ACK must keep the original pending identity, not run again.
    let claims = 0; const probe = jest.spyOn(current, 'observeWithEvidence');
    jest.spyOn(Review, 'findOneAndUpdate').mockImplementation((query, update, options) => ({ lean: async () => {
      const row = await original(query, update, options).lean();
      if (update.$set.state === 'deciding' && ++claims === 1) throw Error('Synthetic lost acknowledgement'); return row;
    } }));
    const held = { bindingSha256: prepared.bindingSha256, decision: 'held_ambiguous' };
    expect((await call(prepared.requestId, 'decide', held).expect(200)).body.data.state).toBe('deciding');
    expect((await call(prepared.requestId, 'decide', held).expect(200)).body.data.state).toBe('deciding');
    expect(probe).not.toHaveBeenCalled();
  }, 180000);
});
