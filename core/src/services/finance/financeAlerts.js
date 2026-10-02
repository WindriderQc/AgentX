'use strict';

// Deterministic finance alerts. Rules decide whether to alert; the persona only
// phrases the message. Each fact gets a stable key, so it is raised once and
// stays quiet after it is acknowledged.

const FinanceAlert = require('../../../models/FinanceAlert');
const FinanceStatement = require('../../../models/FinanceStatement');
const FinanceTransaction = require('../../../models/FinanceTransaction');
const { balances } = require('./financeQueryService');
const { insights } = require('./financeInsights');
const { ledgerFilter } = require('./ledgers');

const PERSO = ledgerFilter('perso');

const TRANSFERS = 'Virements internes';
const DAY_MS = 24 * 60 * 60 * 1000;

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

// Computes the alerts that hold right now, without storing them.
async function evaluate({ now = new Date(), env = process.env } = {}) {
  const config = settings(env);
  const found = [];

  const review = await FinanceStatement.find({ status: 'needs_review' }).select('fileName problems').lean();
  for (const statement of review) {
    found.push({ key: `review:${statement.fileName}`, kind: 'statement_needs_review', severity: 'warning',
      title: `Relevé à vérifier : ${statement.fileName}`, facts: { fileName: statement.fileName, problems: statement.problems } });
  }

  const latest = await FinanceStatement.findOne({ status: 'reconciled', ...PERSO }).sort({ periodEnd: -1 }).select('periodEnd').lean();
  if (latest?.periodEnd) {
    const ageDays = Math.floor((now - new Date(`${latest.periodEnd}T00:00:00Z`)) / DAY_MS);
    if (ageDays > config.staleDays) {
      found.push({ key: `stale:${latest.periodEnd}`, kind: 'stale_data', severity: 'info',
        title: `Aucun relevé depuis le ${latest.periodEnd} (${ageDays} jours)`, facts: { lastPeriodEnd: latest.periodEnd, ageDays } });
    }
  }

  if (config.minBalanceCents) {
    for (const account of (await balances({ ledger: 'perso' })).accounts) {
      if (config.minBalanceAccounts.includes(account.code) && account.balanceCents < config.minBalanceCents) {
        found.push({ key: `low:${account.accountKey}:${account.asOf}`, kind: 'low_balance', severity: 'critical',
          title: `Solde ${account.code} sous le coussin au ${account.asOf}`,
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
        severity: 'info', title: `Grosse dépense le ${row.date} : ${row.description}`,
        facts: { date: row.date, description: row.description, amountCents: row.flowCents, category: row.category || null } });
    }

    const analysis = await insights({ months: 12 });
    const lastMonths = analysis.savings.slice(-4).map((s) => s.month);
    for (const charge of analysis.recurring) {
      if (lastMonths.includes(charge.firstMonth)) {
        found.push({ key: `recurring:${charge.description}:${charge.firstMonth}`, kind: 'new_recurring_charge', severity: 'warning',
          title: `Nouvelle charge récurrente : ${charge.description}`,
          facts: { description: charge.description, since: charge.firstMonth, monthlyCents: charge.monthlyCents, yearlyCents: charge.yearlyCents } });
      }
    }
    const period = analysis.period?.to?.slice(0, 7);
    for (const trend of analysis.categoryTrends) {
      if (trend.category !== 'Non classé' && -trend.changeCents >= config.categorySpikeCents
        && trend.previousMonthlyCents && trend.recentMonthlyCents < trend.previousMonthlyCents * 1.5) {
        found.push({ key: `spike:${trend.category}:${period}`, kind: 'category_spike', severity: 'warning',
          title: `Hausse des dépenses : ${trend.category}`, facts: trend });
      }
    }
  }
  return found;
}

// Stores newly true alerts and returns those not yet acknowledged.
async function refresh(options = {}) {
  const found = await evaluate(options);
  for (const alert of found) {
    await FinanceAlert.updateOne({ key: alert.key }, { $setOnInsert: alert }, { upsert: true });
  }
  return list();
}

async function list({ includeAcknowledged = false } = {}) {
  const filter = includeAcknowledged ? {} : { acknowledgedAt: null };
  const rows = await FinanceAlert.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  return { alerts: rows.map(({ _id, key, kind, severity, title, facts, createdAt, acknowledgedAt }) => ({
    id: String(_id), key, kind, severity, title, facts, createdAt, acknowledgedAt })) };
}

// Returns the pending alerts and marks them reported, for a delivery job.
async function report(options = {}) {
  const { alerts } = await refresh(options);
  await acknowledge(alerts.map((alert) => alert.id));
  return { alerts };
}

async function acknowledge(ids = []) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter((id) => /^[a-f0-9]{24}$/.test(id)).slice(0, 100);
  const result = await FinanceAlert.updateMany({ _id: { $in: list }, acknowledgedAt: null }, { $set: { acknowledgedAt: new Date() } });
  return { acknowledged: result.modifiedCount };
}

module.exports = { evaluate, refresh, report, list, acknowledge, settings };
