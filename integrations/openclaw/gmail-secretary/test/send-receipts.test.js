import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendOnce } from '../lib/send-receipts.js';
import { createPlugin } from '../lib/tools.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gmail-send-receipt-'));
  t.after(() => rm(root, { recursive: true }));
  return { root, callId: 'synthetic-call', context: { agentId: 'mail', sessionKey: 'agent:mail:direct:synthetic' },
    config: { account: 'synthetic', evidenceRoot: root, triageStateFile: path.join(root, 'triage.json') },
    params: { action: 'new', to: ['synthetic@example.invalid'], body: 'Synthetic body' } };
}

test('a confirmed send replays its durable provider receipt without dispatching twice', async t => {
  const setup = await fixture(t);
  let calls = 0;
  const dispatch = async () => { calls++; return { messageId: 'synthetic-sent', threadId: 'synthetic-thread' }; };
  assert.equal((await sendOnce({ ...setup, dispatch })).sendReceipt.durable, true);
  const replay = await sendOnce({ ...setup, dispatch });
  assert.equal(replay.messageId, 'synthetic-sent');
  assert.equal(replay.sendReceipt.replayed, true);
  assert.equal(calls, 1);
  await assert.rejects(sendOnce({ ...setup, params: { ...setup.params, body: 'Changed' }, dispatch }), { code: 'GMAIL_SEND_IDENTITY_CONFLICT' });
  assert.equal(calls, 1);
});

test('concurrent and lost replies keep the original fence without another send', async t => {
  const setup = await fixture(t);
  let started, release, calls = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const dispatch = async () => { calls++; started(); await released; throw new Error('Synthetic lost reply'); };
  const initial = sendOnce({ ...setup, dispatch });
  const initialFailure = assert.rejects(initial, { code: 'GMAIL_SEND_RECONCILIATION_REQUIRED' });
  await entered;
  await assert.rejects(sendOnce({ ...setup, dispatch }), { code: 'GMAIL_SEND_RECONCILIATION_REQUIRED' });
  release();
  await initialFailure;
  await assert.rejects(sendOnce({ ...setup, dispatch }), { code: 'GMAIL_SEND_RECONCILIATION_REQUIRED' });
  assert.equal(calls, 1);
});

test('a native identity and a provider message id are required', async t => {
  const setup = await fixture(t);
  await assert.rejects(sendOnce({ ...setup, context: {}, dispatch: () => assert.fail('no dispatch') }), /native session/);
  await assert.rejects(sendOnce({ ...setup, dispatch: async () => ({ ok: true }) }), { code: 'GMAIL_SEND_RECONCILIATION_REQUIRED' });
});

test('audit failure preserves a certain native send and the same call replays its result', async t => {
  const setup = await fixture(t);
  const executable = path.join(setup.root, 'fake-gog');
  const marker = path.join(setup.root, 'dispatches');
  const raw = Buffer.from('From: owner@example.invalid\r\nTo: synthetic@example.invalid\r\nSubject: Synthetic\r\n\r\nSynthetic body').toString('base64url');
  await writeFile(executable, `#!/usr/bin/env node
const args=process.argv.slice(2), exact=args.find(arg=>arg.startsWith('--enable-commands-exact='));
let value;
if(exact==='--enable-commands-exact=gmail.drafts.create') value={draftId:'synthetic-draft'};
else if(exact==='--enable-commands-exact=gmail.drafts.get') value={draft:{id:'synthetic-draft',message:{raw:${JSON.stringify(raw)},threadId:'synthetic-thread'}}};
else if(exact==='--enable-commands-exact=gmail.send') {
  require('node:assert/strict').ok(args.includes('--raw-file=-'));
  require('node:fs').appendFileSync(${JSON.stringify(marker)},'sent\\n');value={id:'synthetic-sent'};
} else throw Error('Unexpected command');
process.stdout.write(JSON.stringify(value));`, { mode: 0o700 });
  await writeFile(path.join(setup.root, 'keyring'), 'synthetic-placeholder');
  await writeFile(path.join(setup.root, 'bad-parent'), 'not a directory');
  const tools = new Map(), hooks = new Map();
  createPlugin(value => value).register({ pluginConfig: { ...setup.config, gogPath: executable,
    keyringPasswordFile: path.join(setup.root, 'keyring'), auditLog: path.join(setup.root, 'bad-parent/audit.jsonl') },
    registerTool: (tool, options) => tools.set(options.name || tool.name, typeof tool === 'function' ? tool(setup.context) : tool),
    on: (name, hook) => hooks.set(name, hook) });
  const send = tools.get('gmail_secretary_send');
  const approval = await hooks.get('before_tool_call')({ toolName: send.name, toolCallId: setup.callId, params: setup.params }, setup.context);
  approval.requireApproval.onResolution('allow-once');
  for (let n = 0; n < 2; n++) {
    const reply = JSON.parse((await send.execute(setup.callId, setup.params)).content[0].text);
    assert.equal(reply.id, 'synthetic-sent');
    assert.equal(reply.audit.recorded, false);
    assert.equal(reply.draftRetained, true);
  }
  assert.equal((await readFile(marker, 'utf8')).trim(), 'sent');
});
