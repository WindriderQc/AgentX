'use strict';

const express = require('express');
const request = require('supertest');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const Statement = require('../../models/FinanceStatement');
const Transaction = require('../../models/FinanceTransaction');
const Plan = require('../../models/FinancePlan');
const query = require('../../src/services/finance/financeQueryService');
const analysis = require('../../src/services/finance/financeInsights');
const plan = require('../../src/services/finance/financePlan');
const { assessCoverage, lastDayOf } = require('../../src/services/finance/financeCompleteness');
const { flowOf } = require('../../src/services/finance/ledgers');
const createRoutes = require('../../routes/finance');
const BANK = 'synthetic-bank|1234|EOP';
const CARD = 'synthetic-card|5678|CARD';
let sequence = 0;

beforeEach(async () => {
  await Promise.all([Statement.deleteMany({}), Transaction.deleteMany({}), Plan.deleteMany({})]);
});

async function declare(keys = [BANK], dates = {}) {
  return plan.savePlan({ coverageAccounts: keys.map(accountKey => ({
    ledger: accountKey.startsWith('corp:') ? 'corp' : 'perso', accountKey, ...dates
  })) });
}
async function source(key, from, to, rows = []) {
  const ledger = key.startsWith('corp:') ? 'corp' : 'perso';
  const code = key.split('|').at(-1);
  const id = ++sequence;
  const statement = await Statement.create({ statementKey: `synthetic-${id}`, fileSha256: `synthetic-${id}`,
    fileName: `synthetic-${id}.pdf`, issuer: key.split('|')[0], ledger, status: 'reconciled',
    periodStart: from, periodEnd: to, accountLast4: key.split('|')[1],
    accounts: [{ accountKey: key, code, openingCents: 0,
      closingCents: rows.reduce((sum, row) => sum + row[1], 0), transactionCount: rows.length }] });
  if (rows.length) await Transaction.insertMany(rows.map(([date, amountCents, tags = [], category = null], index) => ({
    statementId: statement._id, ledger, accountKey: key, accountCode: code, date, description: 'Synthetic bank channel',
    amountCents, flowCents: flowOf(code, amountCents), fingerprint: `synthetic-${id}-${index}`, occurrence: 1, category, tags
  })));
  return statement;
}
const monthSource = (key, month, rows = []) => source(key, `${month}-01`, lastDayOf(month), rows);
const app = () => express().use('/api/finance', express.json(), createRoutes());

test('an observed card without declared expectations is unknown, never silently complete without payroll', async () => {
  await monthSource(CARD, '2026-06', [['2026-06-05', 1000]]);
  const result = await query.monthly();
  expect(result.coverage).toMatchObject({ status: 'unknown', complete: false, inventoryConfirmed: false });
  expect(result.months[0]).toMatchObject({ complete: false, outCents: -1000 });
  expect(result.averageNetCents).toBeNull();
  expect(result.dataAsOf).toBe('2026-06-30');
});

test('removing an expected card statement degrades the book even when it had no operations', async () => {
  await declare([BANK, CARD]);
  await monthSource(BANK, '2026-06');
  const card = await monthSource(CARD, '2026-06');
  expect((await query.monthly()).averageNetCents).toBe(0);
  await Statement.deleteOne({ _id: card._id });
  const result = await query.monthly();
  expect(result.coverage).toMatchObject({ status: 'partial', dataAsOf: null });
  expect(result.coverage.reasons).toContainEqual(expect.objectContaining({ code: 'missing_account_days', accountKey: CARD }));
  expect(result.averageNetCents).toBeNull();
  expect(result.months[0].netCents).toBeNull();
});

test('a covered empty month is zero; a month without a source remains a visible null', async () => {
  await declare();
  await monthSource(BANK, '2026-06');
  const result = await query.monthly({ from: '2026-06-01', to: '2026-07-31', tag: 'not-present' });
  expect(result.months.map(row => [row.month, row.count, row.netCents, row.complete])).toEqual([
    ['2026-06', 0, 0, true], ['2026-07', 0, null, false]
  ]);
  expect(result.averageNet).toMatchObject({ amountCents: 0, months: ['2026-06'], monthCount: 1, unit: 'cents/month' });
  const situation = await plan.situation({ months: 1 });
  expect(situation.monthly.netCents).toBe(0);
  expect(situation.window.averageMonths).toEqual(['2026-06']);
});

test('an exact account or code filter still checks every day and keeps its source date', async () => {
  await declare();
  await source(BANK, '2026-06-01', '2026-06-14', [['2026-06-03', 5000]]);
  await source(BANK, '2026-06-16', '2026-06-30');
  for (const account of [BANK, 'EOP']) {
    const result = await query.monthly({ account });
    expect(result.months[0].complete).toBe(false);
    expect(result.averageNetCents).toBeNull();
    expect(result.dataAsOf).toBe('2026-06-30');
    expect(result.coverage.accounts[0].gaps).toEqual([{ from: '2026-06-15', to: '2026-06-15' }]);
  }
});

test('a partial requested month has a period total but cannot become a monthly average', async () => {
  await declare();
  await monthSource(BANK, '2026-06', [['2026-06-15', -3000]]);
  const result = await query.monthly({ from: '2026-06-10', to: '2026-06-20' });
  expect(result.coverage.complete).toBe(true);
  expect(result.months[0]).toMatchObject({ complete: false, netCents: -3000,
    netMeasure: { kind: 'period_total', unit: 'cents', period: { from: '2026-06-10', to: '2026-06-20' } } });
  expect(result.averageNetCents).toBeNull();
});

test('a year with one received month checks twelve months even under a tag filter', async () => {
  await declare();
  await monthSource(BANK, '2026-06', [['2026-06-15', -3000, ['activity']]]);
  const { years } = await analysis.yearly({ tag: 'activity' });
  expect(years[0]).toMatchObject({ year: '2026', fullYear: true, complete: false, netCents: -3000 });
  expect(years[0].expectedMonths).toHaveLength(12);
  expect(years[0].incompleteMonths).toHaveLength(11);
  expect(years[0].incompleteMonths).toContain('2026-02');
  const scoped = await analysis.yearly({ from: '2026-06-01', to: '2026-06-30' });
  expect(scoped.years[0]).toMatchObject({ fullYear: false, complete: true, period: { from: '2026-06-01', to: '2026-06-30' } });
});

async function trendFixture() {
  await declare();
  for (const [month, amount] of [['2026-05', -500], ['2026-06', -1000], ['2026-07', -2000]]) {
    await monthSource(BANK, month, [[`${month}-05`, amount]]);
  }
  await source(BANK, '2026-08-01', '2026-08-15', [['2026-08-05', -9000]]);
}

test('a recent monthly average names its two exact eligible months and a change keeps monthly units', async () => {
  await trendFixture();
  const result = await analysis.insights({ months: 4 });
  const trend = result.categoryTrends[0];
  expect(trend).toMatchObject({ recentMonthlyCents: -1500, previousMonthlyCents: -500, changeCents: -1000,
    recentMeasure: { kind: 'monthly_average', unit: 'cents/month', totalCents: -3000,
      months: ['2026-06', '2026-07'], monthCount: 2, display: '-15,00 $/mois' },
    changeMeasure: { kind: 'monthly_average_change', unit: 'cents/month', amountCents: -1000 } });
  expect(trend.recentMeasure.scopeText).toContain('2 mois couverts (2026-06, 2026-07)');
  expect(result.savings.at(-1)).toMatchObject({ complete: false, savingsRatePercent: null });
  expect(result.interpretation).toMatch(/ne prouvent pas/);
});

test('an absent comparison window stays null, not a zero baseline or fabricated increase', async () => {
  await declare();
  await monthSource(BANK, '2026-06', [['2026-06-10', -1000]]);
  const result = await analysis.insights({ from: '2026-06-01', to: '2026-06-30' });
  expect(result.categoryTrends[0]).toMatchObject({ recentMonthlyCents: -1000, previousMonthlyCents: null,
    changeCents: null, changePercent: null, previousMeasure: { months: [], monthCount: 0 } });
});

test('no eligible month leaves situation actuals, budget gaps and rates unavailable', async () => {
  await declare();
  await source(BANK, '2026-06-01', '2026-06-15', [['2026-06-03', 5000]]);
  await plan.saveSection('budget', [{ category: 'Revenus', monthlyCents: 10000 }]);
  const result = await plan.situation();
  expect(result.monthly).toMatchObject({ inCents: null, outCents: null, netCents: null });
  expect(result.budget[0]).toMatchObject({ actualMonthlyCents: null, gapCents: null });
  expect(result.budgetTotals.actualMonthlyCents).toBeNull();
});

test('books have independent expected accounts; a corporate card needs no payroll account', async () => {
  await declare([BANK, `corp:${CARD}`]);
  await monthSource(`corp:${CARD}`, '2026-06', [['2026-06-03', 5000]]);
  expect((await query.monthly({ ledger: 'corp' })).averageNetCents).toBe(-5000);
  expect((await assessCoverage({ ledger: 'perso', from: '2026-06-01', to: '2026-06-30' })).complete).toBe(false);
  const report = await assessCoverage({ ledger: 'corp' });
  expect(report.accounts.map(item => item.accountKey)).toEqual([`corp:${CARD}`]);
});

test('an unlisted observed account prevents confirming only a convenient part of the book', async () => {
  await declare();
  await monthSource(BANK, '2026-06');
  await monthSource(CARD, '2026-06');
  const result = await assessCoverage();
  expect(result).toMatchObject({ status: 'unknown', inventoryConfirmed: false });
  expect(result.accounts).toHaveLength(2);
  expect((await query.monthly({ account: BANK })).months[0].complete).toBe(true);
});

test('explicit active dates bound expectations without inventing activity before opening or after closing', async () => {
  await declare([BANK], { from: '2026-06-15', to: '2026-07-14' });
  await source(BANK, '2026-06-15', '2026-07-14');
  const result = await query.monthly({ from: '2026-06-01', to: '2026-08-31' });
  expect(result.months.map(item => [item.month, item.complete])).toEqual([
    ['2026-06', true], ['2026-07', true], ['2026-08', false]
  ]);
  expect(result.months[2].coverage.status).toBe('unavailable');
});

test('the common source date uses accounts active in the requested period rather than a later book inventory', async () => {
  await plan.savePlan({ coverageAccounts: [
    { ledger: 'perso', accountKey: BANK, from: '2026-01-01', to: '2026-06-30' },
    { ledger: 'perso', accountKey: CARD, from: '2026-07-01' }
  ] });
  await source(BANK, '2026-05-01', '2026-06-30');
  await monthSource(CARD, '2026-07');
  const result = await query.monthly({ from: '2026-05-01', to: '2026-05-31' });
  expect(result.coverage.complete).toBe(true);
  expect(result.dataAsOf).toBe('2026-06-30');
  expect(result.coverage.dataAsOf).toBe(result.dataAsOf);
});

test('a pending review blocks a completeness claim in its interval', async () => {
  await declare();
  const doc = await monthSource(BANK, '2026-06');
  await Statement.create({ status: 'needs_review', fileName: 'synthetic-review.pdf', fileSha256: 'synthetic-review',
    periodStart: '2026-06-01', periodEnd: '2026-06-30', accounts: doc.accounts });
  const report = await assessCoverage();
  expect(report.complete).toBe(false);
  expect(report.reasons).toContainEqual({ code: 'statements_need_review', count: 1 });
});

test('invalid calendar dates refuse reads and invalid source intervals stay explicitly unqualified', async () => {
  await declare();
  await source(BANK, '2026-02-30', '2026-03-31');
  await request(app()).get('/api/finance/coverage?from=2026-02-30&to=2026-03-31').expect(400);
  const response = await request(app()).get('/api/finance/coverage?from=2026-03-01&to=2026-03-31').expect(200);
  expect(response.body.data.complete).toBe(false);
  expect(response.body.data.reasons).toContainEqual(expect.objectContaining({ code: 'invalid_statement_period' }));
});

test('stored rows outside their source period stay visible and block an apparently empty covered month', async () => {
  await declare();
  await source(BANK, '2026-06-01', '2026-06-30', [['2025-01-03', -1000], ['2026-07-03', -2000]]);
  const result = await query.monthly();
  expect(result.months.find(item => item.month === '2025-01').netCents).toBe(-1000);
  expect(result.months.find(item => item.month === '2026-07').netCents).toBe(-2000);
  expect(result.months.find(item => item.month === '2026-06').netCents).toBeNull();
  expect(result.averageNetCents).toBeNull();
  expect(result.coverage.reasons).toContainEqual(expect.objectContaining({ code: 'row_dates_outside_source', accountKey: BANK }));
  expect((await analysis.yearly()).years.map(item => [item.year, item.netCents])).toEqual([['2025', -1000], ['2026', -2000]]);
});

test('a bounded old source-date anomaly does not invalidate an independently covered later month', async () => {
  await declare();
  await source(BANK, '2025-01-01', '2025-01-31', [['2025-02-03', -1000]]);
  await monthSource(BANK, '2026-07');
  const result = await query.monthly({ from: '2026-07-01', to: '2026-07-31' });
  expect(result.coverage.complete).toBe(true);
  expect(result.months[0]).toMatchObject({ complete: true, netCents: 0 });
});

test('goal pace excludes a hole between nonconsecutive eligible months', async () => {
  await declare();
  for (const month of ['2026-01', '2026-03', '2026-04']) await monthSource(BANK, month);
  await source(BANK, '2026-02-01', '2026-02-15', [['2026-02-10', -90000, ['synthetic-reserve']]]);
  await plan.saveSection('goals', [{ name: 'Synthetic goal', targetCents: 200000,
    source: { kind: 'tag', ref: 'synthetic-reserve' } }]);
  const result = await require('../../src/services/finance/financeGoals').goals({ now: new Date('2026-05-01T12:00:00Z') });
  expect(result.windowMonths).toEqual(['2026-01', '2026-03', '2026-04']);
  expect(result.goals[0]).toMatchObject({ paceMonthlyCents: 0,
    paceMeasure: { unit: 'cents/month', months: ['2026-01', '2026-03', '2026-04'] } });
});

test('a forecast cannot turn an absent cash balance into a zero starting balance', async () => {
  const result = await require('../../src/services/finance/financeSimulation').forecast();
  expect(result).toMatchObject({ status: 'unavailable', startCashCents: null, rows: [], endCashCents: null });
});

test('expected-account declarations reject cross-book keys, duplicate identities and impossible dates', async () => {
  for (const coverageAccounts of [
    [{ ledger: 'corp', accountKey: BANK }], [{ ledger: 'perso', accountKey: BANK, from: '2026-02-30' }],
    [{ ledger: 'perso', accountKey: BANK }, { ledger: 'perso', accountKey: BANK }]
  ]) await expect(plan.savePlan({ coverageAccounts })).rejects.toMatchObject({ code: 'FINANCE_PLAN_INVALID' });
});

test('recorded period totals keep purchase, card refund and paired debt-payment signs distinct', async () => {
  await declare([BANK, CARD]);
  await monthSource(BANK, '2026-06', [['2026-06-01', 10000], ['2026-06-02', -2000, [], 'Virements internes']]);
  await monthSource(CARD, '2026-06', [['2026-06-03', 3000], ['2026-06-04', -500], ['2026-06-05', -2000, [], 'Virements internes']]);
  const rows = await request(app()).get('/api/finance/transactions').expect(200);
  expect(rows.body.data.rows.map(row => [row.accountCode, row.amountCents, row.flowCents])).toEqual([
    ['CARD', -2000, 2000], ['CARD', -500, 500], ['CARD', 3000, -3000], ['EOP', -2000, -2000], ['EOP', 10000, 10000]
  ]);
  expect(rows.body.data.amountConvention.flowCents).toContain('negative is outgoing');
  const result = await query.monthly({ excludeCategory: 'Virements internes' });
  expect(result.months[0]).toMatchObject({ inCents: 10500, outCents: -3000, netCents: 7500,
    netMeasure: { kind: 'period_total', unit: 'cents' } });
  expect(result.averageNet).toMatchObject({ amountCents: 7500, monthCount: 1, unit: 'cents/month' });
});

test('the native reader receives the same coverage, denominator, unit and text from the real Core route', async () => {
  await trendFixture();
  const server = app().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(__dirname, '../fixtures/finance-native-read.mjs'),
      `http://127.0.0.1:${server.address().port}`, JSON.stringify({ action: 'insights', months: 4 })]);
    const result = JSON.parse(stdout);
    expect(result.coverage).toMatchObject({ ledger: 'perso', status: 'covered', period: { to: '2026-08-15' } });
    expect(result.incompleteMonths).toContain('2026-08');
    expect(result.categoryTrends[0].recentMeasure).toMatchObject({ display: '-15,00 $/mois', monthCount: 2,
      months: ['2026-06', '2026-07'], scopeText: 'Moyenne mensuelle sur 2 mois couverts (2026-06, 2026-07).' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
