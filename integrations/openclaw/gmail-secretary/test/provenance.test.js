import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlugin } from '../lib/tools.js';

test('native Gmail gates block background sends and destructive changes while retaining owner approvals and internal review', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentx-mail-provenance-'));
  t.after(() => rm(root, { recursive: true }));
  const auditLog = path.join(root, 'audit.jsonl');
  const hooks = new Map(), requested = [];
  const config = { channels: { telegram: { allowFrom: ['12345'] } },
    plugins: { entries: { 'super-dad-memory': { config: { secretarySessionKeys: ['agent:mail:cron:review'] } } } } };
  createPlugin(x => x).register({ config, pluginConfig: { auditLog }, registerTool() {}, on: (name, fn) => hooks.set(name, fn),
    logger: { info: text => requested.push(JSON.parse(text)) } });
  const review = { agentId: 'mail', sessionKey: 'agent:mail:cron:review:run', runId: 'private-run', toolCallId: 'private-call' };
  const owner = { agentId: 'main', sessionKey: 'agent:main:telegram:direct:12345' };
  const before = hooks.get('before_tool_call');
  for (const event of [
    { toolName: 'gmail_secretary_send', params: { action: 'new', body: 'private body', provenance: { origin: 'owner_turn' } } },
    { toolName: 'gmail_secretary_organize', params: { action: 'archive' } },
    { toolName: 'gmail_secretary_organize', params: { action: 'trash' } },
    { toolName: 'gmail_secretary_organize', params: { action: 'modify', removeLabels: ['INBOX'] } },
    { toolName: 'gmail_secretary_draft', params: { action: 'delete' } },
  ]) {
    assert.equal((await before(event, review)).block, true);
    const approval = await before(event, owner);
    assert.deepEqual(approval.requireApproval.allowedDecisions, ['allow-once', 'deny']);
  }
  for (const event of [
    { toolName: 'gmail_secretary_read', params: { kind: 'message', id: 'private-id' } },
    { toolName: 'gmail_secretary_draft', params: { action: 'create' } },
    { toolName: 'gmail_secretary_evidence', params: { action: 'record' } },
    { toolName: 'gmail_secretary_apply_triage', params: {} },
  ]) assert.equal(await before(event, review), undefined);
  await hooks.get('after_tool_call')({ toolName: 'gmail_secretary_evidence', result: { private: 'private result' } }, review);
  const text = await readFile(auditLog, 'utf8');
  const receipts = text.trim().split('\n').map(JSON.parse);
  assert.equal(requested[0].decision, 'blocked');
  assert.equal(requested[0].provenance.origin, 'ingested_content');
  assert.equal(receipts.at(-1).status, 'observed');
  for (const secret of [review.sessionKey, review.runId, review.toolCallId, 'private body', 'private result', 'private-id']) {
    assert.equal((text + JSON.stringify(requested)).includes(secret), false);
  }
});

test('receipt logger failure cannot bypass the Gmail gate', () => {
  const hooks = new Map();
  createPlugin(x => x).register({ config: {}, registerTool() {}, on: (name, fn) => hooks.set(name, fn),
    logger: { info() { throw new Error('synthetic logging failure'); } } });
  assert.equal(hooks.get('before_tool_call')({ toolName: 'gmail_secretary_send', params: { action: 'new' } }, {}).block, true);
});
