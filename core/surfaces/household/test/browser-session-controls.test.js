'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserSessionControls } = require('../browser-session-controls');
const { createAgentClient } = require('../conversation-agent');

const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '33333333-3333-4333-8333-333333333333';
const runId = 'resp_22222222-2222-4222-8222-222222222222';
const env = { OPENCLAW_GATEWAY_URL: 'ws://gateway:18789', OPENCLAW_GATEWAY_TOKEN: 'test-only' };
const row = data => Buffer.from('data: ' + JSON.stringify(data) + '\n\n');

// The /interrupt route over a synthetic in-flight turn. The turn records its
// settlement as persona-turn does: onSettled marks the native run as ended,
// and a stop that was never confirmed leaves an error.
function controls(stream) {
  const routes = {}, audits = [];
  const router = { get() {}, post(path, handler) { routes[path] = handler; } };
  const activePersonaTurns = new Map();
  const register = createBrowserSessionControls({ personas: router, activePersonaTurns,
    conversations: { async updateTurn(filter) {
      return { _id: 'audit-1', sessionId, clientTurnId: filter.clientTurnId, interruptionState: audits.at(-1) };
    } },
    envelope: (res, data, status = 200) => res.reply(status, { ok: true, ...data }),
    fail: (res, status, message, code) => res.reply(status, { ok: false, message, code }),
    cleanText: value => String(value || ''), validClientTurnId: value => typeof value === 'string' && value.length > 8,
    nestorClient: async () => ({}) });
  register('/family', 'kidx_nestor', 'family');
  const abort = new AbortController();
  const entry = { abort, clientTurnId: turnId, snapshot: { sessionId, packId: 'kidx_nestor', modeId: 'family', scopeId: 'family' } };
  entry.finished = new Promise(resolve => { entry.finish = resolve; });
  activePersonaTurns.set(sessionId, entry);
  const client = createAgentClient({ env, settleMs: 300, continuity: async () => ({}),
    fetchImpl: async (_url, options) => ({ ok: true, body: (async function* () {
      yield* stream;
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      throw options.signal.reason;
    })() }) });
  client({ session: { sessionId, packId: 'kidx_nestor' }, text: 'Question', signal: abort.signal,
    onSettled: () => { entry.executionSettled = true; } })
    .catch(error => { entry.error = error; })
    .finally(() => { audits.push(entry.error && !entry.executionSettled ? 'failed' : 'confirmed'); activePersonaTurns.delete(sessionId); entry.finish(); });
  const interrupt = () => new Promise(resolve => routes['/family/sessions/:sessionId/interrupt'](
    { params: { sessionId }, body: { turnId } }, { reply: (status, body) => resolve({ status, body }) }));
  return { interrupt };
}

const created = row({ type: 'response.created', response: { id: runId } });
const scaffold = [row({ type: 'response.in_progress', response: { id: runId } }),
  row({ type: 'response.output_item.added', item: { type: 'message', role: 'assistant', content: [] } })];

test('interrupting a turn the gateway is still preparing settles, so the next turn is admitted', async () => {
  const { interrupt } = controls([created, ...scaffold]);
  await new Promise(resolve => setTimeout(resolve, 20));
  const started = Date.now();
  const result = await interrupt();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, interrupted: true, turnId });
  assert.ok(Date.now() - started < 5000);
});

test('an unconfirmed stop after generation started answers a plain French 503, never a silent one', async () => {
  const { interrupt } = controls([created, ...scaffold, row({ type: 'response.output_text.delta', delta: 'Bon' })]);
  await new Promise(resolve => setTimeout(resolve, 20));
  const result = await interrupt();
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'VOICE_INTERRUPTION_FAILED');
  assert.match(result.body.message, /L’arrêt de Nestor n’est pas encore confirmé/);
});
