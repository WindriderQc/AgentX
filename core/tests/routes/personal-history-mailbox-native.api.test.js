'use strict';
const express = require('express');
const request = require('supertest');
const { randomUUID, createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { SecretaryMailControl } = require('../../integrations/runtime-bridges/secretary-mail-control');
const { SecretaryMailboxControl } = require('../../integrations/runtime-bridges/secretary-mailbox-control');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const RAW = Buffer.from('From: synthetic@example.invalid\r\n\r\nSynthetic private native body\r\n');
const reference = { system: 'gmail', messageId: '1234567890abcdef', threadId: '1234567890abcdea',
  sourceSha256: createHash('sha256').update(RAW).digest('hex') };
const URL = '/api/secretary/history/decision-state/mailbox';
const DRIVER = [
  'import sys,json,subprocess', 'from unittest.mock import patch', 'sys.path.insert(0,sys.argv[1])',
  'import secretary_mail_desk as desk', 'reply=json.loads(sys.argv[2])',
  'def fake(command,**kwargs):',
  ' assert command==["fake-gog","--readonly","--gmail-no-send","--no-input","--json","--enable-commands-exact=gmail.get","--account=synthetic@example.invalid","gmail","get","1234567890abcdef","--format=raw"]',
  ' assert kwargs["timeout"]==25',
  ' return subprocess.CompletedProcess(command,reply["code"],json.dumps(reply["data"]),reply["stderr"])',
  'with patch.object(desk,"native_settings",return_value={}), patch.object(desk,"gmail_environment",return_value={}), patch.object(desk.subprocess,"run",side_effect=fake):',
  ' desk.main(["--account","synthetic@example.invalid","--keyring-password-file","/unused/synthetic-key","--gog","fake-gog",*sys.argv[3:]])'
].join('\n');

(process.platform === 'win32' ? describe.skip : describe)('owner HTTP -> existing SSH transport -> native Python -> injected Gmail provider', () => {
  let calls, reply, control, app;
  const input = () => ({ source: reference, observationId: randomUUID() });
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => {
    for (const model of [Entry, MemoryNote, Suppression]) await model.deleteMany({});
    await history.record({ kind: 'fact', text: 'Synthetic private Core entry', sourceDate: null,
      source: { ...reference, findingId: 'b'.repeat(64) } });
    calls = [];
    reply = { code: 0, stderr: '', data: { message: { id: reference.messageId, threadId: reference.threadId,
      internalDate: '1234567890000', historyId: '99999999999999999999', labelIds: ['SENT', 'INBOX'], raw: RAW.toString('base64url') } } };
    control = new SecretaryMailboxControl({ reader: new SecretaryMailControl({ sshTarget: 'native.example.invalid', remoteRoot: '/opt/product',
      sshRunner: async (host, command) => {
        calls.push({ host, command }); const args = command.split(' ');
        if (args[0] !== '/usr/bin/python3' || args[1] !== '/opt/product/integrations/secretary/secretary_mail_desk.py'
          || args[2] !== 'mailbox-scope') throw new Error('Unexpected command');
        return promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', DRIVER,
          path.resolve(__dirname, '../../../integrations/secretary'), JSON.stringify(reply), ...args.slice(2)], { timeout: 10000, maxBuffer: 128 * 1024 });
      } }) });
    app = express(); const router = express.Router(); app.use(express.json());
    registerSecretaryHistoryRoutes({ router, mailboxScopeDeps: { audience: 'owner', control },
      envelope: (res, data) => res.json({ ok: true, data }), fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router);
  });
  test('actual native raw hashing, metadata and nonces cross both production transports', async () => {
    const before = await Entry.findOne().lean();
    const response = await request(app).post(URL).send(input()).expect(200), value = response.body.data;
    expect(value.snapshot.mailbox.current.raw).toEqual({ sha256: reference.sourceSha256, bytes: RAW.length });
    expect(value.snapshot.mailbox.current.historyId).toBe('99999999999999999999');
    expect(value.snapshot.coverage).toEqual({ sourceMatches: true, direction: 'sent', blockers: [] });
    expect(calls).toHaveLength(2); expect(calls[0].command).not.toBe(calls[1].command);
    expect(JSON.stringify(response.body)).not.toMatch(/Synthetic private|synthetic@example/);
    expect(await Entry.findOne().lean()).toEqual(before);
  });
  test('real Python consumer accepts two scopes from HTTP and the native raw reader', async () => {
    const discovery = (await request(app).post('/api/secretary/history/decision-state/discover').send(input()).expect(200)).body.data;
    const snapshot = { reference, coreScope: { contract: discovery.contract, fingerprint: discovery.fingerprint, members: discovery.snapshot.entries } };
    const { digest } = require('../../src/services/personalHistorySourceReviewSources');
    const finding = { reference, snapshot, fingerprint: digest(snapshot) };
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
      const program = ['import sys,json', 'from datetime import datetime,timezone', 'sys.path.insert(0,sys.argv[1])',
        'from native_history_mailbox_scope import capture',
        'rows=capture(sys.argv[2],json.loads(sys.argv[3]),json.loads(sys.argv[4]),datetime(2026,1,1,tzinfo=timezone.utc))',
        'print(json.dumps({"messages":len(rows),"held":bool(rows[0]["cutoffBlockers"] or rows[0]["snapshot"]["coverage"]["blockers"])}))'].join('\n');
      const result = await promisify(execFile)(process.env.AGENTX_PYTHON_BIN || 'python3', ['-c', program,
        path.resolve(__dirname, '../../../integrations/secretary'), `http://127.0.0.1:${server.address().port}`,
        JSON.stringify([reference]), JSON.stringify([finding])], { timeout: 30000, maxBuffer: 4096 });
      expect(JSON.parse(result.stdout)).toEqual({ messages: 1, held: false }); expect(calls).toHaveLength(4);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
  test.each([['404 not found', 200], ['403 permission denied synthetic-private', 503], ['503 unavailable synthetic-private', 503]])('native %s stays typed and content-free', async (stderr, status) => {
    reply.code = 1; reply.stderr = stderr;
    const response = await request(app).post(URL).send(input()).expect(status);
    if (status === 200) expect(response.body.data.snapshot.coverage.blockers).toEqual(['live_message_not_found']);
    expect(JSON.stringify(response.body)).not.toContain('synthetic-private');
    expect(calls).toHaveLength(status === 200 ? 2 : 1);
  });
  test('closed transport refuses injection before the SSH runner', async () => {
    await expect(control.probe({ ...reference, requestId: randomUUID(), messageId: reference.messageId + ';id' })).rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toEqual([]);
  });
  test('unconfigured transport refuses without a provider fallback', async () => {
    const probe = new SecretaryMailboxControl({ reader: { available: false, call: jest.fn() } });
    await expect(probe.probe({ ...reference, requestId: randomUUID() })).rejects.toMatchObject({ statusCode: 503 });
    expect(calls).toEqual([]);
  });
});
