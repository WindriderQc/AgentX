'use strict';

const express = require('express');
const request = require('supertest');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const Entry = require('../../models/PersonalHistoryEntry');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { archive } = require('../fixtures/historyPreservationArchive');

(process.platform === 'win32' ? describe.skip : describe)('owner HTTP -> actual native disk restoration -> immutable Core receipt', () => {
  let fixture, app, id;
  const url = key => `/api/secretary/history/${id}/preservation${key ? '/' + key : ''}`;
  const input = key => ({ requestId: key, revision: 0, source: 0, verification: 'restoration' });
  function mount(audience = 'owner') {
    const app = express(), router = express.Router(); app.use(express.json());
    registerSecretaryHistoryRoutes({ router, preservationDeps: { audience, control: fixture.control },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router); return app;
  }
  beforeAll(async () => { await Entry.createCollection(); await Entry.createIndexes(); await Suppression.createCollection(); });
  beforeEach(async () => {
    await Entry.deleteMany({}); await Suppression.deleteMany({}); fixture = await archive({ command: 'restoration' });
    id = (await history.record({ kind: 'fact', text: 'Synthetic disk-restored source',
      sourceDate: '2024-01-01T00:00:00Z', source: fixture.source })).entry.id;
    app = mount();
  });
  afterEach(async () => fixture.cleanup());

  test('production Python restores actual files, rereads their MIME and removes scratch copies before success', async () => {
    const key = randomUUID(), response = await request(app).post(url()).send(input(key)).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const first = response.body.data.receipt;
    expect(first).toMatchObject({ verification: 'restoration', nativeState: 'observed', executionAllowed: false,
      cleanupStatus: 'blocked', snapshot: { contract: 'agentx.history-preservation/v2', status: 'verified_scope' } });
    for (const copy of first.snapshot.copies) {
      expect(copy.content.partsDecoded).toBe(2); expect(copy.content.attachments).toHaveLength(1);
      expect(copy.restoration).toMatchObject({ filesCopied: 4, temporaryCopyRemoved: true });
      expect(copy.restoration.bytesCopied).toBeGreaterThan(copy.content.raw.bytes);
      expect(copy.restoration.sourceFilesSha256).toBe(copy.restoration.restoredFilesSha256);
    }
    expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls.every(call => call.command.includes('secretary_mail_desk.py restoration --message '))).toBe(true);
    expect((await request(app).post(url()).send(input(key)).expect(200)).body.data.replayed).toBe(true);
    expect(fixture.calls).toHaveLength(2);
    const current = await request(app).get(url(key) + '?verification=preservation').expect(200);
    expect(current.headers['cache-control']).toBe('private, no-store');
    expect(current.body.data.receipt.nativeState).toBe('current');
    expect(current.body.data.receipt.verification).toBe('restoration');
    expect(fixture.calls).toHaveLength(4); expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
    expect((await Entry.findById(id).lean()).preservationChecks[0].snapshotHash).toBe(first.snapshotHash);
    expect((await request(app).get(url()).expect(200)).body.data.receipts[0].verification).toBe('restoration');
    const text = JSON.stringify(response.body);
    expect(text).not.toContain(fixture.roots.primary); expect(text).not.toContain(fixture.temporaryRoot);
    expect(text).not.toContain('Synthetic complete body');
  });

  test('corrupt mirror bytes leave the old receipt immutable and the fresh native state unknown', async () => {
    const key = randomUUID();
    const original = (await request(app).post(url()).send(input(key)).expect(200)).body.data.receipt;
    await fs.writeFile(fixture.attachmentPaths.mirror, 'Synthetic corrupted copy');
    const current = (await request(app).get(url(key)).expect(200)).body.data.receipt;
    expect(current.nativeState).toBe('unknown'); expect(current.snapshotHash).toBe(original.snapshotHash);
    const fresh = (await request(app).post(url()).send(input(randomUUID())).expect(200)).body.data.receipt;
    expect(fresh.snapshot.status).toBe('blocked'); expect(fresh.snapshot.copies[1].status).toBe('unavailable');
    expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
  });

  test('full copied metadata stays pinned even when only an unrelated manifest member changes', async () => {
    const key = randomUUID();
    const first = (await request(app).post(url()).send(input(key)).expect(200)).body.data.receipt;
    const file = path.join(fixture.roots.primary, 'threads', fixture.source.threadId, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    manifest.messages[1].syntheticChange = 'unrelated metadata is copied but no unrelated original is read';
    await fs.writeFile(file, JSON.stringify(manifest));
    const current = (await request(app).get(url(key)).expect(200)).body.data.receipt;
    expect(current.nativeState).toBe('stale'); expect(current.snapshotHash).toBe(first.snapshotHash);
    expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
  });

  test('two aliases of one machine still fail the independent-copy check after real restoration', async () => {
    await fs.copyFile(fixture.machines.primary, fixture.machines.mirror);
    const result = (await request(app).post(url()).send(input(randomUUID())).expect(200)).body.data.receipt;
    expect(result.snapshot.status).toBe('blocked'); expect(result.snapshot.blockers).toContain('native_copies_on_same_machine');
    expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
  });

  test('family-selected audience refuses the new mode before any native temporary write', async () => {
    await request(mount('family')).post(url()).set('x-agentx-caller', 'owner').send(input(randomUUID())).expect(403);
    expect(fixture.calls).toEqual([]); expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
  });

  test('Python manifest client -> Core HTTP -> actual native restoration -> final Mongo fence', async () => {
    const source = Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(name => [name, fixture.source[name]]));
    const second = { ...source, messageId: '1234567890abcdfe' };
    // Two exact message identities share deduplicated synthetic original bytes,
    // while retaining separate raw receipts in the same two native archives.
    for (const root of Object.values(fixture.roots)) {
      const manifestPath = path.join(root, 'threads', source.threadId, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      manifest.messages.push({ ...manifest.messages[0], id: second.messageId });
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
      const rawReceipt = JSON.parse(await fs.readFile(path.join(root, 'raw-receipts', source.messageId + '.json'), 'utf8'));
      await fs.writeFile(path.join(root, 'raw-receipts', second.messageId + '.json'), JSON.stringify({ ...rawReceipt, messageId: second.messageId }));
    }
    const secondId = (await history.record({ kind: 'fact', text: 'Synthetic second restored message',
      sourceDate: '2024-01-01T00:00:00Z', source: { ...second, findingId: 'c'.repeat(64) } })).entry.id;
    const checks = [];
    for (const [entryId, reference] of [[id, source], [secondId, second]]) {
      const requestId = randomUUID();
      const receipt = (await request(app).post(`/api/secretary/history/${entryId}/preservation`)
        .send(input(requestId)).expect(200)).body.data.receipt;
      checks.push({ entryId, requestId, snapshotHash: receipt.snapshotHash, source: reference });
    }
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const program = ['import json,sys', 'sys.path.insert(0,sys.argv[1])',
        'from native_history_restoration_scope import capture',
        'value=capture(sys.argv[2],json.loads(sys.argv[3]),json.loads(sys.argv[4]))',
        'print(json.dumps({"status":value["status"],"members":len(value["snapshot"]["members"]),"executionAllowed":value["executionAllowed"]}))'].join('\n');
      const result = await promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
        path.resolve(__dirname, '../../../integrations/secretary'), `http://127.0.0.1:${server.address().port}`,
        JSON.stringify([source, second]), JSON.stringify(checks)], { timeout: 30000, maxBuffer: 4096 });
      expect(JSON.parse(result.stdout)).toEqual({ status: 'observed_match', members: 2, executionAllowed: false });
      expect(fixture.calls).toHaveLength(12); expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
      expect((await Entry.findById(id).lean()).preservationChecks).toHaveLength(1);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
