'use strict';
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const preservation = require('../../src/services/personalHistoryPreservation');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { reviewArchive } = require('../fixtures/historyReviewArchive');
const { control: findingControl } = require('../fixtures/historyFindingArchive');

(process.platform === 'win32' ? describe.skip : describe)('owner Core -> actual native current review graph restore on both copies', () => {
  let fixture, app, id, key;
  const deps = audience => ({ audience, control: fixture.control });
  const reference = () => Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(k => [k, fixture.source[k]]));
  const input = extra => ({ requestId: key, revision: 0, source: 0, verification: 'review-restoration', ...extra });
  const mount = audience => {
    const app = express(), router = express.Router(); app.use(express.json());
    registerSecretaryHistoryRoutes({ router, preservationDeps: deps(audience),
      findingScopeDeps: { audience, control: findingControl(fixture.roots.primary, path.join(fixture.roots.primary, 'no-runtime-config.json')) },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router); return app;
  };
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => {
    for (const model of [Entry, MemoryNote, Suppression]) await model.deleteMany({});
    fixture = await reviewArchive(); key = randomUUID();
    id = (await history.record({ kind: 'fact', text: 'Synthetic current review fact', sourceDate: null, source: fixture.source })).entry.id;
    app = mount('owner');
  });
  afterEach(async () => fixture.cleanup());
  const prepare = async () => (await request(app).post(`/api/secretary/history/${id}/preservation`).send(input()).expect(200)).body.data.receipt;

  test('retains a distinct v3 receipt with actual graph copy hashes, no private content or acceptance', async () => {
    const receipt = await prepare();
    expect(receipt).toMatchObject({ verification: 'review-restoration', executionAllowed: false, nativeValidationGaps: GAPS,
      snapshot: { contract: 'agentx.history-preservation/v3', status: 'verified_scope', blockers: [] } });
    for (const copy of receipt.snapshot.copies) {
      expect(copy.content.reviewPacket.counts.files).toBeGreaterThan(3 + copy.content.attachments.length);
      expect(copy.content.reviewPacket.filesSha256).toBe(copy.restoration.restoredFilesSha256);
      expect(copy.restoration.temporaryCopyRemoved).toBe(true);
    }
    expect(JSON.stringify(receipt)).not.toMatch(/private body|Synthetic current review fact|history-preservation-/);
    expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
    const next = (await request(app).get(`/api/secretary/history/${id}/preservation/${key}`).expect(200)).body.data.receipt;
    expect(next.nativeState).toBe('current'); expect(next.snapshotHash).toBe(receipt.snapshotHash);
    await request(app).post(`/api/secretary/history/${id}/preservation`).send(input({ verification: 'restoration' })).expect(409);
  });
  test('two-machine base byte agreement cannot hide a different review graph', async () => {
    const lanes = path.join(fixture.roots.mirror, 'value-lanes.json'), value = JSON.parse(await fs.readFile(lanes));
    value.syntheticRevision = 1; await fs.writeFile(lanes, JSON.stringify(value));
    const receipt = await prepare();
    expect(receipt.snapshot.status).toBe('blocked'); expect(receipt.snapshot.blockers).toContain('native_review_packet_copy_mismatch');
    expect(receipt.snapshot.copies.every(copy => copy.status === 'available')).toBe(true);
  });
  test('a missing page copy is unavailable, with no fallback to primary/original-only checks', async () => {
    const pageDir = path.join(fixture.roots.mirror, 'page-reviews');
    await fs.unlink(path.join(pageDir, (await fs.readdir(pageDir))[0]));
    const receipt = await prepare();
    expect(receipt.snapshot.status).toBe('blocked'); expect(receipt.snapshot.copies[1].status).toBe('unavailable');
  });
  test('explicit review mode global scope composes exact retained v3 receipts', async () => {
    const receipt = await prepare();
    const check = { entryId: id, requestId: key, snapshotHash: receipt.snapshotHash, source: reference() };
    const body = { observationId: randomUUID(), checks: [check], verification: 'review-restoration' };
    const result = (await request(app).post('/api/secretary/history/preservation-scope').send(body).expect(200)).body.data;
    expect(result).toMatchObject({ contract: 'agentx.history-restoration-scope/v2', coverage: 'complete-selected-review-packet-source-set',
      executionAllowed: false, semanticAcceptance: false, nativeValidationGaps: GAPS });
    expect(result.snapshot.members[0].snapshot).toEqual(receipt.snapshot);
    const old = { observationId: randomUUID(), checks: [check] };
    await request(app).post('/api/secretary/history/preservation-scope').send(old).expect(409);
  });
  test('family and ambiguous modes refuse before opening an archive', async () => {
    await request(mount('family')).post(`/api/secretary/history/${id}/preservation`).send(input()).expect(403);
    await request(app).post(`/api/secretary/history/${id}/preservation`).send(input({ verification: 'accept-all' })).expect(400);
    expect(fixture.calls).toEqual([]);
  });
  test('actual Python consumer -> Core -> native graph copies also binds the private local graph', async () => {
    const receipt = await prepare();
    const check = { entryId: id, requestId: key, snapshotHash: receipt.snapshotHash, source: reference() };
    const observed = (await request(app).post('/api/secretary/history/decision-state/findings')
      .send({ source: reference(), observationId: randomUUID() }).expect(200)).body.data;
    const finding = { reference: reference(), snapshot: observed.snapshot, fingerprint: observed.fingerprint };
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
      const program = ['import sys,json', 'from pathlib import Path', 'from types import SimpleNamespace',
        'sys.path.insert(0,sys.argv[1])', 'from native_history_review_restoration import capture',
        'value=capture(sys.argv[2],json.loads(sys.argv[3]),json.loads(sys.argv[4]),SimpleNamespace(root=Path(sys.argv[5])),json.loads(sys.argv[6]))',
        'print(json.dumps({"status":value["status"],"messages":len(value["snapshot"]["members"])}))'].join('\n');
      const result = await promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
        path.resolve(__dirname, '../../../integrations/secretary'), `http://127.0.0.1:${server.address().port}`,
        JSON.stringify([reference()]), JSON.stringify([check]), fixture.roots.primary, JSON.stringify([finding])],
      { timeout: 30000, maxBuffer: 4096 });
      expect(JSON.parse(result.stdout)).toEqual({ status: 'observed_match', messages: 1 });
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
  test('erasure after the last native restore cannot return the prepared private receipt', async () => {
    const original = fixture.control.probeReviewRestoration.bind(fixture.control);
    let count = 0;
    fixture.control.probeReviewRestoration = async (...args) => {
      const result = await original(...args);
      if (++count === 2) await history.review(id, { revision: 0, state: 'forgotten' });
      return result;
    };
    await expect(preservation.prepare(id, input(), deps('owner'))).rejects.toMatchObject({ statusCode: 404 });
    expect((await Entry.findById(id).lean()).preservationChecks).toEqual([]);
  });
});
