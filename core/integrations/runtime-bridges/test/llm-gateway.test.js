'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { clientForRequest, parseGatewayClients } = require('../llm-gateway/clients');
const { ChatSseToResponsesSse, chatRequest, foldHistory } = require('../llm-gateway/responses');
const { registerLlmGateway } = require('../llm-gateway/router');

function fakeExpress() {
  return {
    Router() {
      const routes = [];
      const add = method => (path, ...handlers) => routes.push({ method, path, handlers });
      return { routes, get: add('get'), post: add('post'), all: add('all'), use: add('use') };
    }
  };
}

class Request extends EventEmitter {
  constructor({ body = {}, headers = {}, params = {} } = {}) {
    super();
    this.body = body;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    this.params = params;
    this.method = 'POST';
    this.path = '/';
  }
  get(name) { return this.headers[String(name).toLowerCase()] || ''; }
}

class Response extends PassThrough {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.jsonBody = undefined;
    this.text = '';
    this.on('data', chunk => { this.text += chunk.toString('utf8'); });
  }
  status(code) { this.statusCode = code; return this; }
  set(name, value) {
    if (typeof name === 'object') Object.assign(this.headers, name);
    else this.headers[name] = value;
    return this;
  }
  json(value) { this.jsonBody = value; this.end(JSON.stringify(value)); return this; }
}

function snapshot() {
  const task = { taskType: 'daily_operator', model: 'model-a', hostUrl: 'http://model-host.test:11434', contextSize: 196608, pinAligned: true };
  return { generatedAt: '2026-10-16T00:00:00.000Z', tasks: { daily_operator: task } };
}

const CODEX_TOKEN = 'codex-token-0123456789';
const AUTH = { authorization: `Bearer ${CODEX_TOKEN}` };

function gateway(execute, clients = parseGatewayClients(JSON.stringify({ codex: { token: CODEX_TOKEN, admission: 'immediate' } }))) {
  const calls = [];
  const router = registerLlmGateway({
    express: fakeExpress(),
    logger: {},
    clients,
    runtimeServices: {
      routing: { getEffectiveSnapshot: async () => snapshot() },
      inference: { execute: async (request, options) => { calls.push({ request, options }); return execute(request, options); } }
    }
  });
  const handler = (method, path) => router.routes.find(entry => entry.method === method && entry.path === path).handlers[0];
  return { calls, handler };
}

function events(text) {
  return text.split('\n\n').filter(Boolean).map(block => {
    const [eventLine, dataLine] = block.split('\n');
    const data = JSON.parse(dataLine.slice('data: '.length));
    assert.equal(eventLine, `event: ${data.type}`);
    return data;
  });
}

const CODEX_TOOLS = [
  { type: 'function', name: 'exec_command', description: 'Run a command', strict: false,
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  { type: 'namespace', name: 'multi_agent_v1', description: 'Sub-agents', tools: [
    { type: 'function', name: 'wait_agent', parameters: { type: 'object', properties: {} } }
  ] },
  { type: 'custom', name: 'apply_patch', description: 'Edit files' },
  { type: 'web_search', external_web_access: false }
];

test('gateway clients are named by unique tokens and validated at startup', () => {
  const clients = parseGatewayClients('{"codex-windows":"abcdefghijklmnop","script":{"token":"qrstuvwxyz012345","admission":"immediate"}}');
  assert.deepEqual(clients.map(client => [client.id, client.callerDetail, client.consumerContract, client.admission]), [
    ['codex-windows', 'llm-gateway/codex-windows', 'codex-windows-gateway-v1', 'patient'],
    ['script', 'llm-gateway/script', 'script-gateway-v1', 'immediate']
  ]);
  assert.deepEqual(parseGatewayClients(''), []);
  // Hermes moves off its legacy address as an ordinary token client.
  assert.deepEqual(parseGatewayClients('{"hermes":{"token":"abcdefghijklmnop","admission":"immediate"}}')
    .map(client => [client.id, client.consumerContract, client.admission]), [['hermes', 'hermes-gateway-v1', 'immediate']]);
  for (const raw of ['[1]', 'nope', '{"Codex":"abcdefghijklmnop"}', '{"codex":"short"}',
    '{"codex":{"token":"abcdefghijklmnop","priority":1}}', '{"codex":{"token":"abcdefghijklmnop","admission":"later"}}',
    '{"a":"abcdefghijklmnop","b":"abcdefghijklmnop"}', '{"codex":{}}']) {
    assert.throws(() => parseGatewayClients(raw), { code: 'LLM_GATEWAY_CLIENTS_INVALID' }, raw);
  }
});

test('the bearer token alone identifies the client', () => {
  const clients = parseGatewayClients('{"one":"abcdefghijklmnop","two":"qrstuvwxyz012345"}');
  const request = authorization => ({ headers: authorization ? { authorization } : {} });
  assert.equal(clientForRequest(clients, request('Bearer qrstuvwxyz012345')).id, 'two');
  assert.equal(clientForRequest(clients, request('bearer abcdefghijklmnop')).id, 'one');
  assert.equal(clientForRequest(clients, request('Bearer wrong')), null);
  assert.equal(clientForRequest(clients, request()), null);
  assert.equal(clientForRequest([], request('Bearer abcdefghijklmnop')), null);
});

test('requests without a known token are refused before inference', async () => {
  const { calls, handler } = gateway(async () => assert.fail('no inference'));
  const body = { model: 'model-a', messages: [{ role: 'user', content: 'hi' }] };
  for (const headers of [{}, { authorization: 'Bearer stranger-token-000000' }]) {
    const res = new Response();
    await handler('post', '/v1/responses')(new Request({ body, headers }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['WWW-Authenticate'], 'Bearer');
  }
  const models = new Response();
  await handler('get', '/v1/models')(new Request(), models);
  assert.equal(models.statusCode, 401);
  assert.equal(calls.length, 0);
});

test('chat completions run under the client identity and the principal alias context', async () => {
  const { calls, handler } = gateway(async () => ({
    ok: true, status: 200, metadata: { model: 'model-a', upstreamProtocol: 'ollama' },
    body: { model: 'model-a', message: { role: 'assistant', content: 'bonjour' }, done: true, prompt_eval_count: 3, eval_count: 1 }
  }));
  const res = new Response();
  await handler('post', '/v1/chat/completions')(new Request({
    headers: AUTH, body: { model: 'agentx-primary', messages: [{ role: 'user', content: 'salut' }] }
  }), res);
  assert.equal(res.jsonBody.choices[0].message.content, 'bonjour');
  const [{ request, options }] = calls;
  assert.equal(request.model, 'model-a');
  assert.deepEqual(request.options, { num_ctx: 196608 });
  assert.equal(request.callerDetail, 'llm-gateway/codex');
  assert.equal(options.consumerContract, 'codex-gateway-v1');
  assert.equal(options.hostUrl, 'http://model-host.test:11434');
});

test('a Codex Responses request becomes chat messages and plain function tools', () => {
  const { chat, names } = chatRequest({
    model: 'agentx-primary', instructions: 'You are Codex.', stream: true, store: false,
    tool_choice: 'auto', parallel_tool_calls: true, reasoning: { summary: 'auto' }, include: ['reasoning.encrypted_content'],
    tools: CODEX_TOOLS,
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Sandbox: read-only' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }, { type: 'input_image', image_url: 'data:' }] },
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'wait_agent', namespace: 'multi_agent_v1', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
      { type: 'function_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: 'no agents' }] }
    ]
  });
  assert.deepEqual(chat.tools.map(tool => tool.function.name), ['exec_command', 'multi_agent_v1__wait_agent', 'apply_patch']);
  assert.deepEqual(chat.tools[2].function.parameters.required, ['input']);
  assert.equal(chat.tool_choice, 'auto');
  assert.equal(names.get('multi_agent_v1__wait_agent').namespace, 'multi_agent_v1');
  assert.deepEqual(chat.messages.map(message => message.role), ['system', 'system', 'user', 'assistant', 'tool', 'tool']);
  assert.deepEqual(chat.messages[2].content, [{ type: 'text', text: 'list files' }, { type: 'image_url', image_url: { url: 'data:' } }]);
  assert.deepEqual(chat.messages[3].tool_calls.map(call => [call.id, call.function.name]),
    [['call_1', 'exec_command'], ['call_2', 'multi_agent_v1__wait_agent']]);
  assert.deepEqual(chat.messages[5], { role: 'tool', tool_call_id: 'call_2', tool_name: 'multi_agent_v1__wait_agent', content: 'no agents' });
});

test('Responses requests that need server state or unknown items are refused', () => {
  assert.throws(() => chatRequest({ model: 'm', previous_response_id: 'resp_1', input: 'hi' }), { statusCode: 400 });
  assert.throws(() => chatRequest({ model: 'm', input: [{ type: 'mystery' }] }), { code: 'RESPONSES_REQUEST_INVALID' });
  assert.throws(() => chatRequest({ model: 'm', input: [] }), { statusCode: 400 });
  assert.deepEqual(chatRequest({ model: 'm', input: 'hi' }).chat.messages, [{ role: 'user', content: 'hi' }]);
});

test('a non-streaming answer becomes reasoning, message and namespaced call items', async () => {
  const { handler } = gateway(async () => ({
    ok: true, status: 200, metadata: { model: 'model-a', upstreamProtocol: 'ollama' },
    body: {
      model: 'model-a', done: true, prompt_eval_count: 20, eval_count: 7,
      message: { role: 'assistant', thinking: 'need agent', content: 'Waiting.',
        tool_calls: [{ function: { name: 'multi_agent_v1__wait_agent', arguments: { targets: ['a'] } } }] }
    }
  }));
  const res = new Response();
  await handler('post', '/v1/responses')(new Request({ headers: AUTH,
    body: { model: 'agentx-primary', input: 'go', tools: CODEX_TOOLS } }), res);
  const response = res.jsonBody;
  assert.equal(response.object, 'response');
  assert.equal(response.status, 'completed');
  assert.deepEqual(response.output.map(item => item.type), ['reasoning', 'message', 'function_call']);
  assert.equal(response.output[0].summary[0].text, 'need agent');
  assert.equal(response.output[1].content[0].text, 'Waiting.');
  const call = response.output[2];
  assert.deepEqual([call.name, call.namespace, call.arguments], ['wait_agent', 'multi_agent_v1', '{"targets":["a"]}']);
  assert.match(call.call_id, /^call_agentx_/);
  assert.deepEqual([response.usage.input_tokens, response.usage.output_tokens, response.usage.total_tokens], [20, 7, 27]);
});

test('a streamed Ollama answer becomes the Responses event sequence Codex reads', async () => {
  const upstream = new PassThrough();
  const { handler } = gateway(async () => ({ ok: true, status: 200, stream: upstream, metadata: { model: 'model-a', upstreamProtocol: 'ollama' } }));
  const res = new Response();
  await handler('post', '/v1/responses')(new Request({ headers: AUTH,
    body: { model: 'agentx-primary', stream: true, input: 'go', tools: CODEX_TOOLS } }), res);
  upstream.end([
    { message: { role: 'assistant', thinking: 'plan ' }, done: false },
    { message: { thinking: 'it' }, done: false },
    { message: { content: 'Running ' }, done: false },
    { message: { content: 'ls.' }, done: false },
    { message: { tool_calls: [{ function: { name: 'apply_patch', arguments: { input: '*** Begin Patch' } } }] }, done: false },
    { message: { tool_calls: [{ function: { name: 'exec_command', arguments: { cmd: 'ls' } } }] },
      done: true, prompt_eval_count: 11, eval_count: 5 }
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  await once(res, 'finish');
  assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  const seen = events(res.text);
  assert.equal(seen[0].type, 'response.created');
  assert.deepEqual(seen.map(event => event.sequence_number), seen.map((_event, index) => index));
  const deltas = type => seen.filter(event => event.type === type).map(event => event.delta).join('');
  assert.equal(deltas('response.reasoning_summary_text.delta'), 'plan it');
  assert.equal(deltas('response.output_text.delta'), 'Running ls.');
  assert.equal(deltas('response.function_call_arguments.delta'), '{"cmd":"ls"}');
  const last = seen[seen.length - 1];
  assert.equal(last.type, 'response.completed');
  assert.deepEqual(last.response.output.map(item => item.type), ['reasoning', 'message', 'custom_tool_call', 'function_call']);
  assert.equal(last.response.output[2].input, '*** Begin Patch');
  assert.equal(last.response.output[3].arguments, '{"cmd":"ls"}');
  assert.equal(last.response.usage.total_tokens, 16);
  const added = seen.filter(event => event.type === 'response.output_item.added').map(event => event.output_index);
  const done = seen.filter(event => event.type === 'response.output_item.done').map(event => event.output_index);
  assert.deepEqual(added, [0, 1, 2, 3]);
  assert.deepEqual(done.sort(), [0, 1, 2, 3]);
});

test('fragmented OpenAI tool calls are joined and a length stop is incomplete', async () => {
  const names = chatRequest({ model: 'm', input: 'x', tools: CODEX_TOOLS }).names;
  const transform = new ChatSseToResponsesSse('model-a', names);
  let text = '';
  transform.on('data', chunk => { text += chunk.toString('utf8'); });
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  transform.end([
    chunk({ tool_calls: [{ index: 0, id: 'call_x', function: { name: 'exec_command', arguments: '{"cmd":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }] }),
    chunk({}, 'length'),
    'data: [DONE]\n\n'
  ].join(''));
  await once(transform, 'end');
  const seen = events(text);
  const last = seen[seen.length - 1];
  assert.equal(last.type, 'response.incomplete');
  assert.deepEqual(last.response.incomplete_details, { reason: 'max_output_tokens' });
  assert.deepEqual(last.response.output.map(item => [item.call_id, item.arguments]), [['call_x', '{"cmd":"pwd"}']]);
  assert.equal(seen.filter(event => event.type === 'response.output_item.added').length, 1);
});

test('a history over Core\'s message limit folds its oldest turns into text', () => {
  const messages = [{ role: 'system', content: 'rules' }];
  for (let turn = 0; turn < 300; turn += 1) {
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${turn}`, function: { name: 'ls', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: `c${turn}`, content: `out ${turn}` });
  }
  const folded = foldHistory(messages);
  assert.ok(folded.length <= 512);
  assert.equal(folded[0].content, 'rules');
  assert.equal(folded[1].role, 'user');
  assert.match(folded[1].content, /\[assistant called ls\(\{\}\)\]\n\n\[tool result\] out 0/);
  assert.equal(folded[2].role, 'assistant');
  assert.equal(folded[folded.length - 1].content, 'out 299');
  assert.equal(foldHistory(messages.slice(0, 10)).length, 10);
});

const PIXELS = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
const IMAGE_URL = `data:image/png;base64,${PIXELS}`;
const visionRequired = () => Object.assign(new Error('This model does not confirm image support.'),
  { statusCode: 400, code: 'INFERENCE_VISION_REQUIRED' });
const answer = text => ({ ok: true, status: 200, metadata: { model: 'model-a', upstreamProtocol: 'ollama' },
  body: { model: 'model-a', done: true, message: { role: 'assistant', content: text } } });

test('images reach a model that reads them as Ollama image bytes', async () => {
  const { calls, handler } = gateway(async () => answer('A chart.'));
  const res = new Response();
  await handler('post', '/v1/chat/completions')(new Request({ headers: AUTH, body: { model: 'agentx-primary', messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: IMAGE_URL } }] }
  ] } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].request.messages, [{ role: 'user', content: 'What is this?', images: [PIXELS] }]);
  assert.equal(res.headers['X-AgentX-Images-Described'], undefined);
});

test('a model that does not read images receives a description from Main instead', async () => {
  const { calls, handler } = gateway(async request => {
    if (request.execution?.agentId === 'main') {
      return { ok: true, status: 200, body: { message: { content: 'A red bar chart.' },
        executionReceipt: { source: 'openclaw', mode: 'agent', requested: { agentId: 'main' }, completion: 'completed', runId: 'run-1' } } };
    }
    if (request.messages.some(message => message.images)) throw visionRequired();
    return answer('It shows sales.');
  });
  const res = new Response();
  await handler('post', '/v1/chat/completions')(new Request({ headers: AUTH, body: { model: 'agentx-primary', messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: IMAGE_URL } }] }
  ] } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.choices[0].message.content, 'It shows sales.');
  assert.equal(res.headers['X-AgentX-Images-Described'], 'true');
  const [refused, analysis, described] = calls.map(call => call.request);
  assert.deepEqual(refused.messages[0].images, [PIXELS]);
  assert.equal(analysis.callerDetail, 'llm-gateway-image-description');
  assert.equal(analysis.messages[1].content[1].source.data, PIXELS);
  assert.equal(described.messages[0].images, undefined);
  assert.match(described.messages[0].content, /^What is this\?\n\n\[Image 1, described by AgentX because model-a does not read images\]\nA red bar chart\.$/);
});

test('other refusals with images are not retried as descriptions', async () => {
  const { calls, handler } = gateway(async () => { throw Object.assign(new Error('bad'), { statusCode: 400, code: 'OTHER' }); });
  const res = new Response();
  await handler('post', '/v1/chat/completions')(new Request({ headers: AUTH, body: { model: 'agentx-primary', messages: [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: IMAGE_URL } }] }
  ] } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 1);
});

function claimError({ claimedAt, estimatedEndAt }) {
  const cause = Object.assign(new Error('Ollama host is held by an active benchmark claim'), {
    code: 'BENCHMARK_CLAIM_ACTIVE', statusCode: 503, claimSource: 'profiler', claimedAt, estimatedEndAt
  });
  return Object.assign(new Error('Inference host is reserved by an active benchmark workload.'), {
    code: 'BENCHMARK_CLAIM_ACTIVE', statusCode: 409, cause
  });
}

test('a host held past the patient wait is refused at once with who holds it and until when', async () => {
  const now = Date.now();
  const error = claimError({ claimedAt: new Date(now - 60_000).toISOString(), estimatedEndAt: new Date(now + 90 * 60_000).toISOString() });
  const { calls, handler } = gateway(async () => { throw error; },
    parseGatewayClients(JSON.stringify({ codex: { token: CODEX_TOKEN, admission: 'patient' } })));
  const res = new Response();
  await handler('post', '/v1/chat/completions')(new Request({
    headers: AUTH, body: { model: 'agentx-primary', messages: [{ role: 'user', content: 'salut' }] }
  }), res);
  assert.equal(calls.length, 1);
  assert.equal(res.statusCode, 409);
  assert.equal(res.headers['x-agentx-inference-outcome'], 'host-busy');
  assert.equal(res.jsonBody.error.code, 'BENCHMARK_CLAIM_ACTIVE');
  assert.match(res.jsonBody.error.message, /une mesure du Profiler depuis .+, fin estimée vers \d\d h \d\d\. Rien n'est envoyé vers le cloud\. Réessaie après\./);
});

test('a busy host without an announced end keeps the generic retry advice', async () => {
  const { handler } = gateway(async () => { throw claimError({ claimedAt: null, estimatedEndAt: null }); });
  const res = new Response();
  await handler('post', '/v1/chat/completions')(new Request({
    headers: AUTH, body: { model: 'agentx-primary', messages: [{ role: 'user', content: 'salut' }] }
  }), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.jsonBody.error.message, /occupé par une mesure du Profiler\. Rien n'est envoyé vers le cloud\. Réessaie dans quelques minutes\./);
});

test('a host awaiting recovery is a final readable refusal, not a retryable 503', async () => {
  const { handler } = gateway(async () => {
    throw Object.assign(new Error('Inference host requires recovery before accepting new requests.'), {
      code: 'RUNTIME_INFERENCE_RECOVERY_REQUIRED', statusCode: 503
    });
  });
  const res = new Response();
  await handler('post', '/v1/chat/completions')(new Request({
    headers: AUTH, body: { model: 'agentx-primary', messages: [{ role: 'user', content: 'salut' }] }
  }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.jsonBody.error.type, 'host_busy');
  assert.match(res.jsonBody.error.message, /attend une intervention après un incident/);
});
