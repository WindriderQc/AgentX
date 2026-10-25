'use strict';

// Savings goals and the monthly review. Progress comes from a ledger account, a plan asset
// or the sum of a tag. The pace is the average of the last three complete months (a month
// without a payroll statement is left out). Core computes every figure in integer cents;
// the model only phrases them.

const FinanceTransaction = require('../../../models/FinanceTransaction');
const { balances } = require('./financeQueryService');
const { getPlan, situation } = require('./financePlan');
const { payrollCoverage } = require('./financeCompleteness');
const { ledgerFilter } = require('./ledgers');

const WINDOW = 3;
const LOOKBACK = 36;

const fold = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const compact = (value) => fold(value).replace(/\s+/g, '');
const shiftMonth = (month, count) => {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + count, 1)).toISOString().slice(0, 7);
};
const lastDay = (month) => {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
};
// Whole months from the month of `from` to the month of `to`, at least one.
const monthsUntil = (from, to) => {
  const [fy, fm] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  return Math.max(1, (ty - fy) * 12 + (tm - fm));
};

// The last three complete months before `now`, oldest first.
function completeWindow(payroll, now) {
  const current = now.toISOString().slice(0, 7);
  const months = [];
  for (let back = 1; back <= LOOKBACK && months.length < WINDOW; back += 1) {
    const month = shiftMonth(current, -back);
    if (payroll.isComplete(month)) months.unshift(month);
  }
  return months;
}

// Sums the rows of the window: `field` is the cents of the account (amountCents) or of the owner's wallet (flowCents).
async function windowTotal(months, match, field) {
  if (!months.length) return null;
  const rows = await FinanceTransaction.find({ ...ledgerFilter('perso'), ...match,
    date: { $gte: `${months[0]}-01`, $lte: lastDay(months.at(-1)) } }).select(field).lean();
  return rows.reduce((sum, row) => sum + (row[field] || 0), 0);
}

async function progressOf(goal, { accounts, plan, months, now }) {
  const { source } = goal;
  let progressCents = 0;
  let paceMonthlyCents = null;
  if (source.kind === 'account') {
    const matched = accounts.filter((a) => !a.liability && (compact(a.code) === compact(source.ref) || fold(a.issuer).includes(fold(source.ref))));
    progressCents = matched.reduce((sum, a) => sum + a.balanceCents, 0);
    const total = await windowTotal(months, { accountKey: { $in: matched.map((a) => a.accountKey) } }, 'amountCents');
    if (total !== null && matched.length) paceMonthlyCents = Math.round(total / months.length);
  } else if (source.kind === 'asset') {
    progressCents = plan.assets.filter((a) => fold(a.name).includes(fold(source.ref))).reduce((sum, a) => sum + a.valueCents, 0);
  } else {
    const tag = fold(source.ref).trim();
    // Money put aside is money leaving the wallet: a tagged outflow counts as progress.
    const rows = await FinanceTransaction.find({ ...ledgerFilter('perso'), tags: tag }).select('flowCents').lean();
    progressCents = -rows.reduce((sum, row) => sum + (row.flowCents || 0), 0);
    const total = await windowTotal(months, { tags: tag }, 'flowCents');
    if (total !== null) paceMonthlyCents = Math.round(-total / months.length) || 0;
  }
  const remainingCents = Math.max(goal.targetCents - progressCents, 0);
  const percent = goal.targetCents > 0 ? Math.min(100, Math.round((progressCents / goal.targetCents) * 100)) : 0;
  return { name: goal.name, priority: goal.priority, source, targetCents: goal.targetCents, targetDate: goal.targetDate,
    progressCents, remainingCents, percent, paceMonthlyCents, ...projection(remainingCents, paceMonthlyCents, goal.targetDate, now) };
}

// When the target is reached at the current pace, and the monthly amount needed for the target date.
function projection(remainingCents, pace, targetDate, now = new Date()) {
  if (remainingCents === 0) return { status: 'reached', projectedMonth: null, requiredMonthlyCents: 0 };
  const required = targetDate ? Math.ceil(remainingCents / monthsUntil(now.toISOString().slice(0, 10), targetDate)) : null;
  if (!pace || pace <= 0) return { status: 'no_pace', projectedMonth: null, requiredMonthlyCents: required };
  const projectedMonth = shiftMonth(now.toISOString().slice(0, 7), Math.ceil(remainingCents / pace));
  const onTrack = targetDate ? projectedMonth <= targetDate.slice(0, 7) : true;
  return { status: onTrack ? 'on_track' : 'behind', projectedMonth, requiredMonthlyCents: required };
}

async function goals({ now = new Date() } = {}) {
  const [plan, { accounts }, payroll] = await Promise.all([getPlan(), balances({ ledger: 'perso' }), payrollCoverage({ ledger: 'perso' })]);
  const months = completeWindow(payroll, now);
  const list = [];
  for (const goal of plan.goals) list.push(await progressOf(goal, { accounts, plan, months, now }));
  return { asOf: payroll.asOf, windowMonths: months, goals: list };
}

// The month just closed, planned against actual by category, and the three largest overspends.
async function monthlyReview({ now = new Date() } = {}) {
  const s = await situation({ months: 1 });
  const month = s.window.averageMonths.at(-1) || null;
  const budget = s.budget.map((line) => ({ label: line.label, category: line.category, tag: line.tag,
    plannedCents: line.monthlyCents, actualCents: line.actualMonthlyCents, gapCents: line.gapCents }));
  const topGaps = budget.filter((line) => line.category !== 'Revenus' && line.gapCents > 0)
    .sort((a, b) => b.gapCents - a.gapCents).slice(0, 3);
  return { month, incompleteMonths: s.window.incompleteMonths, dataAsOf: s.window.dataAsOf, budget,
    budgetTotals: s.budgetTotals, topGaps, goals: (await goals({ now })).goals,
    note: month ? null : 'No complete month yet: the last month has no payroll statement covering it.' };
}

module.exports = { goals, monthlyReview, projection, completeWindow, monthsUntil };

require('./financeAccess').guard(module.exports, ['goals', 'monthlyReview']);
