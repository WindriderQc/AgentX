'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerWorkRuntime } = require('../conversation-work-runtime');
const { hash } = require('../../../src/services/conversationWorks/contract');
const { readTurnContext } = require('../../../src/services/conversations/turnContext');

function fixture(turns) {
  const text = 'Review this answer.', queries = [];
  const conversations = { getTurn: async () => ({ inputText: text, attachments: [] }),
    readTurns: async query => { queries.push(query); return turns; }, listTurns: () => assert.fail('A history window is incomplete') };
  const works = { conversationContext: sessionId => readTurnContext(conversations, { sessionId, packId: 'personal_operator', scopeId: 'personal' }) };
  let adapter;
  registerWorkRuntime({ env: {}, capability: { create: () => works, registerRoutes() {}, observe(value) { adapter = value; return {}; } },
    conversations });
  return { prepare: () => adapter.prepare({ row: { sessionId: 'owner-session', turnId: 'current', requestSha256: hash(text),
    attempt: { sessionId: 'worker-session', agentId: 'synthetic-worker' } }, session: { persona: { identity: 'Nestor' } },
    selectedContext: 'Selected personal memory.' }), queries };
}

test('the boss receives the complete owner conversation before its first native invocation', async () => {
  const turns = Array.from({ length: 20 }, (_, index) => ({ traceId: `turn-${index}`, inputText: `Question ${index}`, replyText: `Answer ${index}` }));
  turns[0].inputText += 'x'.repeat(3000) + ' ORIGINAL_RESTRICTION';
  turns[0].replyText += 'y'.repeat(3000) + ' LAST_CORRECTION';
  turns[0].display = [{ kind: 'text', body: 'Exact shown result.' }, { kind: 'secret', body: 'synthetic-hidden-value' }];
  turns[0].toolEvidence = { status: 'observed', receipts: [{ tool: 'synthetic_read', result: 'ACTUAL_SOURCE' }] };
  const f = fixture(turns), prepared = await f.prepare();
  assert.deepEqual(f.queries, [{ sessionId: 'owner-session', packId: 'personal_operator', scopeId: 'personal' }]);
  for (const turn of turns) { assert.ok(prepared.turnContext.includes(turn.inputText)); assert.ok(prepared.turnContext.includes(turn.replyText)); }
  assert.match(prepared.turnContext, /ACTUAL_SOURCE/); assert.match(prepared.turnContext, /Exact shown result/);
  assert.doesNotMatch(prepared.turnContext, /synthetic-hidden-value|shortened context/);
  assert.match(prepared.turnContext, /Selected personal memory/);
  assert.equal(prepared.session.sessionId, 'worker-session'); assert.equal(prepared.session.agentId, 'synthetic-worker');
  assert.match(prepared.instructions, /Review the guardian reply/);
});

test('worker preparation refuses an oversized complete conversation', async () => {
  await assert.rejects(fixture([{ inputText: 'x'.repeat(100000) }]).prepare(),
    error => error.code === 'CONVERSATION_CONTEXT_REQUIRED');
});
