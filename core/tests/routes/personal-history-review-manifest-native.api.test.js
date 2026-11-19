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
const history = require('../../src/services/personalHistoryService');
const preservation = require('../../src/services/personalHistoryPreservation');
const privacy = require('../../src/services/personalHistoryPrivacy');
const scope = require('../../src/services/personalHistoryMessageScope');
const manifestContract = require('../../src/services/personalHistoryReviewManifestContract');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { manifestArchive } = require('../fixtures/historyReviewManifestArchive');
const URL = '/api/secretary/history/review-manifest';

(process.platform === 'win32' ? describe.skip : describe)('native composed review manifest with final joined Core/note fence', () => {
  let fixture, app, id, noteId, checks;
  const ref = () => Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(k => [k, fixture.source[k]]));
  const input = extra => ({ checks, before: '2026-01-01T00:00:00.000Z', observationId: randomUUID(), ...extra });
  const mount = (audience = 'owner') => {
    const app = express(), router = express.Router(); app.use(express.json());
    registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience, control: fixture.findings },
      preservationDeps: { audience, control: fixture.control }, mailboxScopeDeps: { audience, control: fixture.mailbox },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router); return app;
  };
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => {
    for (const model of [Entry, MemoryNote, Suppression]) await model.deleteMany({});
    fixture = await manifestArchive();
    id = (await history.record({ kind: 'fact', text: 'Synthetic private unified review', sourceDate: null, source: fixture.source })).entry.id;
    noteId = (await history.keepAsSouvenir(id, { revision: 0 })).souvenirNoteId;
    const receipt = (await preservation.prepare(id, { requestId: randomUUID(), revision: 1, source: 0, verification: 'review-restoration' },
      { audience: 'owner', control: fixture.control })).receipt;
    checks = [{ entryId: id, requestId: receipt.requestId, snapshotHash: receipt.snapshotHash, source: ref() }]; app = mount();
  });
  afterEach(async () => { jest.restoreAllMocks(); await fixture.cleanup(); });
  const observe = async extra => (await request(app).post(URL).send(input(extra)).expect(200)).body.data;

  test('actual readers compose one canonical exact manifest, with no content, effects or approval', async () => {
    const before = await MemoryNote.findById(noteId).lean();
    const response = await request(app).post(URL).send(input()).expect(200), value = response.body.data;
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(value).toMatchObject({ contract: 'agentx.history-review-manifest/v1', reviewOnly: true, semanticAcceptance: false,
      authenticatedPerson: null, atomicBatch: false, mailboxEffects: 0, approvalBound: false, executionAllowed: false,
      cleanupStatus: 'blocked', nativeValidationGaps: GAPS });
    expect(value.snapshot.checksSha256).toBe(digest(checks));
    expect(value.snapshot.sources).toEqual([ref()]); expect(value.fingerprint).toBe(digest(value.snapshot));
    expect(value.snapshot.coverage.counts).toMatchObject({ messages: 1, entries: 1, observedNotes: 1, livePresent: 1, candidatesForOwnerReview: 0 });
    expect(value.snapshot.coverage.blockers).toEqual(expect.arrayContaining(GAPS));
    expect(value.snapshot.coverage.messages[0].candidateForOwnerReview).toBe(false);
    expect(fixture.mailboxCalls).toHaveLength(2); expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
    expect(JSON.stringify(value)).not.toMatch(/Synthetic|synthetic@example|history-preservation-/);
    expect(await MemoryNote.findById(noteId).lean()).toEqual(before);
    expect((await observe({ expected: value.fingerprint })).status).toBe('observed_match');
  });
  test.each(['note', 'forget', 'core'])('a late %s change during the last live probe cannot escape the common fence', async kind => {
    const original = fixture.mailbox.probe.bind(fixture.mailbox); let calls = 0;
    fixture.mailbox.probe = async (...args) => {
      const value = await original(...args);
      if (++calls === 2) {
        if (kind === 'note') await MemoryNote.updateOne({ _id: noteId }, { $set: { text: 'Synthetic late changed note' }, $inc: { revision: 1 } });
        if (kind === 'forget') await require('../../src/services/memoryNoteService').personal().forget(noteId);
        if (kind === 'core') await Entry.updateOne({ _id: id }, { $inc: { revision: 1 } });
      }
      return value;
    };
    const response = await request(app).post(URL).send(input()).expect(409);
    expect(JSON.stringify(response.body)).not.toContain('Synthetic');
  });
  test('an earlier souvenir edit during the later disk restoration is rejected after all components', async () => {
    const original = fixture.control.probeReviewRestoration.bind(fixture.control); let calls = 0;
    fixture.control.probeReviewRestoration = async (...args) => {
      const value = await original(...args);
      if (++calls === 2) await MemoryNote.updateOne({ _id: noteId }, { $inc: { revision: 1 } });
      return value;
    };
    await request(app).post(URL).send(input()).expect(409);
    expect(fixture.mailboxCalls).toHaveLength(2);
  });
  test('rehashed child proofs cannot mix review versions, omit sources or exceed the complete manifest bound', async () => {
    const value = await observe(), s = value.snapshot;
    const original = { decisions: s.decisions, downstream: s.downstream, restoration: s.restoration, mailbox: s.mailbox };
    expect(manifestContract.build(s.before, checks, original)).toEqual(s);
    const mutations = [
      d => { d.downstream.snapshot.members[0].snapshot.findingScope.snapshot.inventory.reviewSha256 = 'f'.repeat(64); },
      d => { d.mailbox[0].snapshot.coreScope.members[0].entryRevision += 1; },
      d => { d.restoration.snapshot.members[0].snapshot.copies[0].content.reviewPacket.reviewSha256 = 'f'.repeat(64); },
      d => { d.decisions.snapshot.sourceSetSha256 = 'f'.repeat(64); },
      d => { d.restoration.snapshot.members.length = 0; },
      d => { d.mailbox.length = 0; }
    ];
    for (const mutate of mutations) {
      const data = structuredClone(original); mutate(data);
      for (const row of [data.decisions, data.downstream, data.restoration, ...data.mailbox]) row.fingerprint = digest(row.snapshot);
      expect(() => manifestContract.build(s.before, checks, data)).toThrow(expect.objectContaining({ statusCode: 409 }));
    }
    const oversized = structuredClone(original);
    oversized.decisions.snapshot.coverage.padding = 'x'.repeat(1024 * 1024);
    oversized.decisions.fingerprint = digest(oversized.decisions.snapshot);
    expect(() => manifestContract.build(s.before, checks, oversized)).toThrow(expect.objectContaining({ statusCode: 413 }));
  });
  test('final common privacy awaits cannot hide a note edit after all producer checks', async () => {
    const original = scope.observeSelection;
    let joined = 0;
    jest.spyOn(scope, 'observeSelection').mockImplementation(async (refs, options) => {
      // Manifest initial, downstream initial/final, manifest final.
      if (options?.souvenirs && ++joined === 4) jest.spyOn(privacy, 'forgottenSource').mockImplementationOnce(async () => {
        await MemoryNote.updateOne({ _id: noteId }, { $inc: { revision: 1 } }); return false;
      });
      return original(refs, options);
    });
    await request(app).post(URL).send(input()).expect(409); expect(joined).toBe(4);
  });
  test.each([['1000', true], ['999', false], ['1001', true]])('cutoff equality for native milliseconds %s stays held=%s', async (milliseconds, held) => {
    fixture.reply.data.message.internalDate = milliseconds;
    const value = await observe({ before: '1970-01-01T00:00:01.000Z' });
    expect(value.snapshot.coverage.messages[0].blockers.includes('live_message_outside_cutoff')).toBe(held);
    expect(value.executionAllowed).toBe(false);
  });
  test('missing native source remains held, while provider permission failures refuse', async () => {
    fixture.reply.code = 1; fixture.reply.stderr = '404 not found';
    const value = await observe();
    expect(value.snapshot.coverage.counts.livePresent).toBe(0);
    expect(value.snapshot.coverage.messages[0].blockers).toContain('live_message_not_found');
    fixture.reply.stderr = '403 permission denied synthetic-private';
    const response = await request(app).post(URL).send(input()).expect(503);
    expect(JSON.stringify(response.body)).not.toContain('synthetic-private');
  });
  test('family and ambiguous proofs/cutoffs refuse before archive/provider work', async () => {
    const before = fixture.calls.length;
    await request(mount('family')).post(URL).set('x-service-caller', 'owner').send(input()).expect(403);
    for (const extra of [{ before: '2026-02-30T00:00:00.000Z' }, { before: '2026-01-01' }, { before: '2026-01-01T00:00:00Z' },
      { sources: [ref()] }, { accepted: true }, { checks: [] }, { checks: checks.concat(checks) }]) {
      await request(app).post(URL).send(input(extra)).expect(400);
    }
    expect(fixture.calls).toHaveLength(before); expect(fixture.mailboxCalls).toEqual([]);
  });
  test('actual Python consumer -> composed Core -> all native readers -> final local graph binding', async () => {
    const value = await observe(), snapshot = value.snapshot;
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
      const program = ['import sys,json', 'from pathlib import Path', 'from datetime import datetime', 'from types import SimpleNamespace',
        'sys.path.insert(0,sys.argv[1])', 'from native_history_review_manifest import capture',
        'from native_history_review_restoration import bind_local',
        'payload=json.loads(sys.argv[3]);s=payload["snapshot"];checks=payload["checks"];saved=s["sources"]',
        'value=capture(sys.argv[2],saved,checks,datetime.fromisoformat(s["before"].replace("Z","+00:00")),s["decisions"],s["downstream"],s["restoration"],s["mailbox"])',
        'bind_local(saved,checks,SimpleNamespace(root=Path(sys.argv[4])),s["decisions"]["snapshot"]["findings"],value["snapshot"]["restoration"])',
        'print(json.dumps({"status":value["status"],"fingerprint":value["fingerprint"],"counts":value["snapshot"]["coverage"]["counts"]}))'].join('\n');
      const result = await promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
        path.resolve(__dirname, '../../../integrations/secretary'), `http://127.0.0.1:${server.address().port}`,
        JSON.stringify({ snapshot, checks }), fixture.roots.primary], { timeout: 60000, maxBuffer: 4096 });
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'observed_match', fingerprint: value.fingerprint,
        counts: { messages: 1, entries: 1, observedNotes: 1, livePresent: 1, candidatesForOwnerReview: 0 } });
      expect(fixture.mailboxCalls).toHaveLength(6);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
