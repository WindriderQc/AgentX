'use strict';

const express = require('express');
const request = require('supertest');
const Transaction = require('../../models/FinanceTransaction');
const Statement = require('../../models/FinanceStatement');
const Plan = require('../../models/FinancePlan');
const createRoutes = require('../../routes/finance');
const { insights } = require('../../src/services/finance/financeInsights');
const mongoose = require('mongoose');

beforeEach(async () => {
  await Promise.all([Transaction.deleteMany({}), Statement.deleteMany({}), Plan.deleteMany({})]);
  const rows = [
    ['perso', '2026-03-10', 'Synthetic supplier', -1000],
    ['corp', '2026-02-10', 'Synthetic supplier', -9000],
    ['corp', '2026-03-01', 'Synthetic supplier', -2000],
    ['corp', '2026-03-10', 'Synthetic supplier', -3000],
    ['corp', '2026-03-12', 'Other merchant', -7000],
    ['corp', '2026-04-01', 'Synthetic supplier', -5000]
  ];
  await Transaction.insertMany(rows.map(([ledger, date, description, flowCents], i) => ({
    statementId: new mongoose.Types.ObjectId(), ledger, accountKey: `${ledger}|EOP`, accountCode: 'EOP',
    date, description, flowCents, amountCents: flowCents, fingerprint: `synthetic-${i}`, occurrence: 1
  })));
});

function app() {
  const server = express();
  server.use('/api/finance', express.json(), createRoutes());
  return server;
}

test('HTTP responses keep the selected book and effective filters visible', async () => {
  const server = app();
  const input = { ledger: 'corp', q: 'Synthetic supplier', from: '2026-03-05', to: '2026-03-31' };
  const result = await request(server).get('/api/finance/transactions').query(input).expect(200);
  expect(result.body.data.totals.netCents).toBe(-3000);
  expect(result.body.data.rows).toHaveLength(1);
  expect(result.body.data.scope).toEqual({ kind: 'ledger', ledger: 'corp', filters: {
    q: 'Synthetic supplier', from: '2026-03-05', to: '2026-03-31', limit: 100
  } });
  const personal = await request(server).get('/api/finance/transactions').query({ ...input, ledger: 'perso' }).expect(200);
  expect(personal.body.data.totals.netCents).toBe(-1000);
});

test('HTTP refuses unsupported selectors and invalid books instead of widening a read', async () => {
  for (const [route, query] of [
    ['balances', { account: 'EOP' }], ['coverage', { from: '2026-01-01' }],
    ['transactions', { ledger: 'company' }], ['transactions', { q: ['one', 'two'] }],
    ['insights', { from: '2026-04-01', to: '2026-03-01' }], ['goals', { ledger: 'corp' }]
  ]) {
    const result = await request(app()).get(`/api/finance/${route}`).query(query).expect(400);
    expect(result.body.code).toBe('FINANCE_QUERY_INVALID');
  }
  const rules = await request(app()).get('/api/finance/rules?ledger=corp').expect(200);
  expect(rules.body.data.scope).toEqual({ kind: 'shared', ledgers: ['perso', 'corp'] });
});

test('insights intersect their lookback with the requested period, merchant and book', async () => {
  const result = await insights({ ledger: 'corp', from: '2026-03-05', to: '2026-03-31', q: 'Synthetic supplier' });
  expect(result.period).toEqual({ from: '2026-03-05', to: '2026-03-10', months: 1 });
  expect(result.savings).toEqual([expect.objectContaining({ month: '2026-03', outCents: -3000 })]);
  expect(result.categoryTrends).toHaveLength(1);
  expect(result.categoryTrends[0].recentMonthlyCents).toBe(-3000);
  const resultHttp = await request(app()).get('/api/finance/insights').query({ ledger: 'corp', from: '2026-03-05', to: '2026-03-31', q: 'Synthetic supplier' }).expect(200);
  expect(resultHttp.body.data.scope.ledger).toBe('corp');
  expect(resultHttp.body.data.scope.filters.q).toBe('Synthetic supplier');
});
