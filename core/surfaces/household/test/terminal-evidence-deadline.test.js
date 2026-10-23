'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentClient } = require('../conversation-agent');

const env = { OPENCLAW_GATEWAY_URL: 'http://gateway.example.test', OPENCLAW_GATEWAY_TOKEN: 'synthetic-token' };
const session = { sessionId: '11111111-1111-4111-8111-111111111111', packId: 'personal_operator', scopeId: 'personal', agentId: 'main' };
const runId = 'resp_22222222-2222-4222-8222-222222222222';
const row = value => Buffer.from('data: ' + JSON.stringify(value) + '\n\n');
const created = row({ type: 'response.created', response: { id: runId } });
const completed = row({ type: 'response.completed', response: { id: runId } });

test('zero settlement skips retries without cutting off the first asynchronous evidence read', async () => {
  let reads = 0;
  const client = createAgentClient({ env, settleMs: 0, evidenceReadMs: 500, progressMs: 1000,
    continuity: async () => {
      reads++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { run: { runId, model: 'synthetic-native' },
        answer: { status: 'ready', runId, text: 'Réponse vérifiée.' } };
    }, fetchImpl: async () => ({ ok: true, body: [created, completed] }) });
  const result = await client({ session, text: 'Bonjour.' });
  assert.equal(result.text, 'Réponse vérifiée.');
  assert.equal(result.tools.status, 'observed');
  assert.equal(result.metadata.model, 'synthetic-native');
  assert.equal(reads, 1);
});

for (const held of [false, true]) {
  test(`confirmed native completion bounds stalled evidence reads (${held ? 'open HTTP' : 'closed HTTP'})`, async () => {
    let requests = 0, settled = 0, release;
    const reads = [], deltas = [];
    const client = createAgentClient({ env, settleMs: 20, evidenceReadMs: 800,
      progressMs: 1000, streamGraceMs: 5, streamDrainMs: 50,
      // Simulate a continuity transport that ignores cancellation. The client
      // must bound the read itself, without waiting for this promise to settle.
      continuity: (_request, signal) => { reads.push(signal); return new Promise(() => {}); },
      fetchImpl: async (_url, options) => {
        requests++;
        options.signal.addEventListener('abort', () => release?.(), { once: true });
        return { ok: true, body: (async function* () {
          yield created;
          yield completed;
          if (held) await new Promise(resolve => { release = resolve; });
        })() };
      } });
    const started = Date.now();
    try {
      await assert.rejects(client({ session, text: 'Mes tâches ?',
        onDelta: text => deltas.push(text), onSettled: () => { settled++; } }), /Nestor did not give a final answer/);
      assert.ok(Date.now() - started < 350, 'evidence reads must honor the terminal settlement budget');
      assert.equal(requests, 1, 'a failed observation never repeats native work');
      assert.equal(settled, 1, 'the matching completion, not the elapsed budget, proves native termination');
      assert.deepEqual(deltas, [], 'unavailable evidence cannot become a fabricated answer');
      assert.equal(reads.length, 2, 'final answer and existing accepted-image recovery each get a bounded read');
      assert.ok(reads.every(signal => signal.aborted), 'timed-out observation transports are cancelled');
    } finally { release?.(); }
  });
}
