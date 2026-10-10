'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { createConversationExecutor } = require('../conversation-executor');
const hash = text => createHash('sha256').update(text).digest('hex');

function request() {
  const sessionId = randomUUID(), turnId = randomUUID(), text = 'Résume mes courriels récents.';
  const acceptance = { authority: 'core.conversation-works', accepted: true, id: hash(sessionId + '\n' + turnId),
    sessionId, turnId, requestSha256: hash(text), state: 'queued', resultReady: false };
  return { backend: 'openclaw', session: { sessionId, packId: 'personal_operator', scopeId: 'personal', modeId: 'standard' },
    text, channel: 'voice', history: [], readAcceptedNativeWork: async () => acceptance, acceptance };
}

test('canonical acceptance replies without invoking either brain and preserves pending status', async () => {
  const input = request(), deltas = [];
  let settled = false;
  const execute = createConversationExecutor({ agentClient: () => assert.fail('No foreground native call'),
    inference: { execute: () => assert.fail('No foreground inference') } });
  const answer = await execute({ ...input, onDelta: text => deltas.push(text), onSettled: () => { settled = true; } });
  assert.match(answer.text, /Tu peux continuer à me parler/);
  assert.equal(answer.tools.acceptedWork.execution, 'pending');
  assert.equal(answer.metadata.model, ''); assert.equal(answer.sessionKey, undefined);
  assert.deepEqual(deltas, [answer.text]); assert.equal(settled, true);
});

test('foreign, changed, invented and erased acceptance cannot redispatch a consultation', async () => {
  for (const patch of [{ sessionId: randomUUID() }, { requestSha256: hash('other text') },
    { id: hash('invented') }, { authority: 'browser' }, { accepted: false }, null]) {
    const input = request(); let calls = 0;
    const execute = createConversationExecutor({ agentClient: async () => { calls++; return { text: 'Native reply' }; } });
    await assert.rejects(execute({ ...input, readAcceptedNativeWork: async () => patch === null ? null : ({ ...input.acceptance, ...patch }) }),
      { code: 'CONVERSATION_WORK_ACCEPTANCE_UNAVAILABLE' });
    assert.equal(calls, 0);
  }
});

test('an unavailable canonical acceptance refuses instead of dispatching duplicate work', async () => {
  const execute = createConversationExecutor({ agentClient: () => assert.fail('Unknown intake must not redispatch') });
  await assert.rejects(execute({ ...request(), readAcceptedNativeWork: async () => { throw new Error('Intake unavailable'); } }), /Intake unavailable/);
});

test('background acknowledgment does not replace explicit models, Open, text or specialists', async () => {
  for (const variant of ['text', 'open', 'model', 'specialist']) {
    const input = request(); let calls = 0;
    if (variant === 'text') input.channel = 'text';
    if (variant === 'open') input.session.modeId = 'open';
    if (variant === 'model') input.model = 'explicit-model';
    if (variant === 'specialist') input.session.agentId = 'secretary';
    const execute = createConversationExecutor({ agentClient: async () => { calls++; return { text: 'Native reply' }; } });
    assert.equal((await execute(input)).text, 'Native reply'); assert.equal(calls, 1);
  }
});
