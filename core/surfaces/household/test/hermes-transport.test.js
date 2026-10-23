'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHermesTransport } = require('../../../src/services/conversations/hermesTransport');
const { createConversationExecutor, conversationBackend } = require('../conversation-executor');

const env = { HOUSEHOLD_HERMES_URL: 'http://hermes.invalid', HOUSEHOLD_HERMES_TOKEN: 'synthetic-only' };
const reply = value => Response.json(value);
const stream = events => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
const completed = (extra = {}) => ({ run_id: 'run_synthetic', status: 'completed', completed: true, partial: false,
  output: 'Bonjour!', runtime: { provider: 'openai-codex', model: 'synthetic-cloud' }, ...extra });
function fixture(options = {}) {
  const calls = [], writes = [], deltas = [], activity = [];
  let saved, stop = false;
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, ...init, body: init.body && JSON.parse(init.body) });
    if (options.fetch) return options.fetch(path, init, calls);
    if (path === '/v1/runs') return reply({ run_id: 'run_synthetic' });
    if (path.endsWith('/events')) return stream([
      { event: 'reasoning.available', text: 'Never speak this internal text' },
      { event: 'tool.started', tool: 'synthetic_read', preview: 'Do not expose arguments' },
      { event: 'message.delta', delta: 'Bonjour!' },
      { event: 'tool.completed', tool: 'synthetic_read', error: false, preview: 'Do not expose raw results' },
      { event: 'run.completed' }
    ]);
    if (path.endsWith('/stop')) { stop = true; return reply({ status: 'stopping' }); }
    return reply(stop ? { status: 'cancelled' } : completed(options.terminal));
  };
  const request = { backend: 'hermes', turnId: 'synthetic-turn',
    session: { sessionId: 'synthetic-session', packId: 'personal_operator', scopeId: 'personal' },
    pack: { id: 'personal_operator' }, text: 'Salut', history: [], hermesInstructions: 'Synthetic persona contract',
    turnContext: 'Synthetic selected personal fact', signal: new AbortController().signal,
    onDelta: value => deltas.push(value), onActivity: value => activity.push(value) };
  const archived = [];
  const run = createHermesTransport({ env, fetchImpl, pollMs: 1, stopMs: 100, archive: async (_session, state) => archived.push(state),
    persist: async (_id, value) => { if (options.persistFailure) throw new Error('Synthetic write failure'); saved = value; writes.push(value); } });
  return { run, request, calls, writes, deltas, activity, archived, saved: () => saved };
}

test('Hermes streams public text only and uses the terminal served model and durable identity', async () => {
  const f = fixture();
  const result = await f.run(f.request);
  assert.deepEqual(f.deltas, ['Bonjour!']);
  assert.equal(result.text, 'Bonjour!');
  assert.equal(result.metadata.model, 'synthetic-cloud');
  assert.equal(f.saved().state, 'completed');
  assert.equal(f.saved().body, undefined);
  assert.deepEqual(f.activity, [{ kind: 'tool', agentId: 'hermes', tool: 'synthetic_read' }]);
  assert.equal(result.tools.receipts[0].status, 'completed');
  assert.ok(!JSON.stringify(result).includes('Do not expose'));
  const post = f.calls[0];
  assert.equal(post.headers['X-Hermes-Session-Key'], 'agentx:personal:synthetic-session');
  assert.ok(post.headers['Idempotency-Key']);
  assert.ok(!post.body.instructions.includes('Synthetic selected personal fact'));
  assert.ok(post.body.input.at(-1).content.includes('Synthetic selected personal fact'));
});

test('native local fallback remains the same run and is reported explicitly', async () => {
  const f = fixture({ terminal: { runtime: { provider: 'custom', model: 'synthetic-local' } } });
  const result = await f.run(f.request);
  assert.equal(result.metadata.model, 'synthetic-local');
  assert.equal(result.metadata.routing.degraded, true);
  assert.equal(f.calls.filter(call => call.path === '/v1/runs').length, 1);
});

test('no native launch occurs without a durable fence or outside personal scope', async () => {
  const failed = fixture({ persistFailure: true });
  await assert.rejects(failed.run(failed.request), /write failure/);
  assert.equal(failed.calls.length, 0);
  for (const session of [{ packId: 'kidx_nestor', scopeId: 'family' }, { llmx: {} }]) {
    const f = fixture(); Object.assign(f.request.session, session);
    await assert.rejects(f.run(f.request), { statusCode: 403 });
    assert.equal(f.calls.length, 0);
  }
});

test('an unresolved previous run blocks a replacement after process restart', async () => {
  const f = fixture({ fetch: async () => reply({ status: 'running' }) });
  f.request.session.hermesRuntime = { state: 'running', runId: 'run_previous' };
  await assert.rejects(f.run(f.request), /previous Hermes turn/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('lost admission is reconciled with the exact saved payload and key before stopping', async () => {
  let attempts = 0, stopped = false;
  const f = fixture({ fetch: async (path, init) => {
    if (path === '/v1/runs') { if (++attempts === 1) throw new Error('Synthetic lost acceptance'); return reply({ run_id: 'run_synthetic' }); }
    if (path.endsWith('/stop')) { stopped = true; return reply({ status: 'stopping' }); }
    return reply({ status: stopped ? 'cancelled' : 'running' });
  } });
  await assert.rejects(f.run(f.request), /lost acceptance/);
  const posts = f.calls.filter(call => call.path === '/v1/runs');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body, posts[1].body);
  assert.equal(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key']);
  assert.equal(f.saved().state, 'cancelled');
});

test('an interrupted stream waits for confirmed native termination', async () => {
  let stopped = false, polls = 0;
  const f = fixture({ fetch: async path => {
    if (path === '/v1/runs') return reply({ run_id: 'run_synthetic' });
    if (path.endsWith('/events')) throw new Error('Synthetic stream disconnected');
    if (path.endsWith('/stop')) { stopped = true; return reply({ status: 'stopping' }); }
    if (stopped && ++polls >= 2) return reply({ status: 'cancelled' });
    return reply({ status: stopped ? 'stopping' : 'running' });
  } });
  let settled = false; f.request.onSettled = () => { settled = true; };
  await assert.rejects(f.run(f.request), /stream disconnected/);
  assert.equal(settled, true);
  assert.equal(polls, 2);
  assert.equal(f.saved().state, 'cancelled');
});

test('unconfirmed stop preserves the running fence and refuses silent fallback', async () => {
  const f = fixture({ fetch: async path => {
    if (path === '/v1/runs') return reply({ run_id: 'run_synthetic' });
    if (path.endsWith('/events')) throw new Error('Synthetic stream disconnected');
    return reply({ status: 'running' });
  } });
  await assert.rejects(f.run(f.request), { code: 'HERMES_UNCONFIRMED' });
  assert.equal(f.saved().state, 'running');
});

test('executor selects Hermes and reuses native history after session mapping', async () => {
  assert.equal(conversationBackend('hermes', env), 'hermes');
  assert.throws(() => conversationBackend('hermes', {}), { statusCode: 503 });
  const received = [];
  const execute = createConversationExecutor({ env, hermesClient: async req => { received.push(req); return { text: 'Synthetic' }; },
    agentClient: () => assert.fail('OpenClaw must not run'), inference: { execute: () => assert.fail('Core inference must not run') } });
  const f = fixture(); f.request.history = [{ role: 'user', content: 'Synthetic earlier message' }];
  await execute(f.request);
  f.request.session.agentSessionKey = 'synthetic-native-session';
  await execute(f.request);
  assert.equal(received[0].history.length, 1);
  assert.equal(received[1].history.length, 0);
});

test('duplicate browser identity returns its receipt even if selected context changed', async () => {
  const f = fixture();
  await f.run(f.request);
  const count = f.calls.length;
  f.request.turnContext = 'Changed selected context';
  f.request.history = [{ role: 'assistant', content: 'Changed history' }];
  const result = await f.run(f.request);
  assert.equal(result.text, 'Bonjour!');
  assert.equal(f.calls.length, count);
  assert.equal(f.saved().state, 'completed');
});

test('lost completed event is recovered from the durable native receipt', async () => {
  const f = fixture({ fetch: async path => {
    if (path === '/v1/runs') return reply({ run_id: 'run_synthetic' });
    if (path.endsWith('/events')) return new Response('', { status: 404 });
    if (path.endsWith('/stop')) assert.fail('A completed run needs no stop');
    return reply(completed());
  } });
  const result = await f.run(f.request);
  assert.equal(result.text, 'Bonjour!');
  assert.equal(f.saved().receipt.output, 'Bonjour!');
  assert.deepEqual(f.deltas, ['Bonjour!']);
});

test('old lost acceptance cannot launch again after native idempotency retention', async () => {
  const f = fixture();
  f.request.session.hermesRuntime = { state: 'dispatching', key: 'synthetic-old-key',
    startedAt: new Date(Date.now() - 86400000).toISOString(), body: { input: 'Earlier request' } };
  await assert.rejects(f.run(f.request), /too old/);
  assert.equal(f.calls.length, 0);
});

test('a different turn archives the previous recovered answer before replacing its journal', async () => {
  const f = fixture();
  f.request.session.hermesRuntime = { state: 'running', runId: 'run_previous', key: 'earlier-turn', turnId: 'earlier-browser-turn' };
  await f.run(f.request);
  assert.equal(f.archived.length, 1);
  assert.equal(f.archived[0].runId, 'run_previous');
  assert.equal(f.archived[0].receipt.output, 'Bonjour!');
  assert.equal(f.saved().turnId, 'synthetic-turn');
});
