'use strict';
const express = require('express');
const request = require('supertest');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const preservation = require('../../src/services/personalHistoryPreservation');
const privacy = require('../../src/services/personalHistoryPrivacy');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { storageArchive } = require('../fixtures/historyStorageArchive');
const API = '/api/secretary/history/storage-scope';

(process.platform === 'win32' ? describe.skip : describe)('native source FDs, kernel metadata fixture and real storage observation HTTP', () => {
  let fixture, app, id;
  const ref = () => Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(key => [key, fixture.source[key]]));
  const observe = () => request(app).post(API).send({ sources: [ref()], observationId: randomUUID() });
  beforeAll(async () => { for (const model of [Entry, Suppression]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => {
    await Entry.deleteMany({}); await Suppression.deleteMany({}); fixture = await storageArchive();
    id = (await history.record({ kind: 'fact', text: 'Synthetic private native storage source', sourceDate: null, source: fixture.source })).entry.id;
    app = express(); app.use(express.json()); const router = express.Router();
    registerSecretaryHistoryRoutes({ router, preservationDeps: { audience: 'owner', control: fixture.control },
      findingScopeDeps: { audience: 'owner', control: fixture.findings },
      envelope: (res, data) => res.json({ ok: true, status: 'success', data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router);
  });
  afterEach(async () => { jest.restoreAllMocks(); await fixture.cleanup(); });
  const noCopies = async () => expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);

  test('production reader and parser bind all restored files; the strict Python consumer also binds prior native scopes', async () => {
    const rows = await Entry.find({}).lean();
    const value = (await observe().expect(200)).body.data;
    expect(value.snapshot.coverage.counts).toEqual({ messages: 1, distinctKernelDeviceMessages: 1, heldMessages: 0 });
    expect(value.nativeValidationGaps).toEqual(GAPS); expect(value.physicalIndependenceAccepted).toBe(false);
    for (const copy of value.snapshot.members[0].copies) {
      expect(copy.storage.files).toBe(copy.restoration.filesCopied);
      expect(copy.storage.filesSha256).toBe(copy.content.reviewPacket.filesSha256);
      expect(copy.restoration.temporaryCopyRemoved).toBe(true);
    }
    expect(await Entry.find({}).lean()).toEqual(rows);
    // Retained v3 probes use the existing native route through its original
    // fixture transport. Only the new storage endpoint selects the new reader.
    const receipt = (await preservation.prepare(id, { requestId: randomUUID(), revision: 0, source: 0, verification: 'review-restoration' },
      { audience: 'owner', control: fixture.reviewControl })).receipt;
    const check = { entryId: id, requestId: receipt.requestId, snapshotHash: receipt.snapshotHash, source: ref() };
    const probe = fixture.control.probeReviewRestoration;
    fixture.control.probeReviewRestoration = fixture.reviewControl.probeReviewRestoration.bind(fixture.reviewControl);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
      const program = ['import sys,json', 'from pathlib import Path', 'from types import SimpleNamespace',
        'sys.path.insert(0,sys.argv[1])', 'import urllib.request',
        'from native_history_message_scope import discover', 'from native_history_review_restoration import capture as review',
        'from native_history_storage_scope import capture', 'a=json.loads(sys.argv[3])',
        'url=sys.argv[2]', 'saved=[a["reference"]]',
        'req=urllib.request.Request(url+"/api/secretary/history/decision-state/findings",data=json.dumps({"source":a["reference"],"observationId":a["nonce"]}).encode(),headers={"Content-Type":"application/json"})',
        'with urllib.request.urlopen(req,timeout=30) as r: f=json.load(r)["data"]',
        'findings=[{"reference":a["reference"],"snapshot":f["snapshot"],"fingerprint":f["fingerprint"]}]',
        'v=review(url,saved,[a["check"]],SimpleNamespace(root=Path(a["root"])),findings)',
        'entries,scopes=discover(url,saved)', 'result=capture(url,saved,scopes,v)',
        'print(json.dumps({"messages":result["snapshot"]["coverage"]["counts"]["messages"],"gaps":result.get("nativeValidationGaps",[]) ,"status":result.get("status")}))'].join('\n');
      const result = await promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
        path.resolve(__dirname, '../../../integrations/secretary'), `http://127.0.0.1:${server.address().port}`,
        JSON.stringify({ reference: ref(), check, root: fixture.roots.primary, nonce: randomUUID() })], { timeout: 120000, maxBuffer: 4096 });
      expect(JSON.parse(result.stdout)).toMatchObject({ messages: 1 });
      await noCopies();
    } finally { fixture.control.probeReviewRestoration = probe; await new Promise(resolve => server.close(resolve)); }
  }, 150000);

  test('same native whole disk and unsupported mount remain held instead of becoming independence acceptance', async () => {
    await fs.writeFile(path.join(fixture.kernels.mirror.disk, 'wwid'), 'naa.5000000000000001\n');
    const shared = (await observe().expect(200)).body.data;
    expect(shared.snapshot.members[0].coverage.blockers).toContain('kernel_device_identity_overlap');
    await fs.writeFile(fixture.kernels.mirror.mountinfo, (await fs.readFile(fixture.kernels.mirror.mountinfo, 'utf8')).replace(' - ext4 ', ' - overlay '));
    const unknown = (await observe().expect(200)).body.data;
    expect(unknown.snapshot.members[0].coverage.blockers).toContain('storage_topology_unqualified');
    expect(unknown.physicalIndependenceAccepted).toBe(false); expect(unknown.nativeValidationGaps).toEqual(GAPS); await noCopies();
  }, 120000);

  test('late privacy erasure after the final native restore refuses all metadata', async () => {
    const read = fixture.control.probeStorageEvidence.bind(fixture.control); let calls = 0;
    fixture.control.probeStorageEvidence = async (...args) => {
      const value = await read(...args); if (++calls === 4) await privacy.suppress({ _id: id }); return value;
    };
    const failed = (await observe().expect(409)).body; expect(failed.data).toBeUndefined(); await noCopies();
  }, 120000);
});
