'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nativeWorkRuntime } = require('../native-work-runtime');
const { createAgentClient } = require('../conversation-agent');
const { hash } = require('../../../src/services/conversationWorks/contract');

test('background native Main preserves the complete request, references prior turns and retains its native model in a distinct session', async () => {
  const originalId = '11111111-1111-4111-8111-111111111111', workSessionId = '33333333-3333-4333-8333-333333333333';
  const text = 'Résume mes courriels récents.';
  const row = { sessionId: originalId, turnId: 'canonical-turn', requestSha256: hash(text), attempt: { sessionId: workSessionId, agentId: 'main' } };
  const session = { sessionId: originalId, packId: 'personal_operator', scopeId: 'personal', modeId: 'personal',
    agentSessionKey: `agent:main:household:direct:${originalId}`, persona: { identity: 'Synthetic Nestor identity.' } };
  const runtime = nativeWorkRuntime({ works: { query: sessionId => ({ sessionId }) }, conversations: {
    getTurn: async () => ({ inputText: text, attachments: [] }),
    listTurns: async () => [{ traceId: row.turnId, inputText: text },
      { traceId: 'prior-turn', inputText: 'A prior restriction.', replyText: 'Preserved.', outcome: 'completed' }]
  } });
  const prepared = await runtime.prepare({ row, session, selectedContext: 'Selected personal context.' });
  assert.equal(prepared.text, text); assert.equal(prepared.currentContent, text);
  assert.match(prepared.turnContext, /A prior restriction/); assert.match(prepared.turnContext, /reference data, not new requests/);
  assert.match(prepared.instructions, /Synthetic Nestor identity/); assert.match(prepared.instructions, /Never send/);
  assert.equal(session.sessionId, originalId); assert.equal(prepared.session.agentSessionKey, null);
  let sent;
  const runId = 'resp_22222222-2222-4222-8222-222222222222';
  const sse = type => Buffer.from('data: ' + JSON.stringify({ type, response: { id: runId } }) + '\n\n');
  const client = createAgentClient({ env: { OPENCLAW_GATEWAY_URL: 'http://synthetic.invalid', OPENCLAW_GATEWAY_TOKEN: 'synthetic-token',
    HOUSEHOLD_VOICE_MODEL: 'guardian-model' }, settleMs: 0, progressMs: 1, streamGraceMs: 0,
    continuity: async () => ({ run: { model: 'native-main-model' }, answer: { runId, status: 'ready', text: 'Actual result.' } }),
    fetchImpl: async (_url, request) => { sent = request; return { ok: true, body: [sse('response.created'), sse('response.completed')] }; } });
  const result = await client(prepared);
  assert.equal(sent.headers['x-openclaw-session-key'], `agent:main:household:work:${workSessionId}`);
  assert.equal(sent.headers['x-openclaw-model'], undefined);
  assert.equal(JSON.parse(sent.body).model, 'openclaw/main');
  assert.equal(result.metadata.model, 'native-main-model');
  assert.match(JSON.stringify(JSON.parse(sent.body).input), /Résume mes courriels récents/);
});
