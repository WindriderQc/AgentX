import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreFinanceClient, formatCents, withDisplay } from '../core-finance.js';

test('formats integer cents the Quebec way', () => {
  assert.equal(formatCents(123456), '1 234,56 $');
  assert.equal(formatCents(-450), '-4,50 $');
  assert.equal(formatCents(7923895), '79 238,95 $');
  assert.equal(formatCents(5), '0,05 $');
  assert.equal(formatCents(1.5), null);
});

test('adds display strings beside every cents field, nested', () => {
  assert.deepEqual(withDisplay({ totals: { netCents: -900, count: 2 }, rows: [{ amountCents: 250000 }] }), {
    totals: { netCents: -900, netDisplay: '-9,00 $', count: 2 },
    rows: [{ amountCents: 250000, amountDisplay: '2 500,00 $' }]
  });
});

test('forwards only the filters of the chosen question to Core', async () => {
  let captured;
  const ask = createCoreFinanceClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async (url, options) => {
    captured = { url: String(url), options };
    return { ok: true, json: async () => ({ status: 'success', data: { totals: { netCents: -900 } } }) };
  } });
  const result = await ask({ action: 'transactions', q: ' dojo ', from: '2026-05-01', status: 'ignored', limit: 20 });
  assert.equal(captured.url, 'http://127.0.0.1:3180/api/finance/transactions?from=2026-05-01&q=dojo&limit=20');
  assert.equal(captured.options.method, 'GET');
  assert.equal(captured.options.redirect, 'error');
  assert.deepEqual(result, { action: 'transactions', authority: 'agentx.core', totals: { netCents: -900, netDisplay: '-9,00 $' } });

  await ask({ action: 'balances', account: 'EOP' });
  assert.equal(captured.url, 'http://127.0.0.1:3180/api/finance/balances');
});

test('surfaces Core refusals and rejects unknown questions', async () => {
  const refusing = createCoreFinanceClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async () => ({ ok: false, status: 400,
    json: async () => ({ status: 'error', message: 'from must be a YYYY-MM-DD date' }) }) });
  await assert.rejects(refusing({ action: 'monthly', from: 'hier' }), /YYYY-MM-DD/);
  const down = createCoreFinanceClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async () => ({ ok: false, status: 503,
    json: async () => { throw new Error('not json'); } }) });
  await assert.rejects(down({ action: 'balances' }), /unavailable \(503\)/);
  await assert.rejects(down({ action: 'delete' }), /Unsupported/);
  assert.throws(() => createCoreFinanceClient(), /Configure/);
});

test('saves only confirmed rules through Core and returns its receipt', async () => {
  const { createCoreRulesClient } = await import('../core-finance.js');
  let captured;
  const teach = createCoreRulesClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body), method: options.method };
    return { ok: true, json: async () => ({ status: 'success', data: { saved: [{ pattern: 'dojo', transactions: 3 }], transactionsUpdated: 3 } }) };
  } });
  const result = await teach({ rules: [{ pattern: 'DOJO', category: 'Enfants et activités', tags: ['karate'], extra: 'x' }] });
  assert.equal(captured.url, 'http://127.0.0.1:3180/api/finance/rules');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(captured.body, { rules: [{ pattern: 'DOJO', category: 'Enfants et activités', tags: ['karate'] }], createdBy: 'comptable' });
  assert.equal(result.saved[0].transactions, 3);
  await assert.rejects(teach({ rules: [] }), /at least one/);
  const refusing = createCoreRulesClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async () => ({ ok: false, status: 400,
    json: async () => ({ status: 'error', message: 'category must be one of: Revenus' }) }) });
  await assert.rejects(refusing({ rules: [{ pattern: 'dojo', category: 'Karaté' }] }), /category must be one of/);
});

test('asks Core for yearly totals and insights with their filters', async () => {
  const urls = [];
  const ask = createCoreFinanceClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ status: 'success', data: { years: [{ year: '2025', outCents: -29800 }] } }) };
  } });
  const yearly = await ask({ action: 'yearly', tag: 'karate' });
  assert.deepEqual(yearly.years, [{ year: '2025', outCents: -29800, outDisplay: '-298,00 $' }]);
  await ask({ action: 'insights', months: 24, q: 'ignored' });
  assert.deepEqual(urls, ['http://127.0.0.1:3180/api/finance/summary/yearly?tag=karate',
    'http://127.0.0.1:3180/api/finance/insights?months=24']);
});

test('lists alerts with GET and reports them once with POST', async () => {
  const { createCoreAlertsClient } = await import('../core-finance.js');
  const calls = [];
  const client = createCoreAlertsClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async (url, options) => {
    calls.push([options.method, String(url)]);
    return { ok: true, json: async () => ({ status: 'success', data: { alerts: [{ kind: 'large_expense', facts: { amountCents: -180000 } }] } }) };
  } });
  const listed = await client({});
  assert.equal(listed.alerts[0].facts.amountDisplay, '-1 800,00 $');
  assert.equal(listed.reported, false);
  await client({ report: true });
  assert.deepEqual(calls, [['GET', 'http://127.0.0.1:3180/api/finance/alerts'], ['POST', 'http://127.0.0.1:3180/api/finance/alerts/report']]);
});

test('sends decisions for single transactions to Core', async () => {
  const { createCoreRulesClient } = await import('../core-finance.js');
  const calls = [];
  const teach = createCoreRulesClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async (url, options) => {
    calls.push([String(url), JSON.parse(options.body)]);
    return { ok: true, json: async () => ({ status: 'success', data: { saved: [{ id: 'a'.repeat(24) }], transactionsUpdated: 1 } }) };
  } });
  const result = await teach({ transactions: [{ id: 'a'.repeat(24), category: 'Enfants et activités', tags: ['rafael'] }] });
  assert.equal(calls[0][0], 'http://127.0.0.1:3180/api/finance/transactions/decisions');
  assert.deepEqual(calls[0][1].transactions[0], { id: 'a'.repeat(24), category: 'Enfants et activités', tags: ['rafael'] });
  assert.equal(result.transactionsUpdated, 1);
  assert.equal(calls.length, 1);
});

test('reads the plan and applies owner-stated operations', async () => {
  const { createCorePlanClient } = await import('../core-finance.js');
  const calls = [];
  const client = createCorePlanClient({ baseUrl: 'http://127.0.0.1:3180', fetchImpl: async (url, options) => {
    calls.push([options.method, String(url), options.body ? JSON.parse(options.body) : null]);
    return { ok: true, json: async () => ({ status: 'success', data: { budget: [{ label: 'Karaté', monthlyCents: 14941 }] } }) };
  } });
  const plan = await client({ action: 'get' });
  assert.equal(plan.budget[0].monthlyDisplay, '149,41 $');
  await client({ action: 'apply', ops: [{ op: 'remove', section: 'openItems', match: 'T2 corp' }] });
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['GET', 'http://127.0.0.1:3180/api/finance/plan'], ['POST', 'http://127.0.0.1:3180/api/finance/plan/ops']]);
  assert.deepEqual(calls[1][2], { ops: [{ op: 'remove', section: 'openItems', match: 'T2 corp' }] });
  await assert.rejects(client({ action: 'apply', ops: [] }), /at least one/);
});
