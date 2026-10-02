'use strict';

// Deterministic insights for the finance persona's advice: yearly totals,
// recurring charges, category trends, savings rate and large recent expenses.
// Every number is computed here in integer cents; the persona only explains.

const FinanceTransaction = require('../../../models/FinanceTransaction');
const { transactionFilter } = require('./financeQueryService');
const { descriptionKey } = require('./financeCategories');

const TRANSFERS = 'Virements internes';

function monthsBack(lastMonth, count) {
  const [year, month] = lastMonth.split('-').map(Number);
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(year, month - 1 - i, 1));
    out.push(date.toISOString().slice(0, 7));
  }
  return out;
}

// In/out/net per calendar year, optionally for one tag, category or search.
async function yearly(query = {}) {
  const filter = transactionFilter(query);
  const rows = await FinanceTransaction.aggregate([
    { $match: filter },
    { $group: {
      _id: { $substrBytes: ['$date', 0, 4] },
      count: { $sum: 1 },
      inCents: { $sum: { $cond: [{ $gt: ['$flowCents', 0] }, '$flowCents', 0] } },
      outCents: { $sum: { $cond: [{ $lt: ['$flowCents', 0] }, '$flowCents', 0] } },
      netCents: { $sum: '$flowCents' },
      firstDate: { $min: '$date' },
      lastDate: { $max: '$date' }
    } },
    { $sort: { _id: 1 } }
  ]);
  return { years: rows.map(({ _id, ...rest }) => ({ year: _id, ...rest })) };
}

// Same description in at least `minMonths` distinct months with a stable
// amount: likely a subscription or fixed charge.
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
    const sorted = [...amounts].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (!amounts.every((amount) => Math.abs(amount - median) <= Math.abs(median) * tolerance)) continue;
    const months = [...group.months.keys()].sort();
    recurring.push({
      description: group.description, months: amounts.length, firstMonth: months[0], lastMonth: months.at(-1),
      monthlyCents: median, yearlyCents: median * 12
    });
  }
  return recurring.sort((a, b) => a.monthlyCents - b.monthlyCents);
}

/**
 * Insights over the last `months` months of data (default 12), ending at the
 * most recent transaction. Internal transfers are excluded throughout.
 */
async function insights(query = {}) {
  const months = Math.min(Math.max(Number.parseInt(query.months, 10) || 12, 3), 60);
  const latest = await FinanceTransaction.findOne(transactionFilter(query)).sort({ date: -1 }).select('date').lean();
  if (!latest) return { period: null, recurring: [], categoryTrends: [], savings: [], largeExpenses: [] };
  const window = monthsBack(latest.date.slice(0, 7), months);
  const { excludeTags } = await require('./financePlan').getPlan();
  const filter = { ...transactionFilter({ ...query, excludeCategory: query.category ? undefined : TRANSFERS,
    excludeTag: query.tag ? undefined : excludeTags.join(',') }),
    date: { $gte: `${window[0]}-01`, $lte: latest.date } };
  const rows = await FinanceTransaction.find(filter).select('date description flowCents category tags').lean();

  const perMonth = new Map(window.map((month) => [month, { inCents: 0, outCents: 0 }]));
  const perCategory = new Map();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    const bucket = perMonth.get(month);
    if (bucket) bucket[row.flowCents > 0 ? 'inCents' : 'outCents'] += row.flowCents;
    if (row.flowCents < 0) {
      const name = row.category || 'Non classé';
      const series = perCategory.get(name) || new Map();
      series.set(month, (series.get(month) || 0) + row.flowCents);
      perCategory.set(name, series);
    }
  }

  const savings = window.map((month) => {
    const { inCents, outCents } = perMonth.get(month);
    return { month, inCents, outCents, netCents: inCents + outCents,
      savingsRatePercent: inCents > 0 ? Math.round(((inCents + outCents) / inCents) * 1000) / 10 : null };
  });

  // Last 3 months vs the months before, per category (monthly averages).
  const recent = window.slice(-3);
  const before = window.slice(0, -3);
  const categoryTrends = [];
  for (const [category, series] of perCategory) {
    const recentAvg = Math.round(recent.reduce((sum, m) => sum + (series.get(m) || 0), 0) / recent.length);
    const beforeAvg = before.length ? Math.round(before.reduce((sum, m) => sum + (series.get(m) || 0), 0) / before.length) : 0;
    const change = recentAvg - beforeAvg;
    categoryTrends.push({ category, recentMonthlyCents: recentAvg, previousMonthlyCents: beforeAvg, changeCents: change,
      changePercent: beforeAvg ? Math.round((change / beforeAvg) * 1000) / 10 : null });
  }
  categoryTrends.sort((a, b) => a.changeCents - b.changeCents);

  const since = `${recent[0]}-01`;
  const largeExpenses = rows.filter((row) => row.flowCents < 0 && row.date >= since)
    .sort((a, b) => a.flowCents - b.flowCents).slice(0, 10)
    .map(({ date, description, flowCents, category }) => ({ date, description, amountCents: flowCents, category: category || null }));

  return {
    period: { from: `${window[0]}-01`, to: latest.date, months },
    savings,
    recurring: recurringCharges(rows),
    categoryTrends: categoryTrends.slice(0, 12),
    largeExpenses
  };
}

module.exports = { insights, yearly, recurringCharges, monthsBack };
