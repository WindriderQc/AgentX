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

test('in auto mode the next turn follows the review recommendation and tells the browser', async () => {
  const { readReview } = require('../../../src/domains/psyx/review');
  const digest = readReview(JSON.stringify({
    // The shape the review prompt asks for: "next" beside "digest".
    digest: { summary: 'Hard week.', conversationId: 'model-invented' },
    next: { stance: 'challenge', depth: 'deep', reason: 'The story is too convenient.' }
  }), { conversationId: '507f1f77bcf86cd799439011' }).digest;
  assert.equal(digest.conversationId, '507f1f77bcf86cd799439011');
  assert.deepEqual(digest.next, { stance: 'challenge', depth: 'deep', reason: 'The story is too convenient.' });
  assert.equal(readReview(JSON.stringify({ digest: { summary: 'x', next: { stance: 'shout' } } }), { conversationId: 'c' }).digest.next, null);

  const requests = [];
  const database = {
    ping: async () => true,
    stateRepository: { read: async () => ({ ...emptyState(), sessionDigests: [digest] }) },
    conversationRepository: { context: async () => [{ role: 'user', content: 'before' }], saveCompletedTurn: async () => ({ id: '507f1f77bcf86cd799439011' }) }
  };
  const provider = { id: 'agentx', async stream(request, sink) { requests.push(request); sink.onToken('ok'); return { content: 'ok', routing: {} }; } };
  const reviewer = { enabled: false, schedule: () => false, status: () => ({ status: 'disabled' }) };
  const config = { env: 'test', accessMode: 'token', accessToken: 'psyx-secret', sessionTtlMs: 3600000, loopbackBypass: false, maxBodyBytes: 262144, requestTimeoutMs: 1000, voice: { mode: 'disabled' } };
  const server = createApp({ config, database, provider, reviewer, logger: { error() {} } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/psyx/chat/stream`, {
    method: 'POST', headers: { Authorization: 'Bearer psyx-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: '507f1f77bcf86cd799439011', message: 'hi', ...body })
  }).then(response => response.text());
  try {
    const auto = await post({ psyx: { mode: 'auto', depth: 'auto' } });
    const control = JSON.parse(auto.match(/event: control\ndata: ([^\n]+)/)[1]);
    assert.deepEqual(control, { mode: 'challenge', depth: 'deep', auto: { mode: true, depth: true },
      reason: 'The story is too convenient.', safety: false, location: 'local',
      contextCoverage: { availableMessages: 1, includedMessages: 1, omittedMessages: 0, complete: true } });
    assert.deepEqual([requests[0].taskType, requests[0].think, requests[0].options.temperature], ['deep_reasoning', true, 0.55]);
    assert.match(requests[0].system, /Chosen automatically after reviewing this conversation/);

    await post({ psyx: { mode: 'talk', depth: 'normal' } });
    assert.deepEqual([requests[1].taskType, requests[1].options.temperature], ['analysis', 0.7]);
    assert.doesNotMatch(requests[1].system, /Chosen automatically/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a crisis signal overrides the stance, adds the safety instruction and sends Québec resources', async () => {
  const requests = [];
  const next = { stance: 'challenge', depth: 'deep', reason: 'Push back.' };
  const database = {
    ping: async () => true,
    stateRepository: { read: async () => ({ ...emptyState(), sessionDigests: [{ conversationId: '507f1f77bcf86cd799439011', summary: 's', next }] }) },
    conversationRepository: { context: async () => [], saveCompletedTurn: async () => ({ id: '507f1f77bcf86cd799439011' }) }
  };
  const provider = { id: 'agentx', async stream(request, sink) { requests.push(request); sink.onToken('ok'); return { content: 'ok', routing: {} }; } };
  const reviewer = { enabled: false, schedule: () => false, status: () => ({ status: 'disabled' }) };
  const config = { env: 'test', accessMode: 'token', accessToken: 'psyx-secret', sessionTtlMs: 3600000, loopbackBypass: false, maxBodyBytes: 262144, requestTimeoutMs: 1000, voice: { mode: 'disabled' } };
  const server = createApp({ config, database, provider, reviewer, logger: { error() {} } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const post = message => fetch(`http://127.0.0.1:${server.address().port}/api/psyx/chat/stream`, {
    method: 'POST', headers: { Authorization: 'Bearer psyx-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: '507f1f77bcf86cd799439011', message, psyx: { mode: 'auto', depth: 'auto' } })
  }).then(response => response.text());
  try {
    const crisis = await post('Je n’ai plus envie de vivre.');
    const control = JSON.parse(crisis.match(/event: control\ndata: ([^\n]+)/)[1]);
    assert.deepEqual([control.mode, control.depth, control.safety, control.location], ['talk', 'normal', true, 'local']);
    assert.match(crisis, /event: safety\ndata: \{"kinds":\["suicide"\],"resources":\[\{"label":"Danger immédiat","contact":"911"\}/);
    assert.deepEqual([requests[0].taskType, requests[0].options.temperature], ['analysis', 0.4]);
    assert.match(requests[0].system, /SAFETY STANCE/);

    const ordinary = await post('Ça me tue de rire, cette histoire.');
    assert.doesNotMatch(ordinary, /event: safety/);
    assert.doesNotMatch(requests[1].system, /SAFETY STANCE/);
    assert.equal(requests[1].taskType, 'deep_reasoning');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a review waits while the user is being answered and drops results for a conversation deleted meanwhile', async () => {
  let busy = true;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let exists = true;
  const { calls, provider, stateRepository } = fakes({ complete: async () => { await gate; return { content: REVIEW }; } });
  const conversationRepository = { context: async () => exists ? [{ role: 'user', content: 'hello' }] : null };
  const reviewer = createReviewer({ config: { review: { delayMs: 5 } }, provider, stateRepository, conversationRepository, logger: {}, isBusy: () => busy });
  reviewer.schedule('u', 'c');
  await tick(30);
  assert.equal(calls.complete.length, 0, 'no review while a reply streams');
  busy = false;
  await tick(1100); // the busy retry waits at least a second
  assert.equal(calls.complete.length, 1);
  exists = false;
  release();
  await tick(20);
  assert.equal(calls.recorded.length, 0, 'nothing recorded for a conversation that disappeared');

  reviewer.schedule('u', 'd');
  reviewer.forget('u', 'd');
  await tick(30);
  assert.equal(reviewer.status('u', 'd').status, 'idle');
});

test('check-ins are recorded through the protected API only', async () => {
  const recorded = [];
  const database = {
    ping: async () => true,
    stateRepository: { read: async () => emptyState(), addCheckIn: async (userId, body) => { recorded.push([userId, body]); return { state: emptyState() }; } },
    conversationRepository: {}
  };
  const config = { env: 'test', accessMode: 'token', accessToken: 'psyx-secret', sessionTtlMs: 3600000, loopbackBypass: false, maxBodyBytes: 262144, requestTimeoutMs: 1000, voice: { mode: 'disabled' } };
  const reviewer = { enabled: false, schedule: () => false, status: () => ({ status: 'disabled' }) };
  const server = createApp({ config, database, provider: { id: 'x' }, reviewer, logger: { error() {} } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/psyx/state/check-ins`;
  try {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"score":3}' })).status, 401);
    const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer psyx-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ score: 6, phase: 'start', conversationId: 'c1', extra: 'ignored' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(recorded, [['default', { score: 6, phase: 'start' }]], 'no conversation id is kept with a rating');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('forgetting a busy deferred review clears its retry and never runs orphan work', async () => {
  const { calls, provider, stateRepository, conversationRepository } = fakes();
  const reviewer = createReviewer({ config: { review: { delayMs: 0 } }, provider, stateRepository, conversationRepository, isBusy: () => true });
  reviewer.schedule('u', 'c');
  await tick(10);
  reviewer.forget('u', 'c');
  await tick(1100);
  assert.equal(reviewer.status('u', 'c').status, 'idle');
  assert.equal(calls.complete.length, 0);
});
