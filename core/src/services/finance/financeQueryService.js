'use strict';

// Read-only questions over the finance ledger. Every total is computed here,
// in integer cents, so a model or UI only phrases the answer.

const FinanceStatement = require('../../../models/FinanceStatement');
const FinanceTransaction = require('../../../models/FinanceTransaction');
const { ledgerFilter } = require('./ledgers');
const { coverageContext, assessCoverage, monthsBetween: expectedMonths, lastDayOf, validDate } = require('./financeCompleteness');
const { monthlyAverage, periodTotal } = require('./financeMeasures');
const { confirmedFor, transactionKey } = require('./financeDocumentLinks');
const { totalsStage, monthlyPipeline } = require('./financeMoneyTotals');

const MAX_ROWS = 500;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

class FinanceQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FinanceQueryError';
    this.code = 'FINANCE_QUERY_INVALID';
    this.status = 400;
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function optionalDate(value, field) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!ISO_DATE.test(text) || !validDate(text)) throw new FinanceQueryError(`${field} must be a valid YYYY-MM-DD date`);
  return text;
}

// Shared filter: account (key or code), period [from, to], free-text match on
// the description, category and tag.
function transactionFilter({ account, from, to, q, category, tag, excludeCategory, excludeTag, ledger } = {}) {
  const filter = { ...ledgerFilter(ledger) };
  const accountText = String(account || '').trim();
  if (accountText) {
    filter[accountText.includes('|') ? 'accountKey' : 'accountCode'] = accountText.includes('|')
      ? accountText : accountText.replace(/\s+/g, '').toUpperCase();
  }
  const start = optionalDate(from, 'from');
  const end = optionalDate(to, 'to');
  if (start && end && start > end) throw new FinanceQueryError('from must not be after to');
  if (start || end) filter.date = { ...(start && { $gte: start }), ...(end && { $lte: end }) };
  const search = String(q || '').trim().slice(0, 80);
  if (search) filter.description = { $regex: escapeRegex(search), $options: 'i' };
  if (category) filter.category = String(category).trim() === 'none' ? null : String(category).trim();
  else if (excludeCategory) filter.category = { $ne: String(excludeCategory).trim() };
  const excluded = String(excludeTag || '').split(',').map((t) => t.trim()).filter(Boolean);
  if (tag) filter.tags = excluded.length ? { $all: [String(tag).trim()], $nin: excluded } : String(tag).trim();
  else if (excluded.length) filter.tags = { $nin: excluded };
  return filter;
}

async function transactions(query = {}) {
  const filter = transactionFilter(query);
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 100, 1), MAX_ROWS);
  const [rows, totals] = await Promise.all([
    FinanceTransaction.find(filter).sort({ date: -1, _id: -1 }).limit(limit)
      .select('accountKey accountCode date description amountCents flowCents category tags manual fingerprint occurrence').lean(),
    FinanceTransaction.aggregate([{ $match: filter }, { $group: totalsStage() }])
  ]);
  const summary = totals[0] || { count: 0, inCents: 0, outCents: 0, netCents: 0 };
  delete summary._id;
  // A row with a confirmed Secretary document carries it, so the list can show the receipt icon.
  const documents = await confirmedFor(rows.map(transactionKey));
  return { rows: rows.map(({ _id, fingerprint, occurrence, ...row }) => {
    const key = transactionKey({ ...row, fingerprint, occurrence });
    return { id: String(_id), ...row, document: documents.get(key) || null };
  }), totals: summary, truncated: summary.count > rows.length, coverage: await assessCoverage(query),
  amountConvention: { amountCents: 'Change in account balance; a positive card or loan amount increases the amount owed.',
    flowCents: 'Owner cash flow; negative is outgoing, positive is incoming. A bank-channel label does not identify its beneficiary.' } };
}

// Expected calendar months come from the requested period, never from the
// existence of matching transactions. A covered empty month is a true zero.
async function monthly(query = {}) {
  const filter = transactionFilter(query);
  const [months, coverage] = await Promise.all([
    FinanceTransaction.aggregate(monthlyPipeline(filter)),
    coverageContext(query)
  ]);
  const period = coverage.bounds(query) || (months.length ? { from: `${months[0]._id}-01`, to: lastDayOf(months.at(-1)._id) } : null);
  const byMonth = new Map(months.map(({ _id, ...rest }) => [_id, rest]));
  const rows = (period ? expectedMonths(period.from, period.to) : []).map(month => {
    const evidence = coverage.month(month, period);
    const stored = byMonth.get(month);
    const totals = stored || { count: 0, inCents: evidence.complete ? 0 : null,
      outCents: evidence.complete ? 0 : null, netCents: evidence.complete ? 0 : null };
    return { month, ...totals, complete: evidence.eligibleForMonthlyAverage, coverage: evidence,
      netMeasure: periodTotal(totals.netCents, evidence.period) };
  });
  const complete = rows.filter((m) => m.complete);
  const average = monthlyAverage(complete.reduce((sum, row) => sum + row.netCents, 0), complete.map(row => row.month));
  const quality = period ? coverage.at(period.from, period.to) : await assessCoverage(query);
  return {
    months: rows,
    averageNetCents: average.amountCents, averageNet: average,
    incompleteMonths: rows.filter((m) => !m.complete).map((m) => m.month),
    dataAsOf: quality.dataAsOf, period, coverage: quality
  };
}

// Where the money goes: outgoing rows grouped by description, largest first.
async function merchants(query = {}) {
  const filter = { ...transactionFilter(query), flowCents: { $lt: 0 } };
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 10, 1), 50);
  const rows = await FinanceTransaction.aggregate([
    { $match: filter },
    { $group: { _id: { $toLower: '$description' }, description: { $first: '$description' },
      count: { $sum: 1 }, outCents: { $sum: '$flowCents' } } },
    { $sort: { outCents: 1, _id: 1 } },
    { $limit: limit }
  ]);
  return { merchants: rows.map(({ _id, ...rest }) => rest), coverage: await assessCoverage(query) };
}

// Totals per category (null = not categorized yet), largest outflow first.
async function byCategory(query = {}) {
  const filter = transactionFilter(query);
  const rows = await FinanceTransaction.aggregate([
    { $match: filter },
    { $group: { ...totalsStage(), _id: '$category' } },
    { $sort: { outCents: 1, _id: 1 } }
  ]);
  return { categories: rows.map(({ _id, ...rest }) => ({ category: _id || null, ...rest })), coverage: await assessCoverage(query) };
}

// Latest known closing balance per account, from reconciled statements only.
async function balances({ ledger } = {}) {
  const statements = await FinanceStatement.find({ status: 'reconciled', ...ledgerFilter(ledger) })
    .sort({ periodEnd: -1 }).select('issuer periodEnd accounts').lean();
  return { accounts: require('./financeBalanceProjection').projectBalances(statements), coverage: await assessCoverage({ ledger }) };
}

async function statements({ status, ledger } = {}) {
  const filter = { ...ledgerFilter(ledger), ...(status ? { status: String(status) } : {}) };
  const rows = await FinanceStatement.find(filter).sort({ periodEnd: -1, ingestedAt: -1 }).limit(MAX_ROWS)
    .select('status issuer periodStart periodEnd fileName accounts.code accounts.transactionCount problems attempts model ingestedAt')
    .lean();
  return { statements: rows.map(({ _id, ...rest }) => ({ id: String(_id), ...rest })) };
}

const DAY_MS = 86400000;
const dayAfter = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

function monthsBetween(from, to) {
  const months = [];
  for (let key = from.slice(0, 7); key <= to.slice(0, 7); key = dayAfter(`${key}-28`, 7).slice(0, 7)) months.push(key);
  return months;
}

// Which months each statement series (issuer + account) covers, and the days
// no statement covers between its first and last one, so the owner knows what
// to fetch. A statement ending mid-month leaves a gap even when the months on
// either side are present.
async function coverage(query = {}) {
  const { ledger } = query;
  const rows = await FinanceStatement.find({ status: 'reconciled', ...ledgerFilter(ledger) }).select('issuer accountLast4 periodStart periodEnd').lean();
  const series = new Map();
  for (const row of rows) {
    const from = row.periodStart || row.periodEnd;
    const to = row.periodEnd || row.periodStart;
    if (!validDate(from) || !validDate(to) || from > to) continue;
    const name = `${row.issuer}${row.accountLast4 ? ` ···${row.accountLast4}` : ''}`;
    series.set(name, [...(series.get(name) || []), { from, to }]);
  }
  const result = [];
  for (const [name, periods] of series) {
    periods.sort((a, b) => a.from.localeCompare(b.from));
    const covered = new Set();
    const gaps = [];
    let reached = null;
    for (const period of periods) {
      if (reached && period.from > dayAfter(reached, 1)) gaps.push({ from: dayAfter(reached, 1), to: dayAfter(period.from, -1) });
      monthsBetween(period.from, period.to).forEach((month) => covered.add(month));
      if (!reached || period.to > reached) reached = period.to;
    }
    const missing = [...new Set(gaps.flatMap((gap) => monthsBetween(gap.from, gap.to)))];
    const sorted = [...covered].sort();
    result.push({ series: name, first: sorted[0], last: sorted.at(-1), months: sorted.length, missing, gaps });
  }
  return { ...await assessCoverage(query), series: result.sort((a, b) => a.series.localeCompare(b.series)) };
}

// Tags in use, most used first, for the explorer's tag picker.
async function tags({ ledger } = {}) {
  const rows = await FinanceTransaction.aggregate([
    { $match: ledgerFilter(ledger) },
    { $unwind: '$tags' },
    { $group: { _id: '$tags', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: 200 }
  ]);
  return { tags: rows.map((row) => ({ tag: row._id, count: row.count })) };
}

module.exports = { transactions, monthly, merchants, byCategory, coverage, tags, balances, statements, transactionFilter, FinanceQueryError };

require('./financeAccess').guard(module.exports, ['transactions', 'monthly', 'merchants', 'byCategory', 'coverage', 'tags', 'balances', 'statements']);
