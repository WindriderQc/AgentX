'use strict';
jest.mock('../../src/services/memoryNoteIndex', () => ({ createIndex: () => ({ indexNote: async () => false }) }));
jest.mock('../../src/services/souvenirRecallSync', () => ({ scheduleSouvenirRecallSync: jest.fn() }));
const express = require('express');
const request = require('supertest');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { BSON } = require('mongoose').mongo;
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const memory = require('../../src/services/memoryNoteService');
const scope = require('../../src/services/personalHistoryMessageScope');
const engine = require('../../src/services/coreTemporaryRestoration');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { findingArchive } = require('../fixtures/historyFindingArchive');
const URL = '/api/secretary/history/core-restoration';

(process.platform === 'win32' ? describe.skip : describe)('current selected Core native BSON/index/business-query restoration', () => {
  let fixture, app, id, noteId;
  const reference = () => Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(k => [k, fixture.source[k]]));
  const input = extra => ({ sources: [reference()], observationId: randomUUID(), ...extra });
  const mount = (audience = 'owner') => {
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
    id = (await history.record({ kind: 'fact', text: 'Synthetic private Core copy source', sourceDate: null, source: fixture.source })).entry.id;
    noteId = (await history.keepAsSouvenir(id, { revision: 0 })).souvenirNoteId;
    const marker = { double: new BSON.Double(1), integer: new BSON.Int32(1), long: BSON.Long.fromString('9007199254740999'),
      binary: new BSON.Binary(Buffer.from([1, 2, 3])), body: 'Synthetic private full record body' };
    await Entry.collection.updateOne({ _id: new BSON.ObjectId(id) }, { $set: { restorationMarker: marker } });
    await MemoryNote.collection.updateOne({ _id: new BSON.ObjectId(noteId) }, { $set: { restorationMarker: marker, embedding: [new BSON.Double(0.25)] } });
    app = mount();
  });
  afterEach(async () => { jest.restoreAllMocks(); await fixture.cleanup(); });
  const observe = async extra => (await request(app).post(URL).send(input(extra)).expect(200)).body.data;
  const temporaries = async () => (await Entry.db.db.listCollections({}, { nameOnly: true }).toArray()).filter(row => row.name.startsWith('__agentx_core_restore_'));

  test('real Mongo copies full BSON and indexes and runs Core queries without exposing or mutating sources', async () => {
    const before = { history: await Entry.collection.findOne({ _id: new BSON.ObjectId(id) }, { raw: true }),
      note: await MemoryNote.collection.findOne({ _id: new BSON.ObjectId(noteId) }, { raw: true }) };
    const response = await request(app).post(URL).send(input()).expect(200), value = response.body.data;
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(value).toMatchObject({ contract: 'agentx.history-core-restoration/v1', reviewOnly: true,
      atomicBatch: false, authenticatedPerson: null, semanticAcceptance: false, canonicalEffects: 0,
      executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS, indexState: 'mongo-index-definitions-only' });
    expect(value.snapshot.restoration.temporaryCopyRemoved).toBe(true);
    for (const group of Object.values(value.snapshot.restoration.collections)) {
      expect(group.documents).toBe(1); expect(group.bytes).toBeGreaterThan(100);
      expect(group.sourceDocumentsSha256).toBe(group.restoredDocumentsSha256);
      expect(group.sourceIndexesSha256).toBe(group.restoredIndexesSha256);
    }
    expect(value.snapshot.bindingsSha256).toBe(digest(value.snapshot.bindings));
    expect(value.snapshot.restoration.verificationSha256).toBe(value.snapshot.bindingsSha256);
    expect(JSON.stringify(value)).not.toMatch(/Synthetic|__agentx_core_restore_|restorationMarker|embedding/);
    expect(await temporaries()).toEqual([]);
    expect((await Entry.collection.findOne({ _id: new BSON.ObjectId(id) }, { raw: true })).equals(before.history)).toBe(true);
    expect((await MemoryNote.collection.findOne({ _id: new BSON.ObjectId(noteId) }, { raw: true })).equals(before.note)).toBe(true);
    expect((await observe({ expected: value.fingerprint, expectedBindingsSha256: value.snapshot.bindingsSha256 })).status).toBe('observed_match');
  });
  test.each(['body', 'embedding', 'forget', 'new-member'])('late source %s change is refused after owned copies are gone', async kind => {
    const original = engine.restore;
    jest.spyOn(engine, 'restore').mockImplementation(async (...args) => {
      const value = await original(...args);
      if (kind === 'body') await Entry.collection.updateOne({ _id: new BSON.ObjectId(id) }, { $set: { 'restorationMarker.body': 'Synthetic later body without metadata revision' } });
      if (kind === 'embedding') await MemoryNote.collection.updateOne({ _id: new BSON.ObjectId(noteId) }, { $set: { embedding: [new BSON.Double(0.75)] } });
      if (kind === 'forget') await memory.personal().forget(noteId);
      if (kind === 'new-member') await history.record({ kind: 'fact', text: 'Synthetic new selected entry', sourceDate: null,
        source: { ...fixture.source, findingId: '8'.repeat(64) } });
      return value;
    });
    await request(app).post(URL).send(input()).expect(409);
    expect(await temporaries()).toEqual([]);
  });
  test('privacy await inside the final full source read cannot hide late BSON bytes', async () => {
    const original = scope.observeSelection; let full = 0;
    jest.spyOn(scope, 'observeSelection').mockImplementation(async (refs, options) => {
      // Source initial, restored model query, source final.
      if (options?.fullDocuments && ++full === 3) {
        const privacy = require('../../src/services/personalHistoryPrivacy');
        jest.spyOn(privacy, 'forgottenSource').mockImplementationOnce(async () => {
          await Entry.collection.updateOne({ _id: new BSON.ObjectId(id) }, { $set: { 'restorationMarker.body': 'Synthetic final privacy mutation' } }); return false;
        });
      }
      return original(refs, options);
    });
    await request(app).post(URL).send(input()).expect(409); expect(full).toBe(3);
  });
  test('family, forged store/targets and stale binding refuse before private copies', async () => {
    const restore = jest.spyOn(engine, 'restore');
    await request(mount('family')).post(URL).set('x-service-caller', 'owner').send(input()).expect(403);
    for (const extra of [{ target: Entry.collection.name }, { db: 'other' }, { fullDocuments: true }, { sources: [] },
      { sources: [reference(), reference()] }, { expectedBindingsSha256: true }]) {
      await request(app).post(URL).send(input(extra)).expect(400);
    }
    await request(app).post(URL).send(input({ expectedBindingsSha256: '0'.repeat(64) })).expect(409);
    expect(restore).not.toHaveBeenCalled(); expect(await temporaries()).toEqual([]);
  });
  test('an oversized vector cannot be silently omitted from the complete source copy', async () => {
    const restore = jest.spyOn(engine, 'restore');
    await MemoryNote.collection.updateOne({ _id: new BSON.ObjectId(noteId) }, { $set: { embedding: Array(70000).fill(0.25) } });
    await request(app).post(URL).send(input()).expect(413);
    expect(restore).not.toHaveBeenCalled(); expect(await temporaries()).toEqual([]);
  });
  test('source collection options outside this record/index scope refuse before private copies', async () => {
    const restore = jest.spyOn(engine, 'restore');
    const db = Entry.db.db, original = db.listCollections.bind(db);
    jest.spyOn(db, 'listCollections').mockImplementation((filter, options) => {
      if (filter?.name !== Entry.collection.name) return original(filter, options);
      return { next: async () => ({ ...(await original(filter, options).next()), options: { validator: { $expr: { $eq: [1, 1] } } } }) };
    });
    await request(app).post(URL).send(input()).expect(503);
    expect(restore).not.toHaveBeenCalled(); expect(await temporaries()).toEqual([]);
  });
  test('Python consumes native restoration bound to the already verified global downstream scope', async () => {
    const downstream = (await request(app).post('/api/secretary/history/decision-state/downstream/global').send(input()).expect(200)).body.data;
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
      const program = ['import sys,json', 'sys.path.insert(0,sys.argv[1])', 'from native_history_core_restoration import capture',
        'value=capture(sys.argv[2],json.loads(sys.argv[3]),json.loads(sys.argv[4]))',
        'print(json.dumps({"status":value["status"],"entries":value["snapshot"]["restoration"]["collections"]["history"]["documents"],"notes":value["snapshot"]["restoration"]["collections"]["souvenirs"]["documents"]}))'].join('\n');
      const result = await promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
        path.resolve(__dirname, '../../../integrations/secretary'), `http://127.0.0.1:${server.address().port}`,
        JSON.stringify([reference()]), JSON.stringify(downstream)], { timeout: 30000, maxBuffer: 4096 });
      expect(JSON.parse(result.stdout)).toEqual({ status: 'observed_match', entries: 1, notes: 1 });
      expect(await temporaries()).toEqual([]);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
