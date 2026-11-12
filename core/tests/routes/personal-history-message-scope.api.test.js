'use strict';

const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const mongoose = require('mongoose');
const Entry = require('../../models/PersonalHistoryEntry');
const Suppression = require('../../models/PersonalHistorySuppression');
const MemoryNote = require('../../models/MemoryNote');
const history = require('../../src/services/personalHistoryService');
const privacy = require('../../src/services/personalHistoryPrivacy');
const scope = require('../../src/services/personalHistoryMessageScope');
const state = require('../../src/services/personalHistoryDecisionState');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { source } = require('../fixtures/historyPreservationProof');

const reference = { system: 'gmail', messageId: source.messageId, threadId: source.threadId, sourceSha256: source.sourceSha256 };
const URL = '/api/secretary/history/decision-state/discover';
const input = extra => ({ source: reference, observationId: randomUUID(), ...extra });
const deps = { audience: 'owner' };
const document = { system: 'document', id: 'synthetic-document', sourceSha256: 'c'.repeat(64), findingId: 'd'.repeat(64) };

describe('native exact-message Core membership discovery', () => {
  let app, id;
  function mount(audience = 'owner') {
    const app = express(), router = express.Router(); app.use(express.json());
    registerSecretaryHistoryRoutes({ router, messageScopeDeps: { audience },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router); return app;
  }
  const add = async (src, extra = {}) => (await history.record({ kind: 'action', text: 'Synthetic linked action',
    sourceDate: '2024-02-01T00:00:00Z', source: src, ...extra })).entry.id;
  beforeAll(async () => { await Entry.createCollection(); await Entry.createIndexes(); await Suppression.createCollection(); });
  beforeEach(async () => {
    await Entry.deleteMany({}); await Suppression.deleteMany({}); await MemoryNote.deleteMany({});
    id = await add(source, { kind: 'fact', text: 'Synthetic original finding' }); app = mount();
  });
  afterEach(() => jest.restoreAllMocks());

  test('discovers primary and related references across source systems, without unrelated same-thread messages', async () => {
    const other = { ...source, messageId: '1234567890abcdff', findingId: 'e'.repeat(64) };
    const linked = await add(document, { relatedSources: [source] });
    await add(other);
    await add({ ...document, id: 'unrelated-document', findingId: 'f'.repeat(64) });
    // Neither separate array member may supply the other's system/message field.
    await add({ ...document, id: 'split-ref-document', findingId: '1'.repeat(64) }, { relatedSources: [
      { ...document, messageId: source.messageId, threadId: source.threadId }, other
    ] });
    expect((await history.list({ source: 'gmail', state: '' })).entries.map(row => row.id)).not.toContain(linked);
    const original = await Entry.find({}).lean();
    const response = await request(app).post(URL).send(input()).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const value = response.body.data;
    expect(value.entries.map(entry => entry.id)).toEqual([id, linked].sort());
    expect(value.snapshot).toMatchObject({ contract: scope.CONTRACT, reference });
    expect(value.fingerprint).toBe(digest(value.snapshot));
    expect(value).toMatchObject({ consistency: 'two-agreeing-bounded-membership-queries',
      coverage: 'selected-message-visible-core-entries', atomicBatch: false, downstreamState: 'not_rechecked',
      authenticatedPerson: null, executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS });
    for (const pin of value.snapshot.entries) {
      const current = await state.get(pin.entryId, {}, deps);
      expect(pin).toMatchObject({ fingerprint: current.fingerprint, sourceBinding: 'exact' });
    }
    expect(await Entry.find({}).lean()).toEqual(original);
  });

  test('membership and decision changes invalidate the old scope; every fresh read echoes its own identity', async () => {
    const firstInput = input(), first = await scope.discover(firstInput, deps);
    const replayInput = input({ expected: first.fingerprint }), replay = await scope.discover(replayInput, deps);
    expect(replay.status).toBe('observed_match'); expect(replay.observationId).toBe(replayInput.observationId);
    expect(replay.observationId).not.toBe(first.observationId);
    await add(document, { relatedSources: [source] });
    expect((await scope.discover(input({ expected: first.fingerprint }), deps)).status).toBe('changed');
    const second = await scope.discover(input(), deps);
    await history.review(id, { revision: 0, state: 'dismissed', reason: 'Synthetic final decision' });
    expect((await scope.discover(input({ expected: second.fingerprint }), deps)).status).toBe('changed');
  });

  test.each(['threadId', 'sourceSha256'])('conflicting %s is reported instead of disappearing behind the selection hash', async key => {
    const conflicting = { ...reference, [key]: key === 'threadId' ? '9999999999999999' : '9'.repeat(64) };
    const result = await scope.discover(input({ source: conflicting }), deps);
    expect(result.entries.map(entry => entry.id)).toEqual([id]);
    expect(result.snapshot.entries[0].sourceBinding).toBe('conflict');
    expect(result.executionAllowed).toBe(false);
  });

  test('a conflicting related reference cannot hide beside an exact primary reference', async () => {
    await Entry.updateOne({ _id: id }, { $set: { relatedSources: [{ ...source, sourceSha256: '9'.repeat(64) }] } });
    expect((await scope.discover(input(), deps)).snapshot.entries[0].sourceBinding).toBe('conflict');
  });

  test.each(['new-entry', 'owner-decision', 'explicit-forget', 'privacy-hash-change'])('a %s during privacy lookup refuses the complete observation', async change => {
    jest.spyOn(privacy, 'forgottenSource').mockImplementationOnce(async () => {
      if (change === 'new-entry') await add(document, { relatedSources: [source] });
      else if (change === 'privacy-hash-change') await Entry.updateOne({ _id: id }, { $set: { contentHash: '9'.repeat(64) } }, { timestamps: false });
      else await history.review(id, { revision: 0, state: change === 'explicit-forget' ? 'forgotten' : 'dismissed',
        ...(change !== 'explicit-forget' ? { reason: 'Synthetic concurrent decision' } : {}) });
      return false;
    });
    const result = await request(app).post(URL).send(input()).expect(409);
    expect(result.body.code).toBe('HISTORY_MESSAGE_SCOPE_CHANGED');
    expect(JSON.stringify(result.body)).not.toContain('Synthetic original finding');
  });

  test('source-note suppression refuses the old scope and subsequent empty membership grants no acceptance', async () => {
    const noteId = '8'.repeat(24);
    await Entry.updateOne({ _id: id }, { $set: { 'source.personalNoteId': noteId } });
    await Suppression.create({ scope: 'owner', noteId, contentHash: '9'.repeat(64), forgottenAt: new Date() });
    await expect(scope.discover(input(), deps)).rejects.toMatchObject({ statusCode: 409 });
    const result = await scope.discover(input(), deps);
    expect(result.entries).toEqual([]); expect(result.snapshot.entries).toEqual([]);
    expect(result.executionAllowed).toBe(false); expect(result.nativeValidationGaps).toEqual(GAPS);
  });

  test('source bodies remain excluded and oversized scopes return no partial successful response', async () => {
    await Entry.updateOne({ _id: id }, { $set: { context: { revision: 1, inputHash: 'f'.repeat(64), importId: 'synthetic', reviewAuthority: 'imported-source-metadata',
      timeline: { title: 'Synthetic scope' }, sources: [{ id: 'fake', body: 'PRIVATE_SOURCE_BODY' }] } } });
    expect(JSON.stringify(await scope.discover(input(), deps))).not.toContain('PRIVATE_SOURCE_BODY');
    const base = await Entry.findById(id).lean(); delete base._id;
    await Entry.insertMany(Array.from({ length: 100 }, (_, i) => ({ ...base, _id: new mongoose.Types.ObjectId(), key: `synthetic-capacity-${i}` })));
    const result = await request(app).post(URL).send(input()).expect(413);
    expect(result.body.code).toBe('HISTORY_MESSAGE_SCOPE_CAPACITY'); expect(result.body.data).toBeUndefined();
  });

  test('a single very large projected entry hits the response-byte bound', async () => {
    await Entry.updateOne({ _id: id }, { $set: { context: { revision: 1, inputHash: 'f'.repeat(64),
      timeline: { title: 'Synthetic byte bound', large: 'x'.repeat(4 * 1024 * 1024) } } } });
    const response = await request(app).post(URL).send(input()).expect(413);
    expect(response.body.message).toContain('record or byte capacity');
  });

  test('aggregate stored bytes are bounded even when each record and the member count fit', async () => {
    const base = await Entry.findById(id).lean(); delete base._id;
    await Entry.insertMany(Array.from({ length: 80 }, (_, i) => ({ ...base, _id: new mongoose.Types.ObjectId(),
      key: `synthetic-byte-capacity-${i}`, context: { revision: 1, inputHash: 'f'.repeat(64), importId: `synthetic-${i}`,
        reviewAuthority: 'imported-source-metadata', timeline: { large: 'x'.repeat(110 * 1024) } }
    })));
    const response = await request(app).post(URL).send(input()).expect(413);
    expect(response.body.message).toContain('record or byte capacity');
  });

  test.each([{ source: { ...reference, messageId: [source.messageId] } }, { source: { ...reference, sourceSha256: ['a'.repeat(64)] } },
    { source: { ...reference, system: 'outlook-export' } }, { source: { ...reference, host: 'untrusted' } },
    { expected: ['a'.repeat(64)] }, { observationId: 'bad' }, { verified: true }, { audience: 'owner' }])('rejects malformed or client authority input: %p', async extra => {
    await request(app).post(URL).send(input(extra)).expect(400);
  });

  test('server-selected family and actual pinned-family boundary refuse discovery before history reads', async () => {
    const read = jest.spyOn(Entry, 'aggregate');
    await request(mount('family')).post(URL).set('x-agentx-caller', 'owner').send(input()).expect(403);
    expect(read).not.toHaveBeenCalled(); read.mockRestore();
    const guarded = express(); guarded.use(require('cookie-parser')());
    require('../../surfaces/household/family-device').register({ app: guarded, mongoose,
      standardJsonParser: express.json(), ownerUnlock: { activeUntil: async () => null },
      envelope: (res, data, status = 200) => res.status(status).json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    await mongoose.model('AgentXHouseholdFamilyDevice').createCollection(); guarded.use(app);
    const cookie = (await request(guarded).post('/api/household/family-device/pin').send({ label: 'Synthetic family screen' }).expect(201)).headers['set-cookie'];
    await request(guarded).post(URL).set('Cookie', cookie).send(input()).expect(403);
  });

  test('the actual archive/Python/HTTP/Mongo chain finds an open document action hidden from the previous Gmail export', async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const script = `import json,sys\nfrom test_retention_dispositions import OwnerDispositionTests\nfrom retention_reconcile import reconcile\nt=OwnerDispositionTests()\nt.setUp()\ntry:\n f=t.with_finding()\n t.lane('person')\n row=t.owned([])[0]\n print(json.dumps({'source':{'system':'gmail','messageId':row['messageId'],'threadId':row['threadId'],'sourceSha256':row['sourceSha256'],'findingId':f}}),flush=True)\n x=json.loads(sys.stdin.readline())\n saved=t.owned(x['entries'])\n result=reconcile(t.archive,t.before,saved,x['core'],message_scope=True)\n print(json.dumps(result),flush=True)\nfinally:\n t.doCleanups()\n`;
    const child = spawn('python3', ['-c', script], { env: { ...process.env,
      PYTHONPATH: [path.resolve(__dirname, '../../../integrations/secretary'), path.resolve(__dirname, '../../../integrations/secretary/tests')].join(path.delimiter)
    }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const lines = readline.createInterface({ input: child.stdout });
    const output = lines[Symbol.asyncIterator]();
    const completion = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
    try {
      const initial = await output.next(); expect(initial.done).toBe(false);
      const src = JSON.parse(initial.value).source;
      await Entry.deleteMany({});
      const fact = await add(src, { kind: 'fact', text: 'Synthetic archived finding' });
      await history.review(fact, { revision: 0, state: 'retained', reason: 'Synthetic prior decision' });
      const hidden = await add(document, { relatedSources: [src] });
      const previous = (await history.list({ source: 'gmail', state: '' })).entries;
      expect(previous.map(row => row.id)).toEqual([fact]);
      const legacy = jest.spyOn(history, 'list');
      child.stdin.end(JSON.stringify({ core: `http://127.0.0.1:${server.address().port}`, entries: previous }) + '\n');
      const final = await output.next();
      expect(final.done).toBe(false);
      const report = JSON.parse(final.value);
      expect(await completion).toBe(0); expect(stderr).toBe('');
      expect(report.schema).toBe('agentx.secretary-retention-reconciliation/v3');
      expect(report.counts).toEqual({ changed: 1 });
      expect(report.messages[0].changedFields).toContain('undecidedEntries');
      expect(report.nativeDecisions.entries.map(row => row.entryId).sort()).toEqual([fact, hidden].sort());
      expect(report.nativeDecisions.discoveryContract).toBe(scope.CONTRACT);
      expect(report.nativeDecisions.messageScopes[0].members).toHaveLength(2);
      expect(report.nativeValidationGaps).toEqual(GAPS); expect(report.executionAllowed).toBe(false);
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      child.stdin.destroy(); child.kill(); lines.close(); await completion;
      await new Promise(resolve => server.close(resolve));
    }
  });
});
