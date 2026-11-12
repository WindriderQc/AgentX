'use strict';

const express = require('express');
const request = require('supertest');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const Entry = require('../../models/PersonalHistoryEntry');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { findingArchive, control } = require('../fixtures/historyFindingArchive');
const URL = '/api/secretary/history/decision-state/findings';

(process.platform === 'win32' ? describe.skip : describe)('native recorded findings through actual Python archive command and owner Core HTTP', () => {
  let fixture, app, id;
  const input = () => ({ source: { system: 'gmail', messageId: fixture.source.messageId,
    threadId: fixture.source.threadId, sourceSha256: fixture.source.sourceSha256 }, observationId: randomUUID() });
  beforeAll(async () => { await Entry.createCollection(); await Entry.createIndexes(); await Suppression.createCollection(); });
  beforeEach(async () => {
    await Entry.deleteMany({}); await Suppression.deleteMany({}); fixture = await findingArchive();
    id = (await history.record({ kind: 'fact', text: 'Synthetic retained native fact', sourceDate: null, source: fixture.source })).entry.id;
    await history.review(id, { revision: 0, state: 'retained', reason: 'Synthetic explicit native decision' });
    app = express(); app.use(express.json()); const router = express.Router();
    registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience: 'owner', control: fixture.control },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router);
  });
  afterEach(async () => { jest.restoreAllMocks(); await fixture.cleanup(); });

  test('real recorded identifiers bind the exact source and expose every unrepresented finding', async () => {
    const result = (await request(app).post(URL).send(input()).expect(200)).body.data;
    expect(result.snapshot.inventory.reviewSha256).toBe(fixture.inventory.reviewSha256);
    expect(result.snapshot.inventory.findings).toHaveLength(2);
    expect(result.snapshot.coverage.counts).toMatchObject({ recordedFindings: 2, observedDecision: 1, noCoreReference: 1, threadQuestions: 1 });
    expect(result.snapshot.coverage.findings.find(item => item.section === 'memories').records[0].entryId).toBe(id);
    expect(fixture.calls).toHaveLength(2); expect(result.semanticAcceptance).toBe(false); expect(result.executionAllowed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Synthetic recorded action');
  });

  test('a changed native review during the two reads refuses instead of silently retaining the first inventory', async () => {
    const original = fixture.control.probe.bind(fixture.control); let calls = 0;
    jest.spyOn(fixture.control, 'probe').mockImplementation(async value => {
      const result = await original(value);
      if (++calls === 1) await fs.writeFile(fixture.reviewPath, JSON.stringify({ ...fixture.review, unresolved: [] }));
      return result;
    });
    await request(app).post(URL).send(input()).expect(409);
  });

  test('missing review metadata cannot become an empty native success', async () => {
    await fs.unlink(fixture.reviewPath);
    const result = await request(app).post(URL).send(input()).expect(503);
    expect(result.body.code).toBe('HISTORY_FINDINGS_UNAVAILABLE'); expect(fixture.calls).toHaveLength(1);
  });

  test('actual raw bytes are checked even when saved findings and their metadata are unchanged', async () => {
    const receipt = JSON.parse(await fs.readFile(path.join(fixture.root, 'raw-receipts', fixture.source.messageId + '.json'), 'utf8'));
    await fs.writeFile(path.join(fixture.root, receipt.path), 'Different original bytes');
    await request(app).post(URL).send(input()).expect(503);
  });

  test('explicit Core erasure after the last native reply cannot deliver an older finding report', async () => {
    const original = fixture.control.probe.bind(fixture.control); let calls = 0;
    jest.spyOn(fixture.control, 'probe').mockImplementation(async value => {
      const result = await original(value);
      if (++calls === 2) await history.review(id, { revision: 1, state: 'forgotten' });
      return result;
    });
    await request(app).post(URL).send(input()).expect(409);
  });

  test('the actual v4 CLI binds one synthetic archive to real native Core/producer replies and holds an unrepresented finding', async () => {
    const script = `import io,json,sys\nfrom contextlib import redirect_stdout\nfrom pathlib import Path\nfrom evidence_store import save,load\nfrom test_retention_dispositions import OwnerDispositionTests\nfrom retention_reconcile import main\nt=OwnerDispositionTests();t.setUp()\ntry:\n memory=t.with_finding('memories')\n t.with_finding('actions')\n t.lane('person')\n row=t.owned([])[0]\n print(json.dumps({'root':str(t.root),'source':{'system':'gmail','messageId':row['messageId'],'threadId':row['threadId'],'sourceSha256':row['sourceSha256'],'findingId':memory}}),flush=True)\n x=json.loads(sys.stdin.readline())\n snapshot=Path(t.temp.name)/'saved.json';output=Path(t.temp.name)/'native-review.json'\n save(snapshot,t.owned(x['entries']))\n with redirect_stdout(io.StringIO()) as summary:\n  code=main(['--root',str(t.root),'--before',t.before.isoformat(),'--dispositions',str(snapshot),'--output',str(output),'--core',x['core'],'--native-finding-scope'])\n print(json.dumps({'code':code,'summary':json.loads(summary.getvalue()),'report':load(output),'mode':output.stat().st_mode&0o777}),flush=True)\nfinally:\n t.doCleanups()\n`;
    const child = spawn('python3', ['-c', script], { env: { ...process.env,
      PYTHONPATH: [path.resolve(__dirname, '../../../integrations/secretary'), path.resolve(__dirname, '../../../integrations/secretary/tests')].join(path.delimiter)
    }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const reader = readline.createInterface({ input: child.stdout }), output = reader[Symbol.asyncIterator]();
    const completion = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
    let server;
    try {
      const first = await output.next(); expect(first.done).toBe(false);
      const setup = JSON.parse(first.value), calls = [];
      await Entry.deleteMany({});
      const fact = (await history.record({ kind: 'fact', text: 'Synthetic exact native finding', sourceDate: null, source: setup.source })).entry;
      await history.review(fact.id, { revision: 0, state: 'retained', reason: 'Synthetic recorded decision' });
      const router = express.Router(), full = express(); full.use(express.json());
      registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience: 'owner', control: control(setup.root, path.join(setup.root, 'no-config.json'), calls) },
        envelope: (res, data) => res.json({ ok: true, data }),
        fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
      full.use('/api/secretary', router); server = full.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const entries = (await history.list({ source: 'gmail', state: '' })).entries;
      const legacy = jest.spyOn(history, 'list');
      child.stdin.end(JSON.stringify({ core: `http://127.0.0.1:${server.address().port}`, entries }) + '\n');
      const final = await output.next(); expect(final.done).toBe(false);
      const result = JSON.parse(final.value);
      expect(await completion).toBe(0); expect(stderr).toBe(''); expect(result.code).toBe(2); expect(result.mode).toBe(0o600);
      expect(result.report.schema).toBe('agentx.secretary-retention-reconciliation/v4');
      expect(result.report.counts).toEqual({ observed_match: 1 });
      expect(result.summary.nativeFindings).toEqual({ messages: 1, heldMessages: 1, recordedFindings: 2 });
      const native = result.report.nativeFindingScopes[0];
      expect(native.snapshot.coverage.counts).toMatchObject({ observedDecision: 1, noCoreReference: 1 });
      expect(native.snapshot.coverage.blockers).toContain('recorded_findings_need_review');
      expect(result.report.executionAllowed).toBe(false); expect(calls).toHaveLength(2); expect(legacy).not.toHaveBeenCalled();
      expect(JSON.stringify(result.summary)).not.toContain(setup.source.messageId);
    } finally {
      child.stdin.destroy(); child.kill(); reader.close(); await completion;
      if (server) await new Promise(resolve => server.close(resolve));
    }
  });
});
