'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nativeWorkRuntime } = require('../native-work-runtime');
const { createAgentClient } = require('../conversation-agent');
const { hash } = require('../../../src/services/conversationWorks/contract');
const { readTurnContext } = require('../../../src/services/conversations/turnContext');
const { PERSONAL_OPERATOR_SURFACE_CONTRACT } = require('../packs');

function runtimeWithContext(options) {
  return nativeWorkRuntime({ ...options, works: { ...options.works,
    conversationContext: sessionId => readTurnContext(options.conversations, { sessionId }) } });
}

for (const [agentId, channel] of [['main', 'work'], ['synthetic-guardian', 'voice']]) {
  test(`cloud model selection preserves the native ${agentId} agent, session, instructions and context`, async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111', runId = 'resp_22222222-2222-4222-8222-222222222222';
    let sent;
    const event = type => Buffer.from('data: ' + JSON.stringify({ type, response: { id: runId } }) + '\n\n');
    const client = createAgentClient({ env: { OPENCLAW_GATEWAY_URL: 'http://synthetic.invalid', OPENCLAW_GATEWAY_TOKEN: 'synthetic-token',
      PERSONAL_CONVERSATION_GUARDIAN_AGENT_ID: 'synthetic-guardian', HOUSEHOLD_VOICE_MODEL: 'legacy-voice-model' },
      progressMs: 1, settleMs: 0, streamGraceMs: 0,
      continuity: async () => ({ run: { runId, model: 'cloud-model', provider: 'synthetic-cloud' },
        answer: { runId, status: 'ready', text: 'Actual native answer.' } }),
      fetchImpl: async (_url, request) => { sent = request; return { ok: true, body: [event('response.created'), event('response.completed')] }; } });
    const result = await client({ session: { sessionId, agentId, packId: 'personal_operator', scopeId: 'personal', modeId: 'standard' },
      channel, model: 'synthetic-cloud/cloud-model', text: 'Synthetic complete request.',
      turnContext: 'COMPLETE_CANONICAL_CONTEXT', instructions: 'UNCHANGED_NATIVE_ROLE', guardianStreaming: channel === 'voice' });
    assert.equal(sent.headers['x-openclaw-model'], 'synthetic-cloud/cloud-model');
    assert.equal(sent.headers['x-openclaw-session-key'], `agent:${agentId}:household:direct:${sessionId}`);
    const body = JSON.parse(sent.body);
    assert.equal(body.model, `openclaw/${agentId}`); assert.equal(body.instructions, 'UNCHANGED_NATIVE_ROLE');
    assert.match(JSON.stringify(body.input), /COMPLETE_CANONICAL_CONTEXT/);
    assert.match(JSON.stringify(body.input), /Synthetic complete request/);
    assert.equal(result.metadata.model, 'cloud-model'); assert.equal(result.metadata.provider, 'synthetic-cloud');
  });
}

test('background native Main preserves the complete request, references prior turns and retains its native model in a distinct session', async () => {
  const originalId = '11111111-1111-4111-8111-111111111111', workSessionId = '33333333-3333-4333-8333-333333333333';
  const text = 'Résume mes courriels récents.';
  const row = { sessionId: originalId, turnId: 'canonical-turn', requestSha256: hash(text), attempt: { sessionId: workSessionId, agentId: 'main' } };
  const session = { sessionId: originalId, packId: 'personal_operator', scopeId: 'personal', modeId: 'personal',
    agentSessionKey: `agent:main:household:direct:${originalId}`, persona: { identity: 'Synthetic Nestor identity.' } };
  const runtime = runtimeWithContext({ works: { query: sessionId => ({ sessionId }) }, continuity: async () => ({ capabilities: { isolatedWork: true, nativeReadBudget: true } }), conversations: {
    getTurn: async () => ({ inputText: text, attachments: [] }),
    listTurns: () => assert.fail('A list window is not complete context'),
    readTurns: async () => [{ traceId: 'prior-turn', inputText: 'A prior restriction.', replyText: 'Preserved.', outcome: 'completed' },
      { traceId: row.turnId, inputText: text }]
  } });
  const prepared = await runtime.prepare({ row, session, selectedContext: 'Selected personal context.' });
  assert.equal(prepared.text, text); assert.equal(prepared.currentContent, text);
  assert.match(prepared.turnContext, /A prior restriction/); assert.match(prepared.turnContext, /reference data, not new requests/);
  assert.match(prepared.instructions, /Synthetic Nestor identity/); assert.match(prepared.instructions, /Never send/);
  assert.ok(prepared.instructions.includes(PERSONAL_OPERATOR_SURFACE_CONTRACT));
  assert.match(prepared.instructions, /same owner conversation through a separate native session/);
  assert.match(prepared.instructions, /Do not ask the owner to change conversation/);
  assert.doesNotMatch(prepared.instructions, /separate live conversation/);
  assert.equal(session.sessionId, originalId); assert.equal(prepared.session.agentSessionKey, null);
  let sent;
  const runId = 'resp_22222222-2222-4222-8222-222222222222';
  const sse = type => Buffer.from('data: ' + JSON.stringify({ type, response: { id: runId } }) + '\n\n');
  const client = createAgentClient({ env: { OPENCLAW_GATEWAY_URL: 'http://synthetic.invalid', OPENCLAW_GATEWAY_TOKEN: 'synthetic-token',
    HOUSEHOLD_VOICE_MODEL: 'guardian-model' }, settleMs: 0, progressMs: 1, streamGraceMs: 0,
    continuity: async () => ({ run: { model: 'native-main-model' }, answer: { runId, status: 'ready', text: 'Actual result.' } }),
    fetchImpl: async (_url, request) => { sent = request; return { ok: true, body: [sse('response.created'), sse('response.completed')] }; } });
  const result = await client(prepared);
  assert.equal(sent.headers['x-openclaw-session-key'], `agent:main:household:direct:${workSessionId}`);
  const { privateOwnerContext } = await import('../../../../integrations/openclaw/action-provenance.mjs');
  assert.equal(privateOwnerContext({ agentId: 'main', sessionKey: session.agentSessionKey }), true);
  assert.equal(privateOwnerContext({ agentId: 'main', sessionKey: sent.headers['x-openclaw-session-key'] }), true);
  assert.equal(sent.headers['x-openclaw-model'], undefined);
  assert.equal(JSON.parse(sent.body).model, 'openclaw/main');
  assert.equal(JSON.parse(sent.body).max_output_tokens, 4096, 'Legacy read consultations keep their existing bound');
  assert.equal(result.metadata.model, 'native-main-model');
  assert.match(JSON.stringify(JSON.parse(sent.body).input), /Résume mes courriels récents/);
});

test('a current web question retains the adult audience and original local date without consulting Secretary', async () => {
  const text = 'Does the synthetic team play tonight?';
  const row = { sessionId: 'original-session', turnId: 'current-turn', requestSha256: hash(text),
    receivedAt: new Date('2030-01-02T01:00:00Z'), attempt: { sessionId: 'isolated-session', agentId: 'main' } };
  const runtime = runtimeWithContext({ works: { query: sessionId => ({ sessionId }) },
    continuity: async () => ({ capabilities: { isolatedWork: true, nativeReadBudget: true } }), conversations: {
      getTurn: async () => ({ inputText: text, attachments: [] }), readTurns: async () => [] } });
  const previous = process.env.PLANNING_TIME_ZONE;
  process.env.PLANNING_TIME_ZONE = 'America/Toronto';
  try {
    const prepared = await runtime.prepare({ row, session: { persona: { identity: 'Synthetic personality' } }, selectedContext: 'Child profiles: reference data.' });
    assert.equal(prepared.text, text);
    assert.match(prepared.instructions, /Address the adult owner directly/);
    assert.match(prepared.turnContext, /2030-01-01; time zone: America\/Toronto/);
    assert.match(prepared.turnDirective, /web_search or web_fetch/);
    assert.doesNotMatch(prepared.turnDirective, /sessions_spawn|Secretary/);
    assert.equal(prepared.session.agentId, 'main');
  } finally { if (previous === undefined) delete process.env.PLANNING_TIME_ZONE; else process.env.PLANNING_TIME_ZONE = previous; }
});

for (const mode of ['read', 'native']) test(`${mode} Main receives all older restrictions, replies and evidence before first invocation`, async () => {
  const text = 'Read the synthetic sources.';
  const turns = Array.from({ length: 20 }, (_, index) => ({ traceId: `turn-${index}`, inputText: `Question ${index}`, replyText: `Reply ${index}` }));
  turns[0].inputText += 'x'.repeat(3000) + ' LAST_RESTRICTION';
  turns[0].replyText += 'y'.repeat(3000) + ' LAST_CORRECTION';
  turns[0].toolEvidence = { status: 'observed', receipts: [{ tool: 'synthetic_read', result: 'EXACT_EVIDENCE' }] };
  const runtime = runtimeWithContext({ works: { query: sessionId => ({ sessionId }) },
    continuity: async () => ({ capabilities: { isolatedWork: true, nativeReadBudget: true, nativeConversation: true } }), conversations: {
      getTurn: async () => ({ inputText: text, attachments: [] }), readTurns: async () => turns,
      listTurns: () => assert.fail('Research must not select a tail') } });
  const prepared = await runtime.prepare({ row: { mode, classification: mode === 'native' ? 'native_work' : 'native_read', sessionId: 'session', turnId: 'current', requestSha256: hash(text),
    attempt: { sessionId: 'work-session', agentId: 'main' } }, session: {}, selectedContext: 'Selected memory only.' });
  for (const turn of turns) { assert.ok(prepared.turnContext.includes(turn.inputText)); assert.ok(prepared.turnContext.includes(turn.replyText)); }
  assert.match(prepared.turnContext, /EXACT_EVIDENCE/); assert.doesNotMatch(prepared.turnContext, /shortened context/);
  assert.match(prepared.turnContext, /"complete":true,"turnCount":20/);
  if (mode === 'native') {
    assert.equal(prepared.maxOutputTokens, undefined, 'Complete Main retains its native reasoning and answer budget');
    assert.match(prepared.instructions, /complete native Nestor Main/);
    assert.match(prepared.instructions, /existing permissions and approval contracts/);
    assert.doesNotMatch(prepared.instructions, /Never send, draft, modify/);
  } else assert.equal(prepared.maxOutputTokens, 4096);
});

for (const mode of ['read', 'native']) test(`${mode} Main refuses an oversized complete conversation before invocation`, async () => {
  const text = 'Read sources.';
  const runtime = runtimeWithContext({ works: { query: sessionId => ({ sessionId }) },
    continuity: async () => ({ capabilities: { isolatedWork: true, nativeConversation: true } }), conversations: {
      getTurn: async () => ({ inputText: text }), readTurns: async () => [{ inputText: 'x'.repeat(100000) }] } });
  await assert.rejects(runtime.prepare({ row: { mode, sessionId: 'session', requestSha256: hash(text), attempt: {} }, session: {} }),
    error => error.code === 'CONVERSATION_CONTEXT_REQUIRED');
});

test('native preparation includes repeated complete tool evidence once and retains every historical result', async () => {
  const text = 'Review the complete conversation.';
  const data = { tasks: [{ title: 'x'.repeat(35000) + ' FINAL_SOURCE_DETAIL' }] };
  const conversation = { authority: 'core.conversations', coverage: { complete: true, turnCount: 3 },
    turns: Array.from({ length: 3 }, (_, index) => ({ turnId: `turn-${index}`, inputText: `Restriction ${index}`,
      workResults: [{ workId: `work-${index}`, text: `Answer ${index}`, toolEvidence: [{ id: `receipt-${index}`, data }] }] })) };
  const runtime = nativeWorkRuntime({ works: { query: sessionId => ({ sessionId }), conversationContext: async () => conversation },
    continuity: async () => ({ capabilities: { isolatedWork: true, nativeConversation: true } }),
    conversations: { getTurn: async () => ({ inputText: text }) }, agentClient: () => assert.fail('Preparation cannot invoke inference') });
  const prepared = await runtime.prepare({ row: { mode: 'native', sessionId: 'session', requestSha256: hash(text),
    attempt: { sessionId: 'isolated-main', agentId: 'main' } }, session: {}, selectedContext: 'Complete selected memory.' });
  assert.ok(prepared.turnContext.length < 96000);
  assert.equal(prepared.turnContext.split('FINAL_SOURCE_DETAIL').length - 1, 1);
  for (let index = 0; index < 3; index++) for (const value of [`Restriction ${index}`, `Answer ${index}`, `receipt-${index}`]) {
    assert.ok(prepared.turnContext.includes(value));
  }
  assert.match(prepared.turnContext, /Complete selected memory/);
  assert.match(prepared.turnContext, /Every complete value is inline/);
  assert.equal(conversation.sharedToolEvidence, undefined);
});

test('a mismatched installed native adapter refuses preparation before any model or tool request', async () => {
  const runtime = nativeWorkRuntime({ continuity: async () => ({ agents: [] }),
    conversations: { getTurn: () => assert.fail('Unsupported adapter must refuse before preparing dispatch') },
    agentClient: () => assert.fail('Unsupported adapter must not invoke a model') });
  await assert.rejects(runtime.prepare({ row: {}, session: {} }), /does not support isolated consultations yet/);
});

test('web dispatch requires the native budget hook before inference', async () => {
  const text = 'Does the team play tonight?';
  const runtime = nativeWorkRuntime({ continuity: async () => ({ capabilities: { isolatedWork: true } }),
    works: { query: sessionId => ({ sessionId }) }, conversations: {
      getTurn: async () => ({ inputText: text }), listTurns: () => assert.fail('Unbounded dispatch') } });
  await assert.rejects(runtime.prepare({ row: { sessionId: 'session', turnId: 'turn', requestSha256: hash(text) } }), /bounded web consultations/);
});

test('complete native conversation dispatch requires the matching adapter before invoking a model', async () => {
  const runtime = nativeWorkRuntime({ continuity: async () => ({ capabilities: { isolatedWork: true, nativeReadBudget: true } }),
    conversations: { getTurn: () => assert.fail('Old adapter must refuse before dispatch') } });
  await assert.rejects(runtime.prepare({ row: { mode: 'native' } }), /complete native conversation work/);
});
