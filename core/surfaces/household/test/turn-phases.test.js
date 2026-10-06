'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { serverTimingsOf, AGENT_PHASES } = require('../turn-phases');
const { createAgentClient } = require('../conversation-agent');
const { publicAudit } = require('../persona-records');

test('a turn keeps where its server time went as bounded whole milliseconds', () => {
  assert.deepEqual(serverTimingsOf({ prepared: 41.6, executed: 2210, agent: { accepted: 12, runCreated: 30.2, generating: 650, streamEnd: 1900, answer: 2204, note: 'free text' } }),
    { serverTimings: { prepared: 42, executed: 2210, agent: { accepted: 12, runCreated: 30, generating: 650, streamEnd: 1900, answer: 2204 } } });
  // The direct lane has no native run; a deterministic reply calls no model at all.
  assert.deepEqual(serverTimingsOf({ prepared: 40, executed: 900 }), { serverTimings: { prepared: 40, executed: 900 } });
  assert.deepEqual(serverTimingsOf({}), {});
  assert.deepEqual(serverTimingsOf(), {});
  // Anything that is not a plausible duration is dropped, never stored.
  assert.deepEqual(serverTimingsOf({ prepared: -1, executed: '900', agent: { accepted: NaN, answer: 16 * 60 * 1000, streamEnd: { $gt: 0 } } }), {});
  assert.deepEqual(AGENT_PHASES, ['accepted', 'runCreated', 'generating', 'streamEnd', 'answer']);
});

test('the native agent client reports the steps of its run in order', async () => {
  const runId = 'resp_22222222-2222-4222-8222-222222222222';
  const row = data => Buffer.from('event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n');
  const client = createAgentClient({ env: { OPENCLAW_GATEWAY_URL: 'ws://gateway:18789', OPENCLAW_GATEWAY_TOKEN: 'test-only' }, settleMs: 0,
    continuity: async () => ({ answer: { status: 'ready', runId, text: 'Bonjour.' }, run: { model: 'native' } }),
    fetchImpl: async () => ({ ok: true, body: [row({ type: 'response.created', response: { id: runId } }),
      row({ type: 'response.output_text.delta', delta: 'Bonjour.' }), row({ type: 'response.completed', response: { id: runId } })] }) });
  const result = await client({ session: { sessionId: '11111111-1111-4111-8111-111111111111' }, text: 'Bonjour' });
  const { phases } = result.metadata;
  assert.deepEqual(Object.keys(phases), ['accepted', 'runCreated', 'generating', 'streamEnd', 'answer']);
  const values = Object.values(phases);
  assert.ok(values.every(value => Number.isInteger(value) && value >= 0));
  assert.deepEqual(values, values.slice().sort((a, b) => a - b), 'each step comes after the one before');
});

test('the audit view shows server timings only for a turn that has them', () => {
  assert.equal('serverTimings' in publicAudit({ traceId: 't' }), false);
  assert.deepEqual(publicAudit({ traceId: 't', serverTimings: { prepared: 40, executed: 900 } }).serverTimings, { prepared: 40, executed: 900 });
});
