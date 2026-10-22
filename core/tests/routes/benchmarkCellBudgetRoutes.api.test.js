'use strict';

// #897: Benchmark opens one Core budget per local native agent cell and closes
// it to read Core's own counts.

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/benchmarkClaimGuard', () => ({ getActiveBenchmarkClaim: jest.fn() }));

const { getActiveBenchmarkClaim } = require('../../src/services/benchmarkClaimGuard');
const cellBudgets = require('../../src/services/benchmarkCellBudget');
const routes = require('../../routes/nerve-center-benchmark-cell-budgets');

const HOST = 'http://primary:11434';
const CLAIM = { host: HOST, claimBatchId: 'batch-1', claimGeneration: 'claim-1', workloadAdmissionId: 'admission-1', workloadGeneration: 'workload-1' };
const BODY = { cellId: 'cell-1', envelopeFingerprint: 'e'.repeat(64), targetFingerprint: 't'.repeat(64), claims: [CLAIM],
  maxTurns: 20, maxToolCalls: 40, maxTokens: 500000, ttlMs: 900000 };

const app = express();
app.use(express.json());
app.use('/api/nerve-center', routes);
const asBenchmark = req => req.set('X-AgentX-Caller', 'benchmark-service');

beforeEach(() => {
  cellBudgets.resetForTests();
  getActiveBenchmarkClaim.mockResolvedValue({ batchId: 'batch-1', claimGeneration: 'claim-1', admissionId: 'admission-1', admissionGeneration: 'workload-1' });
});

test('Benchmark opens a budget on its exact active claim and reads Core counts on close', async () => {
  const opened = await asBenchmark(request(app).post('/api/nerve-center/benchmark-cell-budgets')).send(BODY);
  expect(opened.status).toBe(200);
  expect(opened.body.data).toMatchObject({ cellId: 'cell-1', envelopeFingerprint: BODY.envelopeFingerprint,
    targetFingerprint: BODY.targetFingerprint, maxTurns: 20, maxToolCalls: 40, maxTokens: 500000 });
  expect(opened.body.data.budgetId).toMatch(/^[a-f0-9]{32}$/);
  expect(getActiveBenchmarkClaim).toHaveBeenCalledWith(HOST);
  const closed = await asBenchmark(request(app).post(`/api/nerve-center/benchmark-cell-budgets/${opened.body.data.budgetId}/close`)).send({});
  expect(closed.status).toBe(200);
  expect(closed.body.data).toMatchObject({ budgetId: opened.body.data.budgetId, turns: 0, toolCalls: 0, exhaustedBy: null });
});

test('only the Benchmark service opens budgets, and only its opener closes one', async () => {
  const anonymous = await request(app).post('/api/nerve-center/benchmark-cell-budgets').send(BODY);
  expect(anonymous.status).toBe(403);
  const opened = await asBenchmark(request(app).post('/api/nerve-center/benchmark-cell-budgets')).send(BODY);
  const other = await request(app).post(`/api/nerve-center/benchmark-cell-budgets/${opened.body.data.budgetId}/close`)
    .set('X-AgentX-Caller', 'runtime-bridge').send({});
  expect(other.status).toBe(404);
});

test('a stale claim or an invalid ceiling opens no budget', async () => {
  getActiveBenchmarkClaim.mockResolvedValueOnce({ batchId: 'batch-1', claimGeneration: 'older', admissionId: 'admission-1', admissionGeneration: 'workload-1' });
  const stale = await asBenchmark(request(app).post('/api/nerve-center/benchmark-cell-budgets')).send(BODY);
  expect(stale.status).toBe(409);
  expect(stale.body.code).toBe('BENCHMARK_CELL_BUDGET_CLAIM_INACTIVE');
  const invalid = await asBenchmark(request(app).post('/api/nerve-center/benchmark-cell-budgets')).send({ ...BODY, maxTurns: 0 });
  expect(invalid.status).toBe(400);
  expect(invalid.body.code).toBe('BENCHMARK_CELL_BUDGET_REQUEST_INVALID');
});
