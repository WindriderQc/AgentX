import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendGate, inspectSnapshot, sendDescription } from '../lib/send-approval.js';
import { createPlugin, buildSendCommand } from '../lib/tools.js';

const config = { account: 'auto' };
const owner = { agentId: 'mail', sessionKey: 'agent:mail:direct:synthetic' };
const params = { action: 'new', to: ['to@example.test'], body: 'Hello' };
function mime({ bcc = 'hidden@example.test', body = 'Hello', attachment = 'c2VjcmV0', cc = 'copy@example.test' } = {}) {
  return Buffer.from([
    'From: Owner <owner@example.test>', 'To: Recipient <to@example.test>', `Cc: ${cc}`, `Bcc: ${bcc}`,
    'Subject: =?utf-8?b?Qm9uam91ciDinJM=?=', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="test"', '',
    '--test', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(body).toString('base64'), '--test', 'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="synthetic.pdf"', 'Content-Transfer-Encoding: base64', '', attachment,
    '--test--', '',
  ].join('\r\n')).toString('base64url');
}

function mailbox(options = {}) {
  let clock = 1000;
  const calls = [], state = { raw: mime(), threadId: 'thread-1' };
  const run = async command => {
    calls.push(command);
    const exact = command.args.find(arg => arg.startsWith('--enable-commands-exact='));
    if (exact === '--enable-commands-exact=gmail.drafts.get') {
      assert.ok(command.args.includes('--readonly'));
      assert.ok(command.args.includes('--gmail-no-send'));
      assert.ok(command.args.includes('--format=raw'));
      assert.ok(!command.args.includes('--wrap-untrusted'));
      return { draft: { id: 'draft-1', message: { raw: state.raw, threadId: state.threadId } } };
    }
    if (exact.startsWith('--enable-commands-exact=gmail.drafts.')) {
      assert.ok(command.args.includes('--gmail-no-send'));
      clock += options.preparationMs || 0;
      return { draftId: 'draft-1' };
    }
    assert.equal(exact, '--enable-commands-exact=gmail.send');
    if (options.mutateBeforeSend) state.raw = mime({ bcc: 'changed@example.test' });
    return { id: 'sent-1' };
  };
  const nativeGate = sendGate({ run, now: () => clock, ...options });
  return { calls, state, advance: ms => { clock += ms; }, gate: {
    before: (event, config, origin, build, context = owner) => nativeGate.before(event, config, origin, build, context),
    execute: (id, params, config, context = owner) => nativeGate.execute(id, params, config, context),
  } };
}
const event = (value = params, id = 'call-1') => ({ toolCallId: id, params: value });
const prepare = (box, value = params, id = 'call-1') => box.gate.before(event(value, id), config, 'owner_turn', buildSendCommand);
const sends = box => box.calls.filter(call => call.args.includes('--raw-file=-'));

test('the native approval names resolved recipients, decoded subject, attachments and body', async () => {
  const box = mailbox();
  const { requireApproval: approval } = await prepare(box);
  for (const value of ['To:"to@example.test"', 'Cc:"copy@example.test"', 'Bcc:"hidden@example.test"',
    'Attachments:1', 'synthetic.pdf', '6B', 'Bonjour ✓', 'Body preview (5 chars):"Hello"', 'draft-1', 'SHA256:']) {
    assert.ok(approval.description.includes(value), value);
  }
  assert.ok(approval.description.length <= 512);
  assert.deepEqual(approval.allowedDecisions, ['allow-once', 'deny']);
  assert.equal(sends(box).length, 0);
  assert.equal(box.calls[0].args.includes('create'), true);
  approval.onResolution('allow-once');
  const result = await box.gate.execute('call-1', params, config);
  assert.equal(result.id, 'sent-1');
  assert.equal(result.draftRetained, true);
  assert.equal(result.retainedDraftId, 'draft-1');
  assert.deepEqual(sends(box)[0].stdin, Buffer.from(box.state.raw, 'base64url'));
  assert.ok(sends(box)[0].args.includes('--thread-id=thread-1'));
  assert.equal(box.calls.some(call => call.args.includes('delete')), false);
  await assert.rejects(box.gate.execute('call-1', params, config), /one-time approval/);
});

test('existing drafts with only Cc or Bcc recipients retain the native send capability', async () => {
  for (const field of ['Cc', 'Bcc']) {
    const box = mailbox(), value = { action: 'draft', id: 'draft-1' };
    box.state.raw = Buffer.from(`From: owner@example.test\r\n${field}: recipient@example.test\r\nSubject: Synthetic\r\n\r\nHello`).toString('base64url');
    const { requireApproval } = await prepare(box, value);
    assert.ok(requireApproval.description.includes('To:-'));
    assert.ok(requireApproval.description.includes(`${field}:"recipient@example.test"`));
    requireApproval.onResolution('allow-once');
    await box.gate.execute('call-1', value, config);
    assert.deepEqual(sends(box)[0].stdin, Buffer.from(box.state.raw, 'base64url'));
  }
});

test('the advertised five-minute approval window starts after preparation', async () => {
  const box = mailbox({ preparationMs: 60000 }), { requireApproval } = await prepare(box);
  assert.equal(requireApproval.timeoutMs, 300000);
  box.advance(250000);
  requireApproval.onResolution('allow-once');
  await box.gate.execute('call-1', params, config);
  assert.equal(sends(box).length, 1);
});

test('new, reply, reply-all, forward and draft use Gmail composition before the immutable send', async () => {
  for (const [action, verb] of [['new', 'create'], ['reply', 'reply'], ['reply_all', 'reply-all'], ['forward', 'forward'], ['draft', null]]) {
    const box = mailbox(), value = { ...params, action, id: 'draft-1' };
    const { requireApproval } = await prepare(box, value);
    if (verb) {
      assert.ok(box.calls[0].args.includes(`--enable-commands-exact=gmail.drafts.${verb}`));
      assert.deepEqual(box.calls[0].args.slice(box.calls[0].args.indexOf('gmail'), box.calls[0].args.indexOf('gmail') + 3), ['gmail', 'drafts', verb]);
    } else assert.equal(box.calls.length, 1);
    if (action === 'forward') assert.ok(box.calls[0].args.includes('--note-file=-'));
    assert.ok(requireApproval.description.includes('hidden@example.test'));
    requireApproval.onResolution('allow-once');
    await box.gate.execute('call-1', value, config);
    assert.equal(sends(box).length, 1);
  }
});

test('denial, timeout, cancellation, persistent approval and ignored callbacks cannot send', async () => {
  for (const decision of [undefined, 'deny', 'timeout', 'cancelled', 'allow-always']) {
    const box = mailbox(), { requireApproval } = await prepare(box);
    if (decision) requireApproval.onResolution(decision);
    await assert.rejects(box.gate.execute('call-1', params, config), /one-time approval/);
    requireApproval.onResolution('allow-once');
    await assert.rejects(box.gate.execute('call-1', params, config), /one-time approval/);
    assert.equal(sends(box).length, 0);
  }
});

test('late decisions and expired grants refuse; a call cannot borrow another call approval', async () => {
  for (const phase of ['decision', 'execution']) {
    const box = mailbox(), { requireApproval } = await prepare(box);
    if (phase === 'decision') box.advance(300001);
    requireApproval.onResolution('allow-once');
    if (phase === 'execution') box.advance(30001);
    await assert.rejects(box.gate.execute('call-1', params, config), /one-time approval/);
    assert.equal(sends(box).length, 0);
  }
  const box = mailbox(), { requireApproval } = await prepare(box);
  requireApproval.onResolution('allow-once');
  await assert.rejects(box.gate.execute('different-call', params, config), /one-time approval/);
  await assert.rejects(box.gate.before({ params }, config, 'owner_turn', buildSendCommand), /native tool call id/);
});

test('changed arguments or draft recipients, body, attachments and threading invalidate approval', async () => {
  for (const change of ['arguments', 'bcc', 'body', 'attachment', 'thread']) {
    const box = mailbox(), { requireApproval } = await prepare(box);
    requireApproval.onResolution('allow-once');
    if (change === 'bcc') box.state.raw = mime({ bcc: 'other@example.test' });
    if (change === 'body') box.state.raw = mime({ body: 'Different' });
    if (change === 'attachment') box.state.raw = mime({ attachment: 'Y2hhbmdlZA==' });
    if (change === 'thread') box.state.threadId = 'other-thread';
    await assert.rejects(box.gate.execute('call-1', change === 'arguments' ? { ...params, bcc: ['other@example.test'] } : params, config), /approval|draft changed/);
    assert.equal(sends(box).length, 0);
  }
});

test('a post-check draft mutation cannot change the RFC822 bytes sent', async () => {
  const box = mailbox({ mutateBeforeSend: true }), original = box.state.raw;
  const { requireApproval } = await prepare(box);
  requireApproval.onResolution('allow-once');
  // The captured source is the only send input; no mutable draft ID reaches send.
  await box.gate.execute('call-1', params, config);
  assert.notEqual(box.state.raw, original);
  assert.deepEqual(sends(box)[0].stdin, Buffer.from(original, 'base64url'));
  assert.equal(sends(box)[0].args.includes('draft-1'), false);
});

test('oversized recipient lists refuse instead of hiding Bcc; a long body is an explicit preview', async () => {
  const box = mailbox();
  box.state.raw = mime({ cc: Array.from({ length: 30 }, (_, i) => `recipient${i}@example.test`).join(',') });
  await assert.rejects(prepare(box), /exceed.*approval display/);
  await assert.rejects(box.gate.execute('call-1', params, config), /one-time approval/);
  assert.equal(sends(box).length, 0);
  const info = await inspectSnapshot(mime({ body: 'x'.repeat(10000) }));
  const description = sendDescription({ info, draftId: 'draft-1' }, 'owner_turn');
  assert.ok(description.includes('Body preview (10000 chars)'));
  assert.ok(description.includes('Bcc:"hidden@example.test"'));
  assert.ok(description.length <= 512);
});

test('ambiguous MIME, resent routing, missing raw and preparation failures refuse without a grant', async () => {
  for (const headers of ['To: a@example.test\r\nTo: b@example.test', 'To: a@example.test\r\nResent-Bcc: b@example.test', 'To: broken <']) {
    const raw = Buffer.from(`From: owner@example.test\r\n${headers}\r\nSubject: Synthetic\r\n\r\nHello`).toString('base64url');
    await assert.rejects(inspectSnapshot(raw), /inspect/);
  }
  for (const run of [async () => ({}), async () => { throw new Error('synthetic failure'); }]) {
    const gate = sendGate({ run });
    await assert.rejects(gate.before(event({ action: 'draft', id: 'draft-1' }), config, 'owner_turn', buildSendCommand, owner));
    await assert.rejects(gate.execute('call-1', { action: 'draft', id: 'draft-1' }, config, owner), /one-time approval/);
  }
});

test('MIME inspection counts attached messages once and reads HTML alternatives without losing Bcc', async () => {
  const raw = Buffer.from([
    'From: owner@example.test', 'To: to@example.test', 'Bcc: hidden@example.test',
    'Content-Type: multipart/mixed; boundary="outer"', '', '--outer',
    'Content-Type: text/html; charset=utf-8', '', '<p>Hello</p>', '--outer',
    'Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="original.eml"', '',
    'From: other@example.test', 'To: nested@example.test', 'Subject: Attached mail', '', 'Nested body',
    '--outer--', '',
  ].join('\r\n')).toString('base64url');
  const info = await inspectSnapshot(raw);
  assert.equal(info.attachments, 1);
  assert.deepEqual(info.attachmentDetails, [{ name: 'original.eml', bytes: null }]);
  assert.deepEqual(info.bcc, ['hidden@example.test']);
  assert.equal(info.bodyPreview, '<p>Hello</p>');
  assert.equal(info.bodyPreview.includes('Nested'), false);
});

test('attachment identities are mandatory approval details and are never silently abbreviated', async () => {
  const box = mailbox();
  box.state.raw = Buffer.from(Buffer.from(mime(), 'base64url').toString().replace('synthetic.pdf', `${'long-file-name-'.repeat(30)}.pdf`)).toString('base64url');
  await assert.rejects(prepare(box), /exceed.*approval display/);
  await assert.rejects(box.gate.execute('call-1', params, config), /one-time approval/);
  assert.equal(sends(box).length, 0);
});

test('registered send tool refuses when a runtime ignores the hook or its resolution callback', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentx-send-gate-'));
  t.after(() => rm(root, { recursive: true }));
  const box = mailbox(), hooks = new Map(), tools = new Map();
  createPlugin(x => x, { sendApproval: box.gate }).register({ config: {}, pluginConfig: { auditLog: path.join(root, 'audit.jsonl') },
    registerTool: (tool, options) => tools.set(tool.name || options.name, typeof tool === 'function' ? tool(owner) : tool), on: (name, fn) => hooks.set(name, fn) });
  const send = tools.get('gmail_secretary_send');
  await assert.rejects(send.execute('call-1', params), /one-time approval/);
  const approval = await hooks.get('before_tool_call')({ toolName: send.name, ...event() }, owner);
  await assert.rejects(send.execute('call-1', params), /one-time approval/);
  approval.requireApproval.onResolution('allow-once');
  await assert.rejects(send.execute('call-1', params), /one-time approval/);
  const next = await hooks.get('before_tool_call')({ toolName: send.name, ...event(params, 'call-2') }, owner);
  next.requireApproval.onResolution('allow-once');
  const result = await send.execute('call-2', params);
  assert.equal(result.content[0].text.includes('sent-1'), true);
  assert.equal(sends(box).length, 1);
});

test('the same call ID and arguments in a different native session cannot borrow approval', async () => {
  const box = mailbox(), { requireApproval } = await prepare(box);
  requireApproval.onResolution('allow-once');
  await assert.rejects(box.gate.execute('call-1', params, config,
    { ...owner, sessionKey: 'agent:mail:direct:other' }), /one-time approval/);
  await assert.rejects(box.gate.execute('call-1', params, config,
    { ...owner, agentId: 'other' }), /one-time approval/);
  assert.equal(sends(box).length, 0);
  await box.gate.execute('call-1', params, config);
  assert.equal(sends(box).length, 1);
});
