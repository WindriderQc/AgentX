'use strict';
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const fs = require('node:fs/promises');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { findingArchive } = require('../fixtures/historyFindingArchive');
const URL = '/api/secretary/history/decision-state/global';

(process.platform === 'win32' ? describe.skip : describe)('global native decisions -> actual archive reader -> HTTP -> Python consumer', () => {
  let fixture, app;
  const reference = () => Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(key => [key, fixture.source[key]]));
  const input = () => ({ sources: [reference()], observationId: randomUUID() });
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => {
    for (const model of [Entry, MemoryNote, Suppression]) await model.deleteMany({});
    fixture = await findingArchive();
    await history.record({ kind: 'fact', text: 'Synthetic private global fact', sourceDate: null, source: fixture.source });
    app = express(); const router = express.Router(); app.use(express.json());
    registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience: 'owner', control: fixture.control },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router);
  });
  afterEach(async () => fixture.cleanup());
  test('two complete native passes keep recorded gaps and original files without private text or writes', async () => {
    const before = await Entry.find().lean(), review = await fs.readFile(fixture.reviewPath);
    const response = await request(app).post(URL).send(input()).expect(200);
    expect(response.body.data.snapshot.coverage.counts).toMatchObject({ messages: 1, entries: 1, recordedFindings: 2, heldMessages: 1 });
    expect(response.body.data).toMatchObject({ semanticAcceptance: false, atomicBatch: false, executionAllowed: false, cleanupStatus: 'blocked' });
    expect(fixture.calls).toHaveLength(4); expect(await Entry.find().lean()).toEqual(before);
    expect(await fs.readFile(fixture.reviewPath)).toEqual(review); expect(JSON.stringify(response.body)).not.toContain('Synthetic private');
  });
  test('the real Python client consumes two global native observations from owner HTTP', async () => {
    const found = (await request(app).post('/api/secretary/history/decision-state/findings').send({ source: reference(), observationId: randomUUID() }).expect(200)).body.data;
    const finding = { reference: reference(), snapshot: found.snapshot, fingerprint: found.fingerprint };
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
      const program = ['import sys,json', 'sys.path.insert(0,sys.argv[1])', 'from native_history_global_decisions import capture',
        'value=capture(sys.argv[2],json.loads(sys.argv[3]),json.loads(sys.argv[4]))',
        'print(json.dumps(value["snapshot"]["coverage"]["counts"]))'].join('\n');
      const value = await promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
        path.resolve(__dirname, '../../../integrations/secretary'), `http://127.0.0.1:${server.address().port}`,
        JSON.stringify([reference()]), JSON.stringify([finding])], { timeout: 30000, maxBuffer: 4096 });
      expect(JSON.parse(value.stdout)).toMatchObject({ messages: 1, entries: 1, heldMessages: 1 });
      expect(fixture.calls).toHaveLength(10);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
