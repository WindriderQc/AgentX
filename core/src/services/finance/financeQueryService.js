'use strict';

// Read-only questions over the finance ledger. Every total is computed here,
// in integer cents, so a model or UI only phrases the answer.

const FinanceStatement = require('../../../models/FinanceStatement');
const FinanceTransaction = require('../../../models/FinanceTransaction');
const { ledgerFilter } = require('./ledgers');

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
  if (!ISO_DATE.test(text)) throw new FinanceQueryError(`${field} must be a YYYY-MM-DD date`);
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

function totalsStage() {
  return {
    _id: null,
    count: { $sum: 1 },
    inCents: { $sum: { $cond: [{ $gt: ['$flowCents', 0] }, '$flowCents', 0] } },
    outCents: { $sum: { $cond: [{ $lt: ['$flowCents', 0] }, '$flowCents', 0] } },
    netCents: { $sum: '$flowCents' }
  };
}

async function transactions(query = {}) {
  const filter = transactionFilter(query);
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 100, 1), MAX_ROWS);
  const [rows, totals] = await Promise.all([
    FinanceTransaction.find(filter).sort({ date: -1, _id: -1 }).limit(limit)
      .select('accountKey accountCode date description amountCents flowCents category tags manual').lean(),
    FinanceTransaction.aggregate([{ $match: filter }, { $group: totalsStage() }])
  ]);
  const summary = totals[0] || { count: 0, inCents: 0, outCents: 0, netCents: 0 };
  delete summary._id;
  return { rows: rows.map(({ _id, ...row }) => ({ id: String(_id), ...row })), totals: summary, truncated: summary.count > rows.length };
}

async function monthly(query = {}) {
  const filter = transactionFilter(query);
  const months = await FinanceTransaction.aggregate([
    { $match: filter },
    { $group: { ...totalsStage(), _id: { $substrBytes: ['$date', 0, 7] } } },
    { $sort: { _id: 1 } }
  ]);
  return {
    months: months.map(({ _id, ...rest }) => ({ month: _id, ...rest })),
    averageNetCents: months.length ? Math.round(months.reduce((sum, m) => sum + m.netCents, 0) / months.length) : 0
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
  return { merchants: rows.map(({ _id, ...rest }) => rest) };
}

// Totals per category (null = not categorized yet), largest outflow first.
async function byCategory(query = {}) {
  const filter = transactionFilter(query);
  const rows = await FinanceTransaction.aggregate([
    { $match: filter },
    { $group: { ...totalsStage(), _id: '$category' } },
    { $sort: { outCents: 1, _id: 1 } }
  ]);
  return { categories: rows.map(({ _id, ...rest }) => ({ category: _id || null, ...rest })) };
}

// Latest known closing balance per account, from reconciled statements only.
async function balances({ ledger } = {}) {
  const statements = await FinanceStatement.find({ status: 'reconciled', ...ledgerFilter(ledger) })
    .sort({ periodEnd: -1 }).select('issuer periodEnd accounts').lean();
  const latest = new Map();
  for (const statement of statements) {
    for (const account of statement.accounts) {
      if (!latest.has(account.accountKey)) {
        latest.set(account.accountKey, {
          accountKey: account.accountKey, code: account.code, issuer: statement.issuer,
          balanceCents: account.closingCents, asOf: statement.periodEnd
        });
      }
    }
  }
  return { accounts: [...latest.values()].sort((a, b) => a.accountKey.localeCompare(b.accountKey)) };
}

async function statements({ status, ledger } = {}) {
  const filter = { ...ledgerFilter(ledger), ...(status ? { status: String(status) } : {}) };
  const rows = await FinanceStatement.find(filter).sort({ periodEnd: -1, ingestedAt: -1 }).limit(MAX_ROWS)
    .select('status issuer periodStart periodEnd fileName accounts.code accounts.transactionCount problems attempts model ingestedAt')
    .lean();
  return { statements: rows.map(({ _id, ...rest }) => ({ id: String(_id), ...rest })) };
}

// Which months each statement series (issuer + account) covers, and the gaps
// between its first and last statement, so the owner knows what to fetch.
async function coverage({ ledger } = {}) {
  const rows = await FinanceStatement.find({ status: 'reconciled', ...ledgerFilter(ledger) }).select('issuer accountLast4 periodStart periodEnd').lean();
  const series = new Map();
  for (const row of rows) {
    const name = `${row.issuer}${row.accountLast4 ? ` ···${row.accountLast4}` : ''}`;
    const months = series.get(name) || new Set();
    for (const date of [row.periodStart, row.periodEnd]) if (date) months.add(date.slice(0, 7));
    series.set(name, months);
  }
  const result = [];
  for (const [name, months] of series) {
    const sorted = [...months].sort();
    const missing = [];
    let [year, month] = sorted[0].split('-').map(Number);
    for (;;) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      if (key > sorted.at(-1)) break;
      if (!months.has(key)) missing.push(key);
      month += 1;
      if (month === 13) { year += 1; month = 1; }
    }
    result.push({ series: name, first: sorted[0], last: sorted.at(-1), months: sorted.length, missing });
  }
  return { series: result.sort((a, b) => a.series.localeCompare(b.series)) };
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
