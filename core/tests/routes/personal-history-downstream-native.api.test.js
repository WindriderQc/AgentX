'use strict';

jest.mock('../../src/services/memoryNoteIndex', () => ({ createIndex: () => ({ indexNote: async () => false }) }));
jest.mock('../../src/services/souvenirRecallSync', () => ({ scheduleSouvenirRecallSync: jest.fn() }));
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { findingArchive } = require('../fixtures/historyFindingArchive');
const URL = '/api/secretary/history/decision-state/downstream';

(process.platform === 'win32' ? describe.skip : describe)('native downstream source -> Core memory -> owner HTTP -> Python client', () => {
  let fixture, app, id, noteId;
  const reference = () => Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(key => [key, fixture.source[key]]));
  const input = () => ({ source: reference(), observationId: randomUUID() });
  const mount = audience => {
    const app = express(), router = express.Router(); app.use(express.json());
    registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience, control: fixture.control },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router); return app;
  };
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => {
    for (const model of [Entry, MemoryNote, Suppression]) await model.deleteMany({});
    fixture = await findingArchive();
    id = (await history.record({ kind: 'fact', text: 'Synthetic private kept fact', sourceDate: null, source: fixture.source })).entry.id;
    noteId = (await history.keepAsSouvenir(id, { revision: 0 })).souvenirNoteId;
    app = mount('owner');
  });
  afterEach(async () => fixture.cleanup());

  test('native recorded source and current memory are hash-bound without private text or mutation', async () => {
    const before = await MemoryNote.findById(noteId).lean();
    const response = await request(app).post(URL).send(input()).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.data.snapshot.entries[0]).toMatchObject({ entryId: id, state: 'current_link',
      note: { id: noteId, sourceBinding: true, contextBinding: true, revision: 0 } });
    expect(response.body.data).toMatchObject({ atomicBatch: false, semanticAcceptance: false, executionAllowed: false, cleanupStatus: 'blocked' });
    expect(JSON.stringify(response.body)).not.toContain('Synthetic private'); expect(fixture.calls).toHaveLength(2);
    expect(await MemoryNote.findById(noteId).lean()).toEqual(before);
  });
  test('the actual owner-memory boundary holds a pending linked souvenir', async () => {
    await MemoryNote.updateOne({ _id: noteId }, { $set: { status: 'pending' } });
    const value = (await request(app).post(URL).send(input()).expect(200)).body.data;
    expect(value.snapshot.entries[0]).toMatchObject({ state: 'unavailable', note: null });
    expect(value.snapshot.coverage.blockers).toContain('linked_souvenirs_need_review');
  });
  test('family audience refuses before the native producer or memory observation', async () => {
    await request(mount('family')).post(URL).set('x-service-caller', 'owner').send(input()).expect(403);
    expect(fixture.calls).toEqual([]);
  });
  test('the real Python consumer accepts two fresh native scopes and no invented selected memory', async () => {
    const found = (await request(app).post('/api/secretary/history/decision-state/findings').send(input()).expect(200)).body.data;
    const discovery = (await request(app).post('/api/secretary/history/decision-state/discover').send(input()).expect(200)).body.data;
    const finding = { reference: reference(), snapshot: found.snapshot, fingerprint: found.fingerprint };
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
      const program = ['import sys,json', 'sys.path.insert(0,sys.argv[1])',
        'from native_history_downstream_scope import capture',
        'rows=capture(sys.argv[2],json.loads(sys.argv[3]),json.loads(sys.argv[4]),json.loads(sys.argv[5]))',
        'print(json.dumps({"messages":len(rows),"state":rows[0]["snapshot"]["entries"][0]["state"]}))'].join('\n');
      const value = await promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
        path.resolve(__dirname, '../../../integrations/secretary'), `http://127.0.0.1:${server.address().port}`,
        JSON.stringify([reference()]), JSON.stringify([finding]), JSON.stringify(discovery.entries)], { timeout: 30000, maxBuffer: 4096 });
      expect(JSON.parse(value.stdout)).toEqual({ messages: 1, state: 'current_link' });
      expect(await MemoryNote.countDocuments()).toBe(1); expect(fixture.calls).toHaveLength(6);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
