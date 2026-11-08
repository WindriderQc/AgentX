'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProductReads } = require('../agent-ops/product-reads');
const { createAioOpsEvidenceService } = require('../evidence-service');

const ecosystemRoute = '/api/nerve-center/ecosystem', budgetRoute = '/api/budget/status';
const ecosystem = { ok: true, status: 'success', data: { health: { status: 'degraded' } } };
const budget = { period: '24h', total_requests: 4, local_requests: 4, budget_health: 'red' };
const readers = () => ({ ecosystem: async () => ecosystem, budget: async () => budget });
function evidence(productReads, options = {}) {
  return createAioOpsEvidenceService({ productReads,
    openClawProvider: async () => ({}), hermesProvider: async () => ({}), cronProvider: async () => ({}),
    agentOpsBuilder: async ({ fetchJson }) => ({
      ecosystem: await fetchJson(ecosystemRoute), budget: await fetchJson(budgetRoute)
    }), ...options });
}

test('explicit native readers remove the two self HTTP reads and keep observed degradation', async t => {
  const fetchImpl = t.mock.fn(() => assert.fail('local reads must not use HTTP'));
  const native = { ecosystem: t.mock.fn(async () => ecosystem), budget: t.mock.fn(async () => budget) };
  const service = evidence(native, { fetchImpl });
  const first = await service.getAgentOpsProjection(), second = await service.getAgentOpsProjection();
  assert.equal(first.ecosystem.ok, true); assert.equal(first.ecosystem.body.data.health.status, 'degraded');
  assert.equal(first.budget.body.budget_health, 'red'); assert.deepEqual(first, second);
  assert.equal(native.ecosystem.mock.callCount(), 1); assert.equal(native.budget.mock.callCount(), 1);
  assert.equal(fetchImpl.mock.callCount(), 0);
});

for (const url of ['http://remote-core.example.test:9080/base/', 'http://127.0.0.1:3080']) {
  test(`an explicit productBaseUrl keeps HTTP: ${url}`, async t => {
    const calls = [];
    const service = evidence({ ecosystem: () => assert.fail(), budget: () => assert.fail() }, {
      productBaseUrl: url, fetchImpl: async value => {
        calls.push(value); return new Response(JSON.stringify(value.endsWith('/status') ? budget : ecosystem));
      }
    });
    const result = await service.getAgentOpsProjection();
    assert.equal(result.ecosystem.ok, true); assert.equal(result.budget.ok, true);
    assert.deepEqual(calls, [url.replace(/\/+$/, '') + ecosystemRoute, url.replace(/\/+$/, '') + budgetRoute]);
  });
}

test('an invalid explicit destination keeps its transport failure without native substitution', async () => {
  const service = evidence({ ecosystem: () => assert.fail(), budget: () => assert.fail() }, { productBaseUrl: 'invalid-url' });
  const result = await service.getAgentOpsProjection();
  for (const read of Object.values(result)) {
    assert.equal(read.ok, false); assert.equal(read.statusCode, null); assert.match(read.error, /Failed to parse URL/);
  }
});

test('an explicit productFetch keeps its response contract and bypasses native readers', async () => {
  const calls = [], response = { ok: false, statusCode: 418, body: { error: 'explicit client refusal' }, error: 'explicit client refusal' };
  const service = evidence({ ecosystem: () => assert.fail(), budget: () => assert.fail() }, {
    productFetch: async route => { calls.push(route); return response; }
  });
  const result = await service.getAgentOpsProjection();
  assert.equal(result.ecosystem, response); assert.equal(result.budget, response);
  assert.deepEqual(calls, [ecosystemRoute, budgetRoute]);
});

for (const option of ['productBaseUrl', 'productFetch']) {
  for (const value of [undefined, null, false, '', 0]) {
    test(`explicit ${option}=${String(value)} retains the existing HTTP fallback`, async () => {
      const calls = [];
      const service = evidence({ ecosystem: () => assert.fail(), budget: () => assert.fail() }, {
        [option]: value,
        fetchImpl: async url => { calls.push(url); return new Response(JSON.stringify(url.endsWith('/status') ? budget : ecosystem)); }
      });
      const result = await service.getAgentOpsProjection();
      assert.equal(result.ecosystem.ok, true); assert.equal(result.budget.ok, true);
      assert.deepEqual(calls, [`http://127.0.0.1:${process.env.PORT || 3080}${ecosystemRoute}`,
        `http://127.0.0.1:${process.env.PORT || 3080}${budgetRoute}`]);
    });
  }
}

for (const missing of ['ecosystem', 'budget', 'both']) {
  test(`only missing ${missing} native capabilities fall back to HTTP`, async () => {
    const native = readers(), calls = [];
    if (missing === 'both') { delete native.ecosystem; delete native.budget; } else delete native[missing];
    const result = await evidence(native, { fetchImpl: async url => {
      calls.push(url); throw new Error('synthetic transport unavailable');
    } }).getAgentOpsProjection();
    assert.equal(result.ecosystem.ok, missing === 'budget');
    assert.equal(result.budget.ok, missing === 'ecosystem');
    assert.equal(calls.length, missing === 'both' ? 2 : 1);
  });
}

test('other product routes retain the original transport', async () => {
  const calls = [];
  const read = createProductReads({ baseUrl: 'http://core.example.test', nativeReads: readers(), options: {
    fetchImpl: async url => { calls.push(url); return new Response(JSON.stringify({ count: 2 })); }
  } });
  const result = await read('/api/pipeline/tasks?view=summary');
  assert.equal(result.body.count, 2); assert.deepEqual(calls, ['http://core.example.test/api/pipeline/tasks?view=summary']);
});

test('native bodies preserve the HTTP JSON boundary without mutating canonical objects', async () => {
  const original = { ...ecosystem, generatedAt: new Date('2026-11-08T00:00:00Z'), omitted: undefined, number: NaN };
  const read = createProductReads({ nativeReads: { ecosystem: async () => original } });
  const result = await read(ecosystemRoute);
  assert.equal(result.body.generatedAt, '2026-11-08T00:00:00.000Z');
  assert.equal(Object.hasOwn(result.body, 'omitted'), false); assert.equal(result.body.number, null);
  result.body.data.health.status = 'changed'; assert.equal(original.data.health.status, 'degraded');
});

test('native errors are independent, sanitized and never retried over HTTP', async t => {
  for (const failed of ['ecosystem', 'budget']) {
    const native = readers(); native[failed] = () => { throw new Error('PRIVATE_COLLECTOR_ERROR'); };
    const fetchImpl = t.mock.fn(() => assert.fail('native failure must not use a second transport'));
    const result = await evidence(native, { fetchImpl }).getAgentOpsProjection();
    const broken = result[failed], successful = result[failed === 'ecosystem' ? 'budget' : 'ecosystem'];
    assert.equal(broken.ok, false); assert.equal(broken.statusCode, failed === 'ecosystem' ? 503 : 500);
    assert.equal(successful.ok, true); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_COLLECTOR_ERROR/);
    assert.equal(broken.error, failed === 'ecosystem' ? 'Ecosystem snapshot is unavailable.' : 'Budget status unavailable');
    assert.equal(fetchImpl.mock.callCount(), 0);
  }
});

test('absent native bodies stay unavailable instead of returning a successful read', async () => {
  const result = await evidence({ ecosystem: async () => null, budget: async () => ({}) }).getAgentOpsProjection();
  assert.equal(result.ecosystem.ok, false); assert.equal(result.budget.ok, false);
});

test('native reads keep the 5s deadline and late results cannot replace a timed-out result', async t => {
  let finish, reject;
  const read = createProductReads({ nativeReads: {
    ecosystem: () => new Promise(resolve => { finish = resolve; }),
    budget: () => new Promise((_, fail) => { reject = fail; })
  } });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pending = Promise.all([read(ecosystemRoute), read(budgetRoute)]);
  await Promise.resolve(); t.mock.timers.tick(5000);
  const results = await pending;
  for (const value of results) {
    assert.equal(value.ok, false); assert.equal(value.statusCode, null); assert.equal(value.body, null);
    assert.equal(value.durationMs, 5000); assert.match(value.error, /timed out after 5000ms/);
  }
  finish(ecosystem); reject(new Error('PRIVATE_LATE_ERROR')); await new Promise(setImmediate);
  assert.equal(results[0].body, null); assert.equal(results[1].body, null);
});
