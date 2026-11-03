'use strict';

// Core computes recorded totals, qualified averages and their exact units.
const Transaction = require('../../../models/FinanceTransaction');
const { transactionFilter } = require('./financeQueryService');
const { descriptionKey } = require('./financeCategories');
const { coverageContext, assessCoverage, monthsBetween, lastDayOf } = require('./financeCompleteness');
const { monthlyAverage, periodTotal, monthlyChange, money } = require('./financeMeasures');
const TRANSFERS = 'Virements internes';

function monthsBack(lastMonth, count) {
  const [year, month] = lastMonth.split('-').map(Number);
  return Array.from({ length: count }, (_, index) => new Date(Date.UTC(year, month - count + index, 1)).toISOString().slice(0, 7));
}

// Unqualified totals still describe stored rows. A year is checked across all
// its calendar months, including those with no matching transaction.
async function yearly(query = {}) {
  const [rows, context] = await Promise.all([
    Transaction.aggregate([{ $match: transactionFilter(query) }, { $group: {
      _id: { $substrBytes: ['$date', 0, 4] }, count: { $sum: 1 },
      inCents: { $sum: { $cond: [{ $gt: ['$flowCents', 0] }, '$flowCents', 0] } },
      outCents: { $sum: { $cond: [{ $lt: ['$flowCents', 0] }, '$flowCents', 0] } },
      netCents: { $sum: '$flowCents' }, firstDate: { $min: '$date' }, lastDate: { $max: '$date' }
    } }, { $sort: { _id: 1 } }]), coverageContext(query)
  ]);
  const received = context.bounds(query) || (rows.length ? { from: `${rows[0]._id}-01-01`, to: `${rows.at(-1)._id}-12-31` } : null);
  if (!received) return { years: [], dataAsOf: null, coverage: await assessCoverage(query) };
  const period = { from: query.from || `${received.from.slice(0, 4)}-01-01`, to: query.to || `${received.to.slice(0, 4)}-12-31` };
  const byYear = new Map(rows.map(({ _id, ...row }) => [_id, row]));
  const years = [...new Set(monthsBetween(period.from, period.to).map(month => month.slice(0, 4)))].map(year => {
    const from = period.from > `${year}-01-01` ? period.from : `${year}-01-01`;
    const to = period.to < `${year}-12-31` ? period.to : `${year}-12-31`;
    const coverage = context.at(from, to);
    const expectedMonths = monthsBetween(from, to);
    const incompleteMonths = expectedMonths.filter(month => !context.month(month, { from, to }).eligibleForMonthlyAverage);
    const stored = byYear.get(year);
    const totals = stored || { count: 0, inCents: coverage.complete ? 0 : null, outCents: coverage.complete ? 0 : null,
      netCents: coverage.complete ? 0 : null, firstDate: null, lastDate: null };
    return { year, ...totals, period: { from, to }, fullYear: from === `${year}-01-01` && to === `${year}-12-31`,
      complete: coverage.complete, expectedMonths, incompleteMonths, coverage, netMeasure: periodTotal(totals.netCents, { from, to }) };
  });
  const quality = context.at(period.from, period.to);
  return { years, period, dataAsOf: quality.dataAsOf, coverage: quality };
}

// A recurring amount is a median of observed monthly outflows. Its annualized
// value is an estimate, never an observed yearly total or an identified supplier.
function recurringCharges(rows, { minMonths = 3, tolerance = 0.15 } = {}) {
  const groups = new Map();
  for (const row of rows) {
    if (row.flowCents >= 0 || row.category === TRANSFERS) continue;
    const key = descriptionKey(row.description);
    const group = groups.get(key) || { description: row.description, months: new Map() };
    const month = row.date.slice(0, 7);
    group.months.set(month, (group.months.get(month) || 0) + row.flowCents);
    groups.set(key, group);
  }
  const recurring = [];
  for (const group of groups.values()) {
    const amounts = [...group.months.values()];
    if (amounts.length < minMonths) continue;
    const median = [...amounts].sort((a, b) => a - b)[Math.floor(amounts.length / 2)];
    if (!amounts.every(amount => Math.abs(amount - median) <= Math.abs(median) * tolerance)) continue;
    const included = [...group.months.keys()].sort();
    recurring.push({ description: group.description, months: included.length, firstMonth: included[0], lastMonth: included.at(-1),
      monthlyCents: median, yearlyCents: median * 12,
      monthlyMeasure: { kind: 'monthly_median', unit: 'cents/month', amountCents: median, months: included,
        monthCount: included.length, display: `${money(median)}/mois`, scopeText: `Médiane des sorties sur ${included.join(', ')}.` },
      yearlyMeasure: { kind: 'annualized_estimate', unit: 'cents/year', amountCents: median * 12,
        display: `${money(median * 12)}/an`, scopeText: 'Estimation annualisée : 12 fois la médiane mensuelle; ce montant n’est pas un total annuel observé.' } });
  }
  return recurring.sort((a, b) => a.monthlyCents - b.monthlyCents);
}

async function insights(query = {}) {
  const count = Math.min(Math.max(Number.parseInt(query.months, 10) || 12, 3), 60);
  const [context, latest, plan] = await Promise.all([
    coverageContext(query),
    Transaction.findOne(transactionFilter({ ledger: query.ledger, account: query.account })).sort({ date: -1 }).select('date').lean(),
    require('./financePlan').getPlan()
  ]);
  const excludedTags = [...new Set([...(query.tag ? [] : plan.excludeTags),
    ...String(query.excludeTag || '').split(',').map(tag => tag.trim()).filter(Boolean)])];
  let to = query.to || [context.lastDate, latest?.date].filter(Boolean).sort().at(-1);
  if (!to && query.from) to = lastDayOf(query.from.slice(0, 7));
  if (query.from && to < query.from && !query.to) to = lastDayOf(query.from.slice(0, 7));
  if (!to) return { period: null, recurring: [], categoryTrends: [], savings: [], largeExpenses: [], excludedTags,
    coverage: await assessCoverage(query), dataAsOf: null };
  const window = monthsBack(to.slice(0, 7), count).filter(month => !query.from || month >= query.from.slice(0, 7));
  const from = query.from && query.from > `${window[0]}-01` ? query.from : `${window[0]}-01`;
  const period = { from, to };
  const filter = transactionFilter({ ...query, from, to,
    excludeCategory: query.category ? undefined : query.excludeCategory || TRANSFERS,
    excludeTag: excludedTags.join(',') || undefined });
  const rows = await Transaction.find(filter).select('date description flowCents category tags').lean();
  const perMonth = new Map(window.map(month => [month, { inCents: 0, outCents: 0, count: 0 }]));
  const perCategory = new Map();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    const bucket = perMonth.get(month);
    if (bucket) { bucket[row.flowCents > 0 ? 'inCents' : 'outCents'] += row.flowCents; bucket.count += 1; }
    if (row.flowCents < 0) {
      const category = row.category || 'Non classé';
      const values = perCategory.get(category) || new Map();
      values.set(month, (values.get(month) || 0) + row.flowCents);
      perCategory.set(category, values);
    }
  }
  const savings = window.map(month => {
    const evidence = context.month(month, period);
    const bucket = perMonth.get(month);
    const available = bucket.count > 0 || evidence.complete;
    const inCents = available ? bucket.inCents : null;
    const outCents = available ? bucket.outCents : null;
    const complete = evidence.eligibleForMonthlyAverage;
    return { month, inCents, outCents, netCents: available ? inCents + outCents : null, complete, coverage: evidence,
      savingsRatePercent: complete && inCents > 0 ? Math.round(((inCents + outCents) / inCents) * 1000) / 10 : null };
  });
  const eligible = new Set(savings.filter(item => item.complete).map(item => item.month));
  const recent = window.slice(-3).filter(month => eligible.has(month));
  const before = window.slice(0, -3).filter(month => eligible.has(month));
  const categoryTrends = [...perCategory].map(([category, values]) => {
    const recentMeasure = monthlyAverage(recent.reduce((sum, month) => sum + (values.get(month) || 0), 0), recent);
    const previousMeasure = monthlyAverage(before.reduce((sum, month) => sum + (values.get(month) || 0), 0), before);
    const changeMeasure = monthlyChange(recentMeasure, previousMeasure);
    return { category, recentMonthlyCents: recentMeasure.amountCents, previousMonthlyCents: previousMeasure.amountCents,
      changeCents: changeMeasure.amountCents, changeMonthlyCents: changeMeasure.amountCents,
      changePercent: previousMeasure.amountCents && changeMeasure.amountCents !== null
        ? Math.round((changeMeasure.amountCents / previousMeasure.amountCents) * 1000) / 10 : null,
      recentMeasure, previousMeasure, changeMeasure };
  }).sort((a, b) => (a.changeCents || 0) - (b.changeCents || 0)).slice(0, 12);
  const since = `${window.slice(-3)[0]}-01`;
  const largeExpenses = rows.filter(row => row.flowCents < 0 && row.date >= since)
    .sort((a, b) => a.flowCents - b.flowCents).slice(0, 10)
    .map(({ date, description, flowCents, category }) => ({ date, description, amountCents: flowCents, category: category || null }));
  const quality = context.at(from, to);
  return { period: { ...period, months: window.length }, dataAsOf: quality.dataAsOf, excludedTags,
    coverage: quality, incompleteMonths: savings.filter(item => !item.complete).map(item => item.month), savings,
    recurring: recurringCharges(rows.filter(row => eligible.has(row.date.slice(0, 7)))), categoryTrends, largeExpenses,
    trendWindow: { recentCalendarMonths: window.slice(-3), recentIncludedMonths: recent, previousIncludedMonths: before },
    interpretation: 'Les libellés de canal bancaire ne prouvent pas l’identité du bénéficiaire ni la nature de la dépense.' };
}

module.exports = { insights, yearly, recurringCharges, monthsBack };
require('./financeAccess').guard(module.exports, ['insights', 'yearly']);
