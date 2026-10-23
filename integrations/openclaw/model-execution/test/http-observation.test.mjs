import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createExecutionService } from '../service.mjs';
import { observeHttp, observationFor, refusedResponse } from '../http-observation.mjs';

async function fixture() {
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    let raw = ''; for await (const chunk of req) raw += chunk;
    const { status = 400, delay = 0 } = JSON.parse(raw || '{}');
    await new Promise(resolve => setTimeout(resolve, delay));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'unsupported_parameter', param: 'temperature', message: 'SENSITIVE upstream diagnostic' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return { baseUrl, requests: () => requests, close: () => new Promise(resolve => server.close(resolve)) };
}
const selected = baseUrl => ({ provider: 'fixture', id: 'model', api: 'openai-completions', baseUrl });

test('native HTTP refusal metadata is correlated by request identity across concurrent calls', async () => {
  const f = await fixture();
  try {
    const a = observationFor(selected(f.baseUrl)), b = observationFor(selected(f.baseUrl));
    const run = (state, status, delay) => (async () => {
      for await (const _ of observeHttp(state, () => (async function* () {
        await fetch(f.baseUrl + '/chat/completions', { method: 'POST', body: JSON.stringify({ status, delay }) });
        yield 1;
      })())) { /* consume */ }
    })();
    await Promise.all([run(a, 400, 30), run(b, 402, 0)]);
    assert.equal(refusedResponse(a).status, 400); assert.equal(refusedResponse(b).status, 402);
    assert.equal(a.attempts, 1); assert.equal(b.attempts, 1);
    assert.equal(f.requests(), 2);
  } finally { await f.close(); }
});

test('only one observed negative HTTP acknowledgement settles a failed model call at known zero cost', async () => {
  const f = await fixture(), amounts = [], receipts = [];
  const model = selected(f.baseUrl);
  const descriptor = { model: 'fixture/model', maxTokens: 100, contextWindow: 1000, fingerprint: 'a'.repeat(64),
    isolation: { singleCallQualified: true }, billing: { kind: 'paid', rates: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } };
  let status = 400, twice = false;
  const backend = { catalogue: async () => ({ models: [descriptor] }), prepare: async () => ({ model, descriptor, runtimeVersion: 'fixture',
    stream: (context, options) => (async function* () {
      options.onPayload({ model: 'model', messages: context.messages, max_tokens: 10 });
      const response = await fetch(f.baseUrl + '/chat/completions', { method: 'POST', body: JSON.stringify({ status }) });
      if (twice) await fetch(f.baseUrl + '/chat/completions', { method: 'POST', body: JSON.stringify({ status }) });
      const errorBody = await response.text();
      yield { type: 'error', error: { errorCode: 'unsupported_parameter', errorBody, errorMessage: 'SENSITIVE upstream diagnostic' } };
    })() }) };
  const service = createExecutionService({ backend, maxRequestCostNanodollars: 2000000,
    ledger: { read: async () => ({}), record: async value => amounts.push(value) }, recordRefusal: value => receipts.push(value) });
  const request = { schema: 'agentx.openclaw-model-request/v1', requestId: 'original', model: 'fixture/model',
    messages: [{ role: 'user', content: 'synthetic' }], parameters: { maxTokens: 10 }, budget: { maxCalls: 1, maxCostNanodollars: 2000000 } };
  try {
    const error = await service.execute(request).catch(error => error);
    assert.equal(error.executionState, 'not-dispatched'); assert.equal(error.code, 'OPENCLAW_PROVIDER_REQUEST_REFUSED');
    assert.equal(error.refusalReceipt.requestId, 'original'); assert.equal(error.refusalReceipt.httpStatus, 400);
    assert.equal(error.refusalReceipt.diagnostic.parameter, 'temperature');
    assert.ok(!JSON.stringify(error).includes('SENSITIVE'));
    assert.deepEqual(amounts, [0]); assert.equal(receipts.length, 1);
    status = 503;
    const uncertain = await service.execute({ ...request, requestId: 'uncertain' }).catch(error => error);
    assert.equal(uncertain.executionState, 'unknown'); assert.equal(uncertain.refusalReceipt, undefined); assert.deepEqual(amounts, [0, null]);
    status = 402; twice = true;
    const retried = await service.execute({ ...request, requestId: 'two-http-attempts' }).catch(error => error);
    assert.equal(retried.executionState, 'unknown'); assert.equal(retried.refusalReceipt, undefined);
  } finally { await f.close(); }
});

test('a rejected payload is not a dispatched paid inference', async () => {
  const f = await fixture(), amounts = [];
  try {
    const model = selected(f.baseUrl), descriptor = { model: 'fixture/model', maxTokens: 100, contextWindow: 1000, fingerprint: 'a'.repeat(64),
      isolation: { singleCallQualified: true }, billing: { kind: 'paid', rates: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } };
    const backend = { catalogue: async () => ({ models: [descriptor] }), prepare: async () => ({ model, descriptor,
      stream: (_context, options) => (async function* () { options.onPayload({ messages: [], max_tokens: 10 }); })() }) };
    const service = createExecutionService({ backend, maxRequestCostNanodollars: 2000000,
      ledger: { read: async () => ({}), record: async value => amounts.push(value) } });
    const error = await service.execute({ schema: 'agentx.openclaw-model-request/v1', model: 'fixture/model',
      messages: [{ role: 'user', content: 'synthetic' }], parameters: { maxTokens: 10 } }).catch(error => error);
    assert.equal(error.code, 'OPENCLAW_CONTEXT_DRIFT'); assert.equal(error.executionState, 'not-dispatched');
    assert.equal(f.requests(), 0); assert.deepEqual(amounts, []);
  } finally { await f.close(); }
});
