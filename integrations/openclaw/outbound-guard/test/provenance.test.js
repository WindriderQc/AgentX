import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nativeActionProvenance, toolActionReceipt } from '../../action-provenance.mjs';
import { outboundDecision } from '../policy.js';

const ownerTargets = ['telegram:12345'];
const config = {
  channels: { telegram: { allowFrom: ['12345'] } },
  plugins: { entries: { 'super-dad-memory': { config: {
    secretarySessionKeys: ['agent:mail-agent:cron:review'],
    briefingSessionKeys: ['agent:main:cron:brief'],
  } } } },
};
const owner = { agentId: 'main', sessionKey: 'agent:main:telegram:direct:12345', runId: 'owner-run', toolCallId: 'call-1' };
const review = { agentId: 'mail-agent', sessionKey: 'agent:mail-agent:cron:review:run:1', runId: 'review-run', toolCallId: 'call-2' };

test('origins come from host context and configured sessions, never model fields', () => {
  assert.equal(nativeActionProvenance(owner, config).origin, 'owner_turn');
  assert.equal(nativeActionProvenance(review, config).origin, 'ingested_content');
  assert.equal(nativeActionProvenance({ ...review, requester: { senderIsOwner: true } }, config).origin, 'ingested_content');
  assert.equal(nativeActionProvenance({ agentId: 'main', sessionKey: 'agent:main:cron:other' }, config).origin, 'scheduled');
  assert.equal(nativeActionProvenance({ agentId: 'main', sessionKey: 'agent:main:subagent:review' }, config).origin, 'delegated');
  for (const context of [{}, { ...owner, agentId: 'other' }, { ...owner, sandboxed: true },
    { agentId: 'main', sessionKey: 'agent:main:telegram:direct:999', provenance: { origin: 'owner_turn' } }]) {
    assert.notEqual(nativeActionProvenance(context, config).origin, 'owner_turn');
  }
  assert.equal(nativeActionProvenance({ agentId: 'operator', sessionKey: 'agent:operator:direct:test',
    requester: { senderIsOwner: true } }, config).origin, 'owner_turn');
});

test('background reports to configured owner destinations pass but external or destructive actions are blocked', () => {
  for (const provenance of [nativeActionProvenance(review, config), nativeActionProvenance({ agentId: 'main', sessionKey: 'agent:main:cron:brief' }, config)]) {
    const options = { ownerTargets, provenance };
    assert.equal(outboundDecision({ action: 'send', channel: 'telegram', target: '12345' }, options), null);
    assert.equal(outboundDecision({ action: 'send', target: 'telegram:12345' }, options), null);
    assert.equal(outboundDecision({ action: 'send', target: '12345' }, options).block, true, 'an unqualified id proves no channel');
    assert.equal(outboundDecision({ action: 'search', target: 'someone' }, options), null);
    for (const params of [{ action: 'send', target: 'someone', provenance: { origin: 'owner_turn' } },
      { action: 'send' }, { action: 'delete', channel: 'telegram', target: '12345' },
      { action: 'edit', channel: 'telegram', target: '12345' }]) {
      assert.equal(outboundDecision(params, options).block, true);
    }
  }
});

test('owner-turn provenance never bypasses approval for external recipients', () => {
  const provenance = nativeActionProvenance(owner, config);
  const decision = outboundDecision({ target: 'someone' }, { ownerTargets, provenance });
  assert.deepEqual(decision.requireApproval.allowedDecisions, ['allow-once', 'deny']);
  assert.match(decision.requireApproval.description, /owner_turn/);
  assert.equal(outboundDecision({ action: 'send' }, { ownerTargets, provenance }), null);
  assert.ok(outboundDecision({ action: 'send' }, { ownerTargets, provenance: nativeActionProvenance() }).requireApproval);
});

test('receipts contain references, never session identities, arguments or output content', () => {
  const provenance = nativeActionProvenance(review, config);
  const receipt = toolActionReceipt({ toolName: 'personal_memory', params: { text: 'private input' },
    result: { details: { text: 'private output' } } }, provenance, 'observed');
  assert.equal(receipt.status, 'observed');
  assert.equal(provenance.authority, 'none');
  assert.equal(provenance.scope, 'session');
  assert.match(provenance.sessionRef, /^[a-f0-9]{24}$/);
  for (const value of [review.sessionKey, review.runId, review.toolCallId, 'private input', 'private output']) {
    assert.equal(JSON.stringify(receipt).includes(value), false);
  }
  assert.equal(toolActionReceipt({ toolName: 'x', error: 'private error' }, provenance, 'observed').status, 'failed');
  assert.equal(toolActionReceipt({ toolName: 'x' }, provenance, 'observed').status, 'unknown');
});

test('the registered hooks enforce runtime provenance and audit every native tool', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const body = source.replace(/^import .*$/gm, '').replace('export default', 'return');
  const plugin = new Function('definePluginEntry', 'outboundDecision', 'nativeActionProvenance', 'toolActionReceipt', body)(
    x => x, outboundDecision, nativeActionProvenance, toolActionReceipt);
  const hooks = new Map(), records = [];
  plugin.register({ config, pluginConfig: { ownerTargets }, on: (name, handler) => hooks.set(name, handler),
    logger: { info: value => records.push(JSON.parse(value)) } });
  const event = { toolName: 'message', params: { target: 'someone', provenance: { origin: 'owner_turn' } } };
  assert.equal(hooks.get('before_tool_call')(event, review).block, true);
  assert.equal(records.at(-1).decision, 'blocked');
  assert.ok(hooks.get('before_tool_call')(event, owner).requireApproval);
  assert.equal(hooks.get('before_tool_call')({ toolName: 'personal_memory', params: { text: 'private' } }, owner), undefined);
  hooks.get('after_tool_call')({ toolName: 'personal_memory', result: { ok: true } }, owner);
  assert.equal(records.at(-1).phase, 'observed');
  assert.equal(records.at(-1).provenance.origin, 'owner_turn');
  plugin.register({ config, pluginConfig: { ownerTargets }, on: (name, handler) => hooks.set(name, handler),
    logger: { info() { throw new Error('synthetic logger failure'); } } });
  assert.equal(hooks.get('before_tool_call')(event, owner).block, true);
});
