'use strict';

// Deterministic finance alerts. Rules decide whether to alert; the persona only
// phrases the message. Each fact gets a stable key. A pending alert is reported
// once (acknowledgement). A standing condition (stale data, deadlines, low balance)
// stays listed while it holds, even after it was reported.

const { createHash } = require('crypto');
const FinanceAlert = require('../../../models/FinanceAlert');
const FinanceStatement = require('../../../models/FinanceStatement');
const FinanceTransaction = require('../../../models/FinanceTransaction');
const { balances } = require('./financeQueryService');
const { insights } = require('./financeInsights');
const { getPlan } = require('./financePlan');
const { ledgerFilter } = require('./ledgers');

const PERSO = ledgerFilter('perso');

const TRANSFERS = 'Virements internes';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEADLINE_WINDOW_DAYS = 7;
const STANDING = ['stale_data', 'low_balance', 'deadline_upcoming', 'deadline_due', 'deadline_overdue'];

function cents(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function settings(env = process.env) {
  return {
    largeExpenseCents: cents(env.FINANCE_ALERT_LARGE_EXPENSE_CENTS, 100000),
    categorySpikeCents: cents(env.FINANCE_ALERT_CATEGORY_SPIKE_CENTS, 10000),
    minBalanceCents: cents(env.FINANCE_ALERT_MIN_BALANCE_CENTS, 0),
    minBalanceAccounts: String(env.FINANCE_ALERT_MIN_BALANCE_ACCOUNTS || 'EOP').split(',').map((s) => s.trim()).filter(Boolean),
    staleDays: cents(env.FINANCE_ALERT_STALE_DAYS, 45)
  };
}

// Deadlines from the plan (watch and open items with a dueDate). J-7 to J-2 is
// "upcoming", J-1 and J (day included) is "due", a past date is "overdue".
// The day is part of the key, so an item still open is reported again each day.
function deadlineAlerts(items, today) {
  const found = [];
  for (const item of items) {
    if (!item.dueDate || !item.label) continue;
    const daysUntil = Math.round((Date.parse(`${item.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
    if (daysUntil > DEADLINE_WINDOW_DAYS) continue;
    const id = createHash('sha1').update(`${item.section}|${item.label}|${item.dueDate}`).digest('hex').slice(0, 12);
    const facts = { section: item.section, label: item.label, dueDate: item.dueDate, daysUntil, recurrence: item.recurrence || null };
    const key = `deadline:${id}:${today}`;
    if (daysUntil < 0) {
      found.push({ key, kind: 'deadline_overdue', severity: 'critical', title: `Overdue: ${item.label} (due ${item.dueDate})`, facts });
    } else if (daysUntil <= 1) {
      found.push({ key, kind: 'deadline_due', severity: 'warning', title: `Due ${daysUntil === 0 ? 'today' : 'tomorrow'}: ${item.label}`, facts });
    } else {
      found.push({ key, kind: 'deadline_upcoming', severity: 'info', title: `Due in ${daysUntil} days: ${item.label} (${item.dueDate})`, facts });
    }
  }
  return found;
}

// Computes the alerts that hold right now, without storing them.
async function evaluate({ now = new Date(), env = process.env } = {}) {
  const config = settings(env);
  const found = [];

  const review = await FinanceStatement.find({ status: 'needs_review' }).select('fileName problems').lean();
  for (const statement of review) {
    found.push({ key: `review:${statement.fileName}`, kind: 'statement_needs_review', severity: 'warning',
      title: `Statement to review: ${statement.fileName}`, facts: { fileName: statement.fileName, problems: statement.problems } });
  }

  // Staleness is judged per account series: the latest reconciled period end of each account.
  const series = await FinanceStatement.aggregate([
    { $match: { status: 'reconciled', ...PERSO } },
    { $unwind: '$accounts' },
    { $group: { _id: '$accounts.accountKey', code: { $first: '$accounts.code' }, issuer: { $first: '$issuer' },
      lastPeriodEnd: { $max: '$periodEnd' } } }
  ]);
  for (const account of series) {
    if (!account.lastPeriodEnd) continue;
    const ageDays = Math.floor((now - new Date(`${account.lastPeriodEnd}T00:00:00Z`)) / DAY_MS);
    if (ageDays > config.staleDays) {
      found.push({ key: `stale:${account._id}`, kind: 'stale_data', severity: 'info',
        title: `No ${account.code} statement since ${account.lastPeriodEnd} (${ageDays} days)`,
        facts: { accountKey: account._id, account: account.code, issuer: account.issuer,
          lastPeriodEnd: account.lastPeriodEnd, ageDays } });
    }
  }

  const latest = await FinanceStatement.findOne({ status: 'reconciled', ...PERSO }).sort({ periodEnd: -1 }).select('periodEnd').lean();

  if (config.minBalanceCents) {
    for (const account of (await balances({ ledger: 'perso' })).accounts) {
      if (config.minBalanceAccounts.includes(account.code) && account.balanceCents < config.minBalanceCents) {
        found.push({ key: `low:${account.accountKey}:${account.asOf}`, kind: 'low_balance', severity: 'critical',
          title: `${account.code} balance below the cushion on ${account.asOf}`,
          facts: { account: account.code, asOf: account.asOf, balanceCents: account.balanceCents, minimumCents: config.minBalanceCents } });
      }
    }
  }

  if (latest?.periodEnd) {
    const since = new Date(new Date(`${latest.periodEnd}T00:00:00Z`).getTime() - 45 * DAY_MS).toISOString().slice(0, 10);
    const large = await FinanceTransaction.find({ ...PERSO, date: { $gte: since }, flowCents: { $lte: -config.largeExpenseCents },
      category: { $ne: TRANSFERS } }).sort({ flowCents: 1 }).limit(20).select('date description flowCents accountKey category').lean();
    for (const row of large) {
      found.push({ key: `large:${row.accountKey}:${row.date}:${row.description}:${-row.flowCents}`, kind: 'large_expense',
        severity: 'info', title: `Large expense on ${row.date}: ${row.description}`,
        facts: { date: row.date, description: row.description, amountCents: row.flowCents, category: row.category || null } });
    }

    const analysis = await insights({ months: 12 });
    const lastMonths = analysis.savings.slice(-4).map((s) => s.month);
    for (const charge of analysis.recurring) {
      if (lastMonths.includes(charge.firstMonth)) {
        found.push({ key: `recurring:${charge.description}:${charge.firstMonth}`, kind: 'new_recurring_charge', severity: 'warning',
          title: `New recurring charge: ${charge.description}`,
          facts: { description: charge.description, since: charge.firstMonth, monthlyCents: charge.monthlyCents, yearlyCents: charge.yearlyCents } });
      }
    }
    const period = analysis.period?.to?.slice(0, 7);
    for (const trend of analysis.categoryTrends) {
      if (trend.category !== 'Non classé' && -trend.changeCents >= config.categorySpikeCents
        && trend.previousMonthlyCents && trend.recentMonthlyCents < trend.previousMonthlyCents * 1.5) {
        found.push({ key: `spike:${trend.category}:${period}`, kind: 'category_spike', severity: 'warning',
          title: `Spending increase: ${trend.category}`, facts: trend });
      }
    }
  }

  const plan = await getPlan();
  const items = [
    ...plan.watch.map((item) => ({ ...item, section: 'watch', label: item.what })),
    ...plan.openItems.map((item) => ({ ...item, section: 'openItems', label: item.title }))
  ];
  found.push(...deadlineAlerts(items, now.toISOString().slice(0, 10)));
  return found;
}

// Stores the alerts that hold now. Known keys are refreshed, acknowledgement is kept.
async function store(found) {
  for (const alert of found) {
    await FinanceAlert.updateOne({ key: alert.key }, { $set: alert }, { upsert: true });
  }
}

// Lists alerts. Without `current`: pending ones (not acknowledged). With `current`
// (the keys holding now): pending ones plus standing conditions that still hold,
// acknowledged or not, so a stale account stays visible until its data comes in.
async function list({ includeAcknowledged = false, current = null } = {}) {
  let filter = {};
  if (!includeAcknowledged) {
    filter = current
      ? { $or: [{ acknowledgedAt: null, kind: { $nin: STANDING } }, { kind: { $in: STANDING }, key: { $in: current } }] }
      : { acknowledgedAt: null };
  }
  const rows = await FinanceAlert.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  return { alerts: rows.map(({ _id, key, kind, severity, title, facts, createdAt, acknowledgedAt }) => ({
    id: String(_id), key, kind, severity, title, facts, createdAt, acknowledgedAt })) };
}

// Stores the current alerts and returns those listed now.
async function refresh(options = {}) {
  const found = await evaluate(options);
  await store(found);
  return list({ current: found.map((alert) => alert.key) });
}

// Returns the pending alerts and marks them reported, for a delivery job.
async function report(options = {}) {
  const found = await evaluate(options);
  await store(found);
  const { alerts } = await list({ current: found.map((alert) => alert.key) });
  const pending = alerts.filter((alert) => !alert.acknowledgedAt);
  await acknowledge(pending.map((alert) => alert.id));
  return { alerts: pending };
}

async function acknowledge(ids = []) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter((id) => /^[a-f0-9]{24}$/.test(id)).slice(0, 100);
  const result = await FinanceAlert.updateMany({ _id: { $in: list }, acknowledgedAt: null }, { $set: { acknowledgedAt: new Date() } });
  return { acknowledged: result.modifiedCount };
}

module.exports = { evaluate, refresh, report, list, acknowledge, settings, deadlineAlerts };
