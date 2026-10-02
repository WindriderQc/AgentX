'use strict';

// Deterministic simulations over the plan and the ledger, in integer cents:
// debt trajectory under payment scenarios, 12-month cash-flow forecast, the
// history of statement balances and spending per category per month.

const FinanceStatement = require('../../../models/FinanceStatement');
const FinanceTransaction = require('../../../models/FinanceTransaction');
const { situation } = require('./financePlan');
const { ledgerFilter } = require('./ledgers');

const TRANSFERS = 'Virements internes';

function int(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function addMonths(yyyyMm, count) {
  const [year, month] = yyyyMm.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + count, 1)).toISOString().slice(0, 7);
}

// Amortizes the amortizing debts (rate and payment known) month by month.
// Extra money (monthly extra, a lump sum in a given month, an annual bonus in
// December) goes to the highest rate first (avalanche).
function runTrajectory(debts, { months, extraMonthlyCents, lumpSumCents, lumpSumMonth, annualBonusCents, start }) {
  const state = debts.map((debt) => ({ name: debt.name, balance: debt.balanceCents, rateBp: debt.rateBp,
    payment: debt.paymentCents, interest: 0, paidOffMonth: debt.balanceCents <= 0 ? start : null }));
  const points = [{ month: start, totalCents: state.reduce((sum, d) => sum + d.balance, 0) }];
  for (let i = 1; i <= months; i += 1) {
    const month = addMonths(start, i);
    let extra = extraMonthlyCents + (i === lumpSumMonth ? lumpSumCents : 0) + (month.endsWith('-12') ? annualBonusCents : 0);
    for (const debt of state) {
      if (debt.balance <= 0) continue;
      const interest = Math.round((debt.balance * debt.rateBp) / 10000 / 12);
      debt.interest += interest;
      debt.balance += interest;
      const paid = Math.min(debt.payment, debt.balance);
      debt.balance -= paid;
      extra += debt.payment - paid; // a debt paid off frees its payment for the others
    }
    for (const debt of [...state].sort((a, b) => b.rateBp - a.rateBp)) {
      if (extra <= 0) break;
      const paid = Math.min(extra, debt.balance);
      debt.balance -= paid;
      extra -= paid;
    }
    for (const debt of state) if (debt.balance <= 0 && !debt.paidOffMonth) debt.paidOffMonth = month;
    points.push({ month, totalCents: state.reduce((sum, d) => sum + Math.max(d.balance, 0), 0) });
  }
  return {
    points,
    interestCents: state.reduce((sum, d) => sum + d.interest, 0),
    endCents: points.at(-1).totalCents,
    debts: state.map((d) => ({ name: d.name, paidOffMonth: d.paidOffMonth, interestCents: d.interest, endCents: Math.max(d.balance, 0) }))
  };
}

async function debtTrajectory(query = {}) {
  const s = await situation();
  const months = int(query.months, { min: 12, max: 360, fallback: 72 });
  const start = (s.window?.to || new Date().toISOString()).slice(0, 7);
  const amortizing = s.debts.filter((d) => (d.currentCents || 0) > 0 && d.rateBp != null && (d.paymentCents || 0) > 0)
    .map((d) => ({ name: d.name, balanceCents: d.currentCents, rateBp: d.rateBp, paymentCents: d.paymentCents }));
  const scenario = {
    extraMonthlyCents: int(query.extraMonthlyCents), lumpSumCents: int(query.lumpSumCents),
    lumpSumMonth: int(query.lumpSumMonth, { min: 1, max: months, fallback: 1 }), annualBonusCents: int(query.annualBonusCents)
  };
  const base = runTrajectory(amortizing, { months, start, extraMonthlyCents: 0, lumpSumCents: 0, lumpSumMonth: 0, annualBonusCents: 0 });
  const plan = runTrajectory(amortizing, { months, start, ...scenario });
  return {
    start, months, scenario, debts: amortizing,
    excluded: s.debts.filter((d) => !amortizing.some((a) => a.name === d.name)).map((d) => d.name),
    baseline: base, withScenario: plan, interestSavedCents: base.interestCents - plan.interestCents
  };
}

// 12-month cash forecast from the current cash: monthly income and spending
// from the budget (or overrides), provisions spread monthly, one-off events.
async function forecast(query = {}) {
  const s = await situation({ months: query.actualMonths || 3 });
  const months = int(query.months, { min: 3, max: 36, fallback: 12 });
  const start = (s.window?.to || new Date().toISOString()).slice(0, 7);
  const budgetIncome = s.budget.filter((b) => b.category === 'Revenus').reduce((sum, b) => sum + b.monthlyCents, 0);
  const budgetSpend = s.budget.filter((b) => b.category !== 'Revenus').reduce((sum, b) => sum + b.monthlyCents, 0);
  const incomeCents = query.incomeCents != null ? int(query.incomeCents) : budgetIncome;
  const spendCents = query.spendCents != null ? int(query.spendCents) : budgetSpend;
  const provisionsCents = query.includeProvisions === 'false' ? 0 : s.provisionsMonthlyCents;
  const events = (Array.isArray(query.events) ? query.events : []).slice(0, 24).map((event) => ({
    month: /^\d{4}-\d{2}$/.test(String(event?.month)) ? event.month : null,
    label: String(event?.label || '').slice(0, 80), amountCents: int(event?.amountCents, { min: -100000000, max: 100000000 })
  })).filter((event) => event.month);
  const cushionCents = int(query.cushionCents, { fallback: 0 });
  let cash = s.cash?.balanceCents || 0;
  const rows = [];
  for (let i = 1; i <= months; i += 1) {
    const month = addMonths(start, i);
    const oneOff = events.filter((event) => event.month === month);
    const eventsCents = oneOff.reduce((sum, event) => sum + event.amountCents, 0);
    const opening = cash;
    cash = opening + incomeCents - spendCents - provisionsCents + eventsCents;
    rows.push({ month, openingCents: opening, incomeCents, spendCents, provisionsCents, eventsCents,
      events: oneOff.map((event) => event.label), closingCents: cash, belowCushion: cushionCents > 0 && cash < cushionCents });
  }
  return {
    start, startCashCents: s.cash?.balanceCents || 0, startCashAsOf: s.cash?.asOf || null,
    assumptions: { incomeCents, spendCents, provisionsCents, cushionCents, budgetIncome, budgetSpend,
      actualIncomeCents: s.monthly.inCents, actualSpendCents: -s.monthly.outCents },
    rows, endCashCents: cash, lowestCents: Math.min(...rows.map((row) => row.closingCents))
  };
}

// Closing balance of every account at each statement, for trajectories.
async function balanceHistory({ ledger } = {}) {
  const statements = await FinanceStatement.find({ status: 'reconciled', ...ledgerFilter(ledger) }).sort({ periodEnd: 1 })
    .select('issuer periodEnd accounts').lean();
  const series = new Map();
  for (const statement of statements) {
    for (const account of statement.accounts) {
      const entry = series.get(account.accountKey) || { accountKey: account.accountKey, code: account.code, issuer: statement.issuer, points: [] };
      entry.points.push({ date: statement.periodEnd, balanceCents: account.closingCents });
      series.set(account.accountKey, entry);
    }
  }
  return { series: [...series.values()].filter((s) => s.points.some((p) => p.balanceCents !== 0)) };
}

// Spending per month per category (internal transfers excluded).
async function categoryMonths(query = {}) {
  const months = int(query.months, { min: 3, max: 60, fallback: 12 });
  const scope = ledgerFilter(query.ledger);
  const latest = await FinanceTransaction.findOne(scope).sort({ date: -1 }).select('date').lean();
  if (!latest) return { months: [], categories: [] };
  const end = latest.date.slice(0, 7);
  const first = addMonths(end, -(months - 1));
  const rows = await FinanceTransaction.aggregate([
    { $match: { ...scope, date: { $gte: `${first}-01`, $lte: latest.date }, flowCents: { $lt: 0 }, category: { $ne: TRANSFERS } } },
    { $group: { _id: { month: { $substrBytes: ['$date', 0, 7] }, category: { $ifNull: ['$category', 'Non classé'] } },
      outCents: { $sum: '$flowCents' } } }
  ]);
  const list = Array.from({ length: months }, (_, i) => addMonths(first, i));
  const totals = new Map();
  for (const row of rows) totals.set(row._id.category, (totals.get(row._id.category) || 0) - row.outCents);
  const categories = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const cell = new Map(rows.map((row) => [`${row._id.month}|${row._id.category}`, -row.outCents]));
  return {
    months: list,
    categories: categories.map((name) => ({ category: name, totalCents: totals.get(name),
      perMonthCents: list.map((month) => cell.get(`${month}|${name}`) || 0) }))
  };
}

module.exports = { debtTrajectory, forecast, balanceHistory, categoryMonths, runTrajectory, addMonths };
