'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentClient, sessionKeyFor } = require('../conversation-agent');
const { createReplyChannels } = require('../reply-channels');
const { acceptedImageReply } = require('../accepted-images');

const session = { sessionId: '11111111-1111-4111-8111-111111111111', packId: 'personal_operator', scopeId: 'personal' };
const sessionKey = sessionKeyFor(session), runId = 'resp_22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333', key = 'a'.repeat(64);
const operation = { id, state: 'accepted', studioPath: `/images?operation=${id}`, runtimeRestored: false };
const receipt = { tool: 'local_image', observed: true, status: 'unknown', runId, sessionKey,
  provenance: { origin: 'owner_turn' }, imageOperation: { id, actionKey: key } };
const row = value => Buffer.from('data: ' + JSON.stringify(value) + '\n\n');
const created = row({ type: 'response.created', response: { id: runId } });
const env = { OPENCLAW_GATEWAY_URL: 'ws://gateway.test', OPENCLAW_GATEWAY_TOKEN: 'test-only' };

test('a stopped native tool loop preserves the already accepted Core image without another action', async () => {
  let calls = 0;
  const client = createAgentClient({ env, settleMs: 0,
    continuity: async () => ({ run: { status: 'completed' }, receipts: [receipt], toolChecks: { status: 'observed', runId,
      completedTools: ['agents_list'], loop: { tool: 'agents_list', repetitions: 4 } } }),
    readImageOperation: async () => operation,
    fetchImpl: async () => { calls++; return { ok: true, body: [created, row({ type: 'response.completed', response: { id: runId } })] }; } });
  const result = await client({ session, text: 'Une image synthétique.' });
  assert.equal(calls, 1);
  assert.match(result.text, /vérification n’a pas abouti/);
  assert.match(result.text, /demande image est acceptée/);
  assert.equal(result.tools.imageDelivery.operations[0].id, id);
  assert.deepEqual(result.tools.verification, { status: 'failed', reason: 'repeated_tool_call', tool: 'agents_list', repetitions: 4 });
});

for (const failure of [false, true]) test(`accepted Core image survives ${failure ? 'both conversation brains refusing' : 'a light fallback denying tools'} in the final streamed reply`, async () => {
  let calls = 0, reads = 0, settled = 0;
  const delivered = [], show = [], speech = [];
  const channels = createReplyChannels({ onSay: text => speech.push(text), onShow: block => show.push(block) });
  const evidence = { run: { status: failure ? 'failed' : 'completed', model: 'light-fallback', provider: 'ollama' },
    receipts: [receipt], answer: { status: failure ? 'unavailable' : 'ready', runId, text: 'Tools unavailable. The image was cancelled.' } };
  const client = createAgentClient({ env, settleMs: 0,
    continuity: async () => evidence,
    readImageOperation: async (operationId, actionKey) => { reads++; assert.equal(operationId, id); assert.equal(actionKey, key); return operation; },
    fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(JSON.parse(options.body).tools, undefined, 'Do not grant tools to another brain');
      return { ok: true, body: [created, row({ type: failure ? 'response.failed' : 'response.completed',
        response: { id: runId, ...(failure ? { error: { message: 'Both providers refused before dispatch' } } : {}) } })] };
    } });
  const result = await client({ session, text: 'Une image synthétique.', onSettled: async () => { settled++; },
    onDelta: text => { delivered.push(text); channels.push(text); } });
  channels.end();
  assert.equal(calls, 1, 'Do not repeat the native request or the image action');
  assert.equal(reads, 1);
  assert.equal(settled, 1);
  assert.deepEqual(delivered, [result.text]);
  assert.match(result.text, /demande image est acceptée/);
  assert.ok(!result.text.includes('cancelled'));
  assert.equal(result.tools.imageDelivery.operations[0].id, id);
  assert.equal(result.tools.run.model, 'light-fallback', 'Keep the actual failed/fallback attempt evidence');
  assert.equal(result.metadata.provider, 'agentx.core.images');
  assert.equal(show[0].kind, 'link');
  assert.equal(show[0].body, operation.studioPath);
  assert.ok(!speech.join('').includes(id), 'Do not speak the operation UUID or studio URL');
});

test('a later observation returns the same verified artifact and genuinely cancelled states remain distinct', async () => {
  const artifact = { sha256: 'b'.repeat(64), url: `/api/images/operations/${id}/image` };
  for (const state of ['completed', 'cancelled', 'unknown']) {
    const result = await acceptedImageReply({ session, evidence: { receipts: [receipt] }, sessionKey, runId,
      readOperation: async () => ({ ...operation, state, artifact, runtimeRestored: state === 'completed' }) });
    assert.equal(result.operations[0].artifact.sha256, artifact.sha256);
    assert.equal(result.operations[0].id, id);
    assert.match(result.text, state === 'completed' ? /image est prête/ : state === 'cancelled' ? /a été annulée/ : /doit être vérifié/);
  }
});

for (const source of ['watcher progress', 'watcher receipt', 'settlement progress']) {
  test(`a failed final observation preserves Core image recovery after ${source}`, async () => {
    let reads = 0, calls = 0, release;
    const fromWatcher = source.startsWith('watcher');
    const evidence = { answer: { status: 'ready', runId, text: 'The image was cancelled.' },
      ...(source.endsWith('receipt') ? { receipts: [receipt] } : { progress: [{ id: 'image-call', tool: 'local_image' }] }) };
    const client = createAgentClient({ env, settleMs: fromWatcher ? 0 : 400, progressMs: 3, streamGraceMs: 1, streamDrainMs: 20,
      continuity: async () => {
        if (++reads === 1) return evidence;
        if (reads === 2) throw new Error('Continuity unavailable');
        return { run: { model: 'native' }, receipts: [receipt] };
      }, readImageOperation: async () => operation,
      fetchImpl: async (_url, options) => {
        calls++;
        return { ok: true, body: fromWatcher ? (async function* () {
          yield created;
          await new Promise(resolve => { release = resolve; options.signal.addEventListener('abort', resolve, { once: true }); });
        })() : [created, row({ type: 'response.completed', response: { id: runId } })] };
      } });
    try {
      const result = await client({ session, text: 'Une image synthétique.' });
      assert.match(result.text, /demande image est acceptée/);
      assert.ok(!result.text.includes('cancelled'));
      assert.equal(result.tools.imageDelivery.operations[0].id, id);
      assert.equal(result.metadata.provider, 'agentx.core.images');
      assert.equal(calls, 1);
      assert.equal(reads, 3);
    } finally { release?.(); }
  });
}

test('the receipt keeps the request language and does not replace a caller interruption with successful delivery', async () => {
  const english = await acceptedImageReply({ session, evidence: { receipts: [receipt] }, sessionKey, runId,
    language: 'en', readOperation: async () => operation });
  assert.match(english.text, /Your image request is accepted/);
  const controller = new AbortController();
  const deltas = [];
  const client = createAgentClient({ env, settleMs: 0, continuity: async () => ({ receipts: [receipt] }),
    readImageOperation: async () => { controller.abort(new Error('Caller stopped')); return operation; },
    fetchImpl: async () => ({ ok: true, body: [created, row({ type: 'response.failed', response: { id: runId } })] }) });
  await assert.rejects(client({ session, text: 'Synthetic request', signal: controller.signal, onDelta: text => deltas.push(text) }));
  assert.deepEqual(deltas, []);
});

test('foreign runs, sessions, owner scopes, failed creates and mismatched Core actions never become image receipts', async () => {
  const readOperation = async () => { throw new Error('Unqualified receipt must not read a Core operation'); };
  for (const changed of [ { runId: 'another-run' }, { sessionKey: 'another-session' },
    { provenance: { origin: 'ingested_content' } }, { observed: false }, { status: 'failed' }, { imageOperation: null } ]) {
    assert.equal(await acceptedImageReply({ session, evidence: { receipts: [{ ...receipt, ...changed }] },
      sessionKey, runId, readOperation }), null);
  }
  for (const changed of [{ scopeId: 'family' }, { packId: 'kidx_nestor' }, { agentId: 'another-agent' }, { llmx: {} }]) {
    assert.equal(await acceptedImageReply({ session: { ...session, ...changed }, evidence: { receipts: [receipt] },
      sessionKey, runId, readOperation }), null);
  }
  assert.equal(await acceptedImageReply({ session, evidence: { receipts: [receipt] }, sessionKey, runId,
    readOperation: async () => ({ ...operation, id: 'foreign-operation' }) }), null);
  assert.equal(await acceptedImageReply({ session, evidence: { receipts: [receipt] }, sessionKey, runId,
    readOperation: async () => { throw new Error('Core did not confirm this action'); } }), null);
});
