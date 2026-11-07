'use strict';

const express = require('express');
const request = require('supertest');
const Log = require('../../models/InferenceLog');
const { ingestRuntimeUsage } = require('../../src/services/runtimeUsageService');
const { buildCloudBudget } = require('../../src/services/budgetAccountingService');
const { budgetMetrics, provenanceMetrics, cloudCost } = require('../../src/services/runtimeUsageAnalytics');
const app = express();
app.use(express.json());
app.use('/api/analytics', require('../../routes/analytics-runtime-usage'));
app.use('/api/analytics/inference', require('../../routes/analytics-inference'));
app.use('/api/analytics', require('../../routes/analytics-federated'));
const receipt = (extra = {}) => ({ runtime: 'openclaw', instanceId: 'synthetic-instance', runId: 'native-run', callIndex: 0,
  provider: 'openrouter', model: 'vendor/synthetic', inputTokens: 70, outputTokens: 30,
  cachedInputTokens: 20, transport: 'direct-provider', billing: 'metered',
  nativeCost: { amount: 0.05, currency: 'USD' }, completedAt: new Date().toISOString(), ...extra });

beforeAll(async () => { await Log.createIndexes(); });
beforeEach(async () => { await Log.deleteMany({}); });

test('concurrent retries create one immutable declared row; changed usage conflicts', async () => {
  const input = receipt();
  const results = await Promise.all(Array.from({ length: 5 }, () => ingestRuntimeUsage(input)));
  expect(new Set(results.map(row => row.receiptId)).size).toBe(1);
  expect(await Log.countDocuments()).toBe(1);
  const stored = await Log.findOne().lean();
  expect(stored).toMatchObject({ source: 'declared-receipt', runtime: 'external', model: 'openrouter/vendor/synthetic',
    consumerContract: null, tokensIn: 70, tokensOut: 30, declaredUsage: { cachedInputTokens: 20, costUsd: 0.05, costSource: 'native' } });
  expect(JSON.stringify(stored)).not.toContain('native-run');
  await expect(ingestRuntimeUsage({ ...input, outputTokens: 31 })).rejects.toMatchObject({ code: 'RUNTIME_USAGE_IDENTITY_CONFLICT' });
  expect((await Log.findOne().lean()).tokensOut).toBe(30);
});

test('Core-observed reconciliation binds the same identity without inserting or repricing a call', async () => {
  const observed = await Log.create({ host: 'http://runtime.invalid', model: 'openrouter/synthetic', tokensIn: 9, tokensOut: 2 });
  const input = receipt({ transport: 'core', coreLogId: String(observed._id) });
  const linked = await ingestRuntimeUsage(input);
  expect(linked).toMatchObject({ source: 'core-observed', recorded: false });
  await ingestRuntimeUsage(input);
  await expect(ingestRuntimeUsage(receipt({ completedAt: input.completedAt }))).rejects.toMatchObject({ statusCode: 409 });
  expect(await Log.countDocuments()).toBe(1);
});

test('invalid, unknown, incomplete and stale receipts never create zero-usage rows', async () => {
  for (const extra of [{ inputTokens: undefined }, { cachedInputTokens: 71 }, { outputTokens: -1 }, { inputTokens: '70' },
    { callIndex: 0.1 }, { provider: 'ollama' }, { prompt: 'private data' }, { transport: undefined },
    { completedAt: new Date(Date.now() + 3600000).toISOString() }, { nativeCost: { amount: 1, currency: 'CAD' } }]) {
    await request(app).post('/api/analytics/runtime-usage').send(receipt(extra)).expect(400);
  }
  await request(app).post('/api/analytics/runtime-usage').send(receipt({ completedAt: '2020-01-01T00:00:00Z' })).expect(410);
  expect(await Log.countDocuments()).toBe(0);
});

test('subscription and unpriced declarations stay outside the cloud token gate, known metered spend enters it', async () => {
  await ingestRuntimeUsage(receipt());
  await ingestRuntimeUsage(receipt({ runId: 'subscription', provider: 'openai-codex', billing: 'subscription', nativeCost: undefined }));
  await ingestRuntimeUsage(receipt({ runId: 'unknown-cost', nativeCost: undefined }), { price: async () => null });
  const rows = await Log.aggregate([{ $group: { _id: '$model', requests: { $sum: 1 }, tokens: { $sum: { $add: ['$tokensIn', '$tokensOut'] } }, ...budgetMetrics } }]);
  expect(buildCloudBudget({ rows, cloudDailyLimit: 120 })).toMatchObject({ cloud_tokens: 300, cloud_gate_tokens: 100,
    cloud_declared_requests: 3, cloud_excluded_declared_requests: 2, cloud_health: 'yellow',
    cloud_spend_observability: 'core-observed-and-declared-calls' });
});

test('native costs and partial price coverage survive aggregation without applying API prices to subscription tokens', async () => {
  await ingestRuntimeUsage(receipt());
  await ingestRuntimeUsage(receipt({ runId: 'unknown', nativeCost: undefined }), { price: async () => null });
  const [row] = await Log.aggregate([{ $group: { _id: '$model', calls: { $sum: 1 }, ...provenanceMetrics } }]);
  const estimate = jest.fn();
  expect(await cloudCost(row, estimate)).toEqual({ estimatedCostUsd: 0.05, unpricedCalls: 1, coreObservedCalls: 0, declaredCalls: 2 });
  expect(estimate).not.toHaveBeenCalled();
});

test('pricing failures retain usage; reconciliation reads only safe fields', async () => {
  const saved = await ingestRuntimeUsage(receipt({ nativeCost: undefined }), { price: async () => { throw new Error('private diagnostic'); } });
  const response = await request(app).get('/api/analytics/runtime-usage/' + saved.receiptId).expect(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.result).toMatchObject({ source: 'declared-receipt', declaredUsage: { costUsd: null, costSource: 'unknown' } });
  expect(JSON.stringify(response.body)).not.toMatch(/native-run|private diagnostic|runIdHash|fingerprint/);
});

test('summary and federated APIs include declared native costs with reconciled provenance', async () => {
  await ingestRuntimeUsage(receipt());
  await ingestRuntimeUsage(receipt({ runId: 'subscription', billing: 'subscription', nativeCost: undefined }));
  const summary = await request(app).get('/api/analytics/inference/summary?window=24h').expect(200);
  expect(summary.body.data.totals).toMatchObject({ calls: 2, declaredCalls: 2, coreObservedCalls: 0 });
  expect(summary.body.data.cloud).toMatchObject({ calls: 2, declaredCalls: 2, coreObservedCalls: 0, estimatedCostUsd: 0.05,
    unpricedModels: ['openrouter/vendor/synthetic'] });
  const federated = await request(app).get('/api/analytics/federated?window=24h').expect(200);
  expect(federated.body.providers.totals).toMatchObject({ sessions: 2, declaredCalls: 2, coreObservedCalls: 0,
    estimatedSpendUsd: 0.05, unpricedCalls: 1 });
  expect(federated.body.local.totals.calls).toBe(0);
});
