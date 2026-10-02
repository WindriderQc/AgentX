'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewer } = require('../src/reviewer');
const { createApp } = require('../src/app');
const { emptyState } = require('../../../src/domains/psyx/stateRepository');

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const REVIEW = JSON.stringify({
  digest: { summary: 'Short digest.' },
  proposals: [{ kind: 'openLoops', text: 'Return to the conflict', evidence: ['we stopped there'] }]
});

function fakes({ complete } = {}) {
  const calls = { complete: [], recorded: [] };
  const provider = {
    id: 'agentx',
    async complete(request) { calls.complete.push(request); return complete ? complete(request) : { content: REVIEW, model: 'deep:model' }; }
  };
  const stateRepository = {
    read: async () => emptyState(),
    async recordReview(userId, review) { calls.recorded.push({ userId, ...review }); return { added: review.proposals.length }; }
  };
  const conversationRepository = { context: async () => [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }] };
  return { calls, provider, stateRepository, conversationRepository };
}

test('turns completing during a review coalesce into one follow-up review', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { calls, provider, stateRepository, conversationRepository } = fakes({ complete: async () => { await gate; return { content: REVIEW }; } });
  const reviewer = createReviewer({ config: { review: { delayMs: 0 } }, provider, stateRepository, conversationRepository, logger: {} });

  assert.equal(reviewer.status('u', 'c').status, 'idle');
  assert.equal(reviewer.schedule('u', 'c'), true);
  assert.equal(reviewer.status('u', 'c').status, 'queued');
  await tick(5);
  assert.equal(reviewer.status('u', 'c').status, 'running');
  reviewer.schedule('u', 'c');
  reviewer.schedule('u', 'c');
  release();
  await tick(20);
  assert.equal(calls.complete.length, 2, 'one review, then a single follow-up for the turns that arrived meanwhile');
  const status = reviewer.status('u', 'c');
  assert.equal(status.status, 'done');
  assert.equal(status.lastAdded, 1);
  assert.equal(calls.recorded[0].conversationId, 'c');
  assert.equal(calls.complete[0].taskType, 'deep_reasoning');
  assert.equal(calls.complete[0].messages[0].role, 'system');
});

test('an unusable review fails visibly without writing memory', async () => {
  const { calls, provider, stateRepository, conversationRepository } = fakes({ complete: async () => ({ content: 'not json' }) });
  const reviewer = createReviewer({ config: { review: { delayMs: 0, taskType: 'frontier' } }, provider, stateRepository, conversationRepository, logger: { warn() {} } });
  reviewer.schedule('u', 'c');
  await tick(10);
  assert.deepEqual([reviewer.status('u', 'c').status, reviewer.status('u', 'c').error], ['failed', 'PSYX_REVIEW_UNUSABLE']);
  assert.equal(calls.recorded.length, 0);
  assert.equal(calls.complete[0].taskType, 'frontier');
});

test('the review is disabled by configuration or by a provider without background completion', () => {
  const { provider, stateRepository, conversationRepository } = fakes();
  const off = createReviewer({ config: { review: { enabled: false } }, provider, stateRepository, conversationRepository });
  assert.equal(off.schedule('u', 'c'), false);
  assert.equal(off.status('u', 'c').status, 'disabled');
  const streamOnly = createReviewer({ config: {}, provider: { id: 'x' }, stateRepository, conversationRepository });
  assert.equal(streamOnly.enabled, false);
});

test('a completed chat turn schedules the review and the browser can follow it and settle proposals', async () => {
  const scheduled = [];
  const reviewer = { enabled: true, schedule: (...args) => { scheduled.push(args); return true; }, status: () => ({ enabled: true, status: 'running' }) };
  const settled = [];
  const empty = emptyState();
  const database = {
    ping: async () => true,
    stateRepository: {
      read: async () => empty,
      acceptProposal: async (userId, id, edits) => { settled.push(['accept', id, edits.text]); return { state: empty }; },
      rejectProposal: async (userId, id) => { settled.push(['reject', id]); return { state: empty }; }
    },
    conversationRepository: { context: async () => [], saveCompletedTurn: async () => ({ id: '507f1f77bcf86cd799439011' }) }
  };
  const provider = { id: 'agentx', async stream(_request, sink) { sink.onToken('ok'); return { content: 'ok', routing: {} }; } };
  const config = { env: 'test', accessMode: 'token', accessToken: 'psyx-secret', sessionTtlMs: 3600000, loopbackBypass: false, maxBodyBytes: 262144, requestTimeoutMs: 1000, voice: { mode: 'disabled' } };
  const app = createApp({ config, database, provider, reviewer, logger: { error() {} } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer psyx-secret', 'Content-Type': 'application/json' };
  try {
    const chat = await (await fetch(`${base}/api/psyx/chat/stream`, { method: 'POST', headers, body: JSON.stringify({ message: 'hello' }) })).text();
    assert.match(chat, /"review":\{"scheduled":true\}/);
    assert.deepEqual(scheduled, [['default', '507f1f77bcf86cd799439011']]);

    const status = await (await fetch(`${base}/api/psyx/review/status?conversationId=507f1f77bcf86cd799439011`, { headers })).json();
    assert.equal(status.data.status, 'running');
    const bootstrap = await (await fetch(`${base}/api/psyx/status`, { headers })).json();
    assert.equal(bootstrap.data.review.automatic, true);
    assert.equal(bootstrap.data.conversationLifecycle.sessionDigest, true);

    await fetch(`${base}/api/psyx/state/proposals/p1/accept`, { method: 'POST', headers, body: JSON.stringify({ text: 'edited' }) });
    await fetch(`${base}/api/psyx/state/proposals/p2/reject`, { method: 'POST', headers, body: '{}' });
    assert.deepEqual(settled, [['accept', 'p1', 'edited'], ['reject', 'p2']]);
    assert.equal((await fetch(`${base}/api/psyx/review/status`)).status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
