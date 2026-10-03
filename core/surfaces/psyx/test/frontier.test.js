'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenClawAgentClient } = require('../../../src/services/frontier/openclawAgentClient');
const { createCoreProvider } = require('../src/provider');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { frontierLocation } = require('../../../src/domains/psyx/domain');
const { emptyState } = require('../../../src/domains/psyx/stateRepository');

const sse = (...events) => new Response(new ReadableStream({ start(controller) {
  for (const [event, data] of events) controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  controller.close();
} }));
const gatewayEnv = { OPENCLAW_GATEWAY_URL: 'http://gateway.test/', OPENCLAW_GATEWAY_TOKEN: 'token' };

test('the frontier client sends the whole turn to one agent under a fresh session and reads the stream', async () => {
  const requests = [];
  const client = createOpenClawAgentClient({ env: gatewayEnv, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return sse(['response.created', {}], ['response.output_text.delta', { delta: 'Je ' }], ['response.output_text.delta', { delta: 't’entends.' }],
      ['response.completed', { response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 3 } } }]);
  } });
  assert.equal(client.available('psyx'), true);
  assert.equal(client.available('Bad Agent'), false);
  const tokens = [];
  const result = await client.run({ agentId: 'psyx', instructions: 'SYSTEM', onToken: delta => tokens.push(delta),
    messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
  assert.deepEqual([result.content, result.streamed, result.usage.output_tokens, tokens.length], ['Je t’entends.', true, 3, 2]);
  const body = JSON.parse(requests[0].options.body);
  assert.equal(requests[0].url, 'http://gateway.test/v1/responses');
  assert.deepEqual([body.model, body.instructions, body.input.map(item => item.role)], ['openclaw/psyx', 'SYSTEM', ['user', 'assistant', 'user']]);
  assert.match(requests[0].options.headers['x-openclaw-session-key'], /^agent:psyx:turn-[0-9a-f-]{36}$/);
  await client.run({ agentId: 'psyx', instructions: '', messages: [] }).catch(() => {});
  assert.notEqual(requests[0].options.headers['x-openclaw-session-key'], requests[1].options.headers['x-openclaw-session-key']);
});

test('the frontier client fails clearly when unconfigured, refused or empty', async () => {
  await assert.rejects(createOpenClawAgentClient({ env: {} }).run({ agentId: 'psyx', messages: [] }), { code: 'FRONTIER_NOT_CONFIGURED' });
  const refused = createOpenClawAgentClient({ env: gatewayEnv, fetchImpl: async () => new Response('no', { status: 503 }) });
  await assert.rejects(refused.run({ agentId: 'psyx', messages: [] }), { code: 'FRONTIER_UNAVAILABLE' });
  const empty = createOpenClawAgentClient({ env: gatewayEnv, fetchImpl: async () => sse(['response.completed', { response: { status: 'completed', output: [] } }]) });
  await assert.rejects(empty.run({ agentId: 'psyx', messages: [] }), { code: 'FRONTIER_EMPTY' });
  const whole = createOpenClawAgentClient({ env: gatewayEnv, fetchImpl: async () => sse(['response.completed', { response: { status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Entier.' }] }] } }]) });
  assert.deepEqual(await whole.run({ agentId: 'psyx', messages: [] }).then(result => [result.content, result.streamed]), ['Entier.', false]);
});

function localRuntime(calls) {
  const { Readable } = require('node:stream');
  return {
    routing: { getEffectiveSnapshot: async () => ({ tasks: {} }) },
    inference: { execute: async (body) => {
      calls.push(body);
      if (!body.stream) return { ok: true, body: { message: { content: '{"digest":{"summary":"local"}}' }, model: 'local:model' } };
      return { ok: true, metadata: { model: 'local:model' }, stream: Readable.from([
        JSON.stringify({ message: { content: 'réponse locale' }, done: false }) + '\n', JSON.stringify({ model: 'local:model', done: true }) + '\n'
      ]), completion: Promise.resolve({ completed: true, terminalComplete: true }) };
    } }
  };
}
const sink = () => { const seen = { tokens: [], routes: [] };
  return { seen, onToken: delta => seen.tokens.push(delta), onThinking() {}, onRoute: route => seen.routes.push(route) }; };
const frontierConfig = { frontier: { agent: 'psyx', model: 'gpt-5.6-sol', defaultMode: 'all' } };

test('a frontier turn is answered by the agent, and by the local route with a visible reason when the agent fails', async () => {
  const calls = [];
  const ok = { available: () => true, run: async ({ onToken, instructions, messages }) => { onToken?.('Sol '); onToken?.('répond.'); return { content: 'Sol répond.', streamed: true, usage: {}, instructions, messages }; } };
  const provider = createCoreProvider(localRuntime(calls), { frontier: ok, config: frontierConfig });
  const first = sink();
  const answered = await provider.stream({ location: 'frontier', system: 'S', messages: [{ role: 'user', content: 'avant' }], message: 'maintenant', taskType: 'analysis' }, first);
  assert.deepEqual([answered.content, answered.model, answered.routing.location, answered.routing.routedHost], ['Sol répond.', 'gpt-5.6-sol', 'frontier', 'openclaw/psyx']);
  assert.equal(calls.length, 0, 'nothing ran locally');

  const down = { available: () => true, run: async () => { throw Object.assign(new Error('quota'), { code: 'FRONTIER_UNAVAILABLE' }); } };
  const second = sink();
  const fallback = await createCoreProvider(localRuntime(calls), { frontier: down, config: frontierConfig })
    .stream({ location: 'frontier', system: 'S', messages: [], message: 'm', taskType: 'analysis' }, second);
  assert.deepEqual([fallback.content, fallback.routing.location, fallback.routing.fallbackFrom, fallback.routing.fallbackReason], ['réponse locale', 'local', 'frontier', 'FRONTIER_UNAVAILABLE']);
  assert.equal(second.seen.routes.at(-1).fallbackFrom, 'frontier');

  // Text already shown cannot be replayed on another model.
  const broken = { available: () => true, run: async ({ onToken }) => { onToken('Début'); throw new Error('cut'); } };
  await assert.rejects(createCoreProvider(localRuntime(calls), { frontier: broken, config: frontierConfig })
    .stream({ location: 'frontier', system: 'S', messages: [], message: 'm', taskType: 'analysis' }, sink()), /cut/);

  const local = await provider.stream({ location: 'local', system: 'S', messages: [], message: 'm', taskType: 'analysis' }, sink());
  assert.equal(local.routing.location, 'local');
  const review = await provider.complete({ location: 'frontier', messages: [{ role: 'system', content: 'R' }, { role: 'user', content: 'c' }] });
  assert.deepEqual([review.content, review.location], ['Sol répond.', 'frontier']);
});

test('modes decide where a turn goes; configuration and the user setting are validated', () => {
  assert.deepEqual(['local', 'deep', 'all'].map(mode => [frontierLocation(mode, 'normal'), frontierLocation(mode, 'deep')]),
    [['local', 'local'], ['local', 'frontier'], ['frontier', 'frontier']]);
  assert.deepEqual(loadConfig({}).frontier, { agent: '', model: 'frontier', defaultMode: 'local' });
  assert.deepEqual(loadConfig({ PSYX_FRONTIER_AGENT: 'psyx', PSYX_FRONTIER_MODEL: 'gpt-5.6-sol', PSYX_FRONTIER_MODE: 'all' }).frontier,
    { agent: 'psyx', model: 'gpt-5.6-sol', defaultMode: 'all' });
  assert.throws(() => loadConfig({ PSYX_FRONTIER_MODE: 'cloud' }), /PSYX_FRONTIER_MODE/);
  assert.throws(() => loadConfig({ PSYX_FRONTIER_AGENT: 'Not Valid' }), /PSYX_FRONTIER_AGENT/);
});

test('the chat applies the user frontier setting, tells the browser where the reply came from, and stays local when unsupported', async () => {
  const requests = [];
  const settings = { frontierMode: 'deep' };
  const saved = [];
  const database = {
    ping: async () => true,
    stateRepository: { read: async () => ({ ...emptyState(), settings }),
      updateSettings: async (_userId, body) => { saved.push(body); settings.frontierMode = body.frontierMode; return { state: { ...emptyState(), settings } }; } },
    conversationRepository: { context: async () => [], saveCompletedTurn: async () => ({ id: '507f1f77bcf86cd799439011' }) }
  };
  const provider = { id: 'agentx', frontierReady: () => true,
    async stream(request, sink) { requests.push(request); sink.onToken('ok'); return { content: 'ok', routing: { location: request.location } }; } };
  const reviewer = { enabled: false, schedule: () => false, status: () => ({ status: 'disabled' }) };
  const config = { env: 'test', accessMode: 'token', accessToken: 'psyx-secret', sessionTtlMs: 3600000, loopbackBypass: false, maxBodyBytes: 262144,
    requestTimeoutMs: 1000, voice: { mode: 'disabled' }, frontier: { agent: 'psyx', model: 'gpt-5.6-sol', defaultMode: 'local' } };
  const start = async app => { const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); return server; };
  const headers = { Authorization: 'Bearer psyx-secret', 'Content-Type': 'application/json' };
  const server = await start(createApp({ config, database, provider, reviewer, logger: { error() {} } }));
  const base = `http://127.0.0.1:${server.address().port}/api/psyx`;
  const chat = psyx => fetch(`${base}/chat/stream`, { method: 'POST', headers, body: JSON.stringify({ message: 'hi', psyx }) }).then(response => response.text());
  try {
    const status = (await (await fetch(`${base}/status`, { headers })).json()).data.frontier;
    assert.deepEqual(status, { supported: true, enabled: true, location: 'frontier', model: 'gpt-5.6-sol', defaultMode: 'local', modes: ['local', 'deep', 'all'] });
    assert.match(await chat({ mode: 'talk', depth: 'normal' }), /"location":"local"/);
    assert.match(await chat({ mode: 'talk', depth: 'deep' }), /event: control\ndata: [^\n]*"location":"frontier"/);
    assert.deepEqual(requests.map(request => request.location), ['local', 'frontier']);

    assert.equal((await fetch(`${base}/state/settings`, { method: 'POST', headers, body: JSON.stringify({ frontierMode: 'all' }) })).status, 200);
    assert.deepEqual(saved, [{ frontierMode: 'all' }]);
    await chat({ mode: 'talk', depth: 'normal' });
    assert.equal(requests.at(-1).location, 'frontier');
  } finally { await new Promise(resolve => server.close(resolve)); }

  // Without a frontier agent the setting cannot send anything out.
  const offline = await start(createApp({ config, database, provider: { ...provider, frontierReady: () => false }, reviewer, logger: { error() {} } }));
  try {
    const url = `http://127.0.0.1:${offline.address().port}/api/psyx`;
    assert.deepEqual((await (await fetch(`${url}/status`, { headers })).json()).data.frontier, { supported: false, enabled: false, location: 'local' });
    await fetch(`${url}/chat/stream`, { method: 'POST', headers, body: JSON.stringify({ message: 'hi', psyx: { depth: 'deep' } }) }).then(response => response.text());
    assert.equal(requests.at(-1).location, 'local');
  } finally { await new Promise(resolve => offline.close(resolve)); }
});
