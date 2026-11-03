'use strict';

// Date coverage is evidence about the requested accounts and interval. It is
// not proof of account attribution, stored-row integrity or a current balance.
const Statement = require('../../../models/FinanceStatement');
const Plan = require('../../../models/FinancePlan');
const Transaction = require('../../../models/FinanceTransaction');
const { ledgerFilter, ledgerOf } = require('./ledgers');

const DAY_MS = 86400000;
const PAYROLL_ACCOUNT = 'EOP';
const MAX_MONTHS = 1200;
const dayAfter = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const lastDayOf = month => {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, number, 0);
  return date.toISOString().slice(0, 10);
};
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && dayAfter(value, 0) === value;
const invalid = message => Object.assign(new Error(message), { code: 'FINANCE_QUERY_INVALID', status: 400 });
const codeOf = key => String(key).split('|').at(-1);

function monthsBetween(from, to) {
  if (!validDate(from) || !validDate(to) || from > to) throw invalid('Choose a valid ordered date interval');
  const months = [];
  let month = from.slice(0, 7);
  while (month <= to.slice(0, 7)) {
    if (months.length >= MAX_MONTHS) throw invalid('The Finance date interval exceeds 100 years');
    months.push(month);
    if (month === to.slice(0, 7)) break;
    month = dayAfter(lastDayOf(month), 1).slice(0, 7);
  }
  return months;
}

function uncovered(intervals, from, to) {
  const gaps = [];
  let cursor = from;
  for (const interval of [...intervals].sort((a, b) => a.from.localeCompare(b.from))) {
    if (interval.to < cursor || interval.from > to) continue;
    if (interval.from > cursor) gaps.push({ from: cursor, to: dayAfter(interval.from, -1) });
    if (interval.to >= to) return gaps;
    cursor = dayAfter(interval.to, 1);
  }
  if (cursor <= to) gaps.push({ from: cursor, to });
  return gaps;
}
const coversMonth = (intervals, month) => !uncovered(intervals, `${month}-01`, lastDayOf(month)).length;

// The existing plan owns expectations. Exact account keys select an explicit
// bounded universe; a book or code needs the owner's declared account inventory.
function createCoverage(statements, declared, { ledger, account, now = new Date() } = {}, rowScopes = []) {
  ledger = ledgerOf(ledger);
  const observed = new Map();
  const issues = [];
  const reviews = [];
  const configuredAge = Number.parseInt(process.env.FINANCE_ALERT_STALE_DAYS, 10);
  const staleDays = Number.isSafeInteger(configuredAge) && configuredAge > 0 ? configuredAge : 45;
  for (const statement of statements) {
    if (statement.status === 'needs_review') { reviews.push(statement); continue; }
    const valid = validDate(statement.periodStart) && validDate(statement.periodEnd) && statement.periodStart <= statement.periodEnd;
    for (const item of statement.accounts || []) {
      const entry = observed.get(item.accountKey) || { accountKey: item.accountKey, code: item.code,
        issuer: statement.issuer, intervals: [] };
      if (valid) entry.intervals.push({ from: statement.periodStart, to: statement.periodEnd });
      else issues.push({ code: 'invalid_statement_period', accountKey: item.accountKey,
        from: validDate(statement.periodStart) ? statement.periodStart : null,
        to: validDate(statement.periodEnd) ? statement.periodEnd : null });
      observed.set(item.accountKey, entry);
    }
  }
  const owners = new Map(statements.map(statement => [String(statement._id), statement]));
  for (const group of rowScopes) {
    const key = group._id.accountKey;
    const owner = owners.get(String(group._id.statementId));
    if (!observed.has(key)) observed.set(key, { accountKey: key, code: codeOf(key), issuer: owner?.issuer || null, intervals: [] });
    const from = [group.firstDate, owner?.periodStart].filter(validDate).sort()[0] || null;
    const to = [group.lastDate, owner?.periodEnd].filter(validDate).sort().at(-1) || null;
    if (!owner || owner.status !== 'reconciled' || !(owner.accounts || []).some(item => item.accountKey === key)) {
      issues.push({ code: 'rows_without_account_source', accountKey: key, from, to });
    } else if (!validDate(group.firstDate) || !validDate(group.lastDate)
      || group.firstDate < owner.periodStart || group.lastDate > owner.periodEnd) {
      issues.push({ code: 'row_dates_outside_source', accountKey: key, from, to });
    }
  }
  const expected = (declared || []).filter(item => item.ledger === ledger);
  const declaredKeys = new Set(expected.map(item => item.accountKey));
  const selected = String(account || '').trim();
  const matches = item => !selected || (selected.includes('|') ? item.accountKey === selected
    : codeOf(item.accountKey) === selected.replace(/\s+/g, '').toUpperCase());
  const requirements = expected.filter(matches).map(item => ({ ...item, code: codeOf(item.accountKey),
    issuer: observed.get(item.accountKey)?.issuer || null }));
  // Unlisted observed accounts remain visible and prevent a global claim of
  // completeness; declaring a single account never hides another active one.
  for (const item of observed.values()) if (matches(item) && !declaredKeys.has(item.accountKey)) {
    requirements.push({ ...item, from: null, to: null, undeclared: true });
  }
  if (selected.includes('|') && !requirements.length) requirements.push({ accountKey: selected, code: codeOf(selected), from: null, to: null });
  const explicitAccount = selected.includes('|');
  const inventoryConfirmed = explicitAccount || (expected.length > 0 && requirements.length > 0 && !requirements.some(item => item.undeclared));
  const intervals = requirements.flatMap(item => observed.get(item.accountKey)?.intervals || []);
  const matchedRows = rowScopes.filter(group => matches({ accountKey: group._id.accountKey }));
  for (const group of matchedRows) {
    const declaredAccount = expected.find(item => item.accountKey === group._id.accountKey);
    if (declaredAccount && (declaredAccount.from && group.firstDate < declaredAccount.from
      || declaredAccount.to && group.lastDate > declaredAccount.to)) {
      issues.push({ code: 'rows_outside_declared_activity', accountKey: group._id.accountKey,
        from: validDate(group.firstDate) ? group.firstDate : null, to: validDate(group.lastDate) ? group.lastDate : null });
    }
  }
  // Include orphan/out-of-period stored rows in the displayed history. Their
  // dates never silently disappear behind a newer/older statement horizon.
  const firstDate = [...intervals.map(item => item.from), ...matchedRows.map(item => item.firstDate)].filter(validDate).sort()[0] || null;
  const lastDate = [...intervals.map(item => item.to), ...matchedRows.map(item => item.lastDate)].filter(validDate).sort().at(-1) || null;

  function bounds({ from, to } = {}) {
    if (from && !validDate(from) || to && !validDate(to)) throw invalid('Choose valid YYYY-MM-DD dates');
    const declaredStart = requirements.map(item => item.from).filter(Boolean).sort()[0];
    const fallback = requirements.length ? now.toISOString().slice(0, 10) : null;
    const first = firstDate || declaredStart || to || from || fallback;
    const last = lastDate || to || from || fallback;
    let start = from || (first ? `${first.slice(0, 7)}-01` : null);
    let end = to || (last ? lastDayOf(last.slice(0, 7)) : null);
    if (start && end && start > end && !(from && to)) {
      if (from) end = lastDayOf(from.slice(0, 7));
      else start = `${to.slice(0, 7)}-01`;
    }
    if (start && end) monthsBetween(start, end);
    return start && end ? { from: start, to: end } : null;
  }

  function at(from, to) {
    monthsBetween(from, to);
    const reasons = [];
    if (!inventoryConfirmed) reasons.push({ code: 'account_inventory_unconfirmed' });
    if (!requirements.length) reasons.push({ code: selected ? 'unknown_account' : 'no_expected_accounts' });
    const accounts = requirements.map(item => {
      const start = item.from && item.from > from ? item.from : from;
      const end = item.to && item.to < to ? item.to : to;
      const data = observed.get(item.accountKey);
      const active = start <= end;
      const gaps = active ? uncovered(data?.intervals || [], start, end) : [];
      const asOf = data?.intervals.map(period => period.to).sort().at(-1) || null;
      return { accountKey: item.accountKey, code: item.code, issuer: item.issuer, active,
        expected: active ? { from: start, to: end } : null, asOf, gaps,
        complete: active && gaps.length === 0,
        missingMonths: [...new Set(gaps.flatMap(gap => monthsBetween(gap.from, gap.to)))],
        declared: !item.undeclared && declaredKeys.has(item.accountKey) };
    });
    const active = accounts.filter(item => item.active);
    for (const item of active) if (item.gaps.length) reasons.push({ code: 'missing_account_days', accountKey: item.accountKey, gaps: item.gaps });
    const relevantIssues = issues.filter(issue => accounts.some(item => item.accountKey === issue.accountKey)
      && (!issue.from || issue.from <= to) && (!issue.to || issue.to >= from));
    reasons.push(...relevantIssues);
    const pending = reviews.filter(item => {
      if (validDate(item.periodStart) && validDate(item.periodEnd) && (item.periodEnd < from || item.periodStart > to)) return false;
      return !selected || !item.accounts?.length || item.accounts.some(matches);
    });
    if (pending.length) reasons.push({ code: 'statements_need_review', count: pending.length });
    const today = now.toISOString().slice(0, 10);
    if (to > today) reasons.push({ code: 'future_days', from: from > today ? from : dayAfter(today, 1), to });
    const complete = inventoryConfirmed && active.length > 0 && active.every(item => item.complete)
      && !relevantIssues.length && !pending.length && to <= today;
    const current = active.filter(item => item.expected.to === to);
    const dated = current.length ? current : active;
    const dataAsOf = dated.length && dated.every(item => item.asOf) ? dated.map(item => item.asOf).sort()[0] : null;
    const ageDays = dataAsOf ? Math.max(0, Math.floor((Date.parse(today) - Date.parse(dataAsOf)) / DAY_MS)) : null;
    const status = complete ? 'covered' : !active.length ? 'unavailable' : !inventoryConfirmed ? 'unknown' : 'partial';
    return { kind: 'statement_date_coverage', ledger, account: selected || null, period: { from, to }, status, complete,
      inventoryConfirmed, accounts, reasons, dataAsOf,
      freshness: { evaluatedOn: today, ageDays, stale: ageDays == null ? null : ageDays > staleDays, staleAfterDays: staleDays },
      limits: ['Account attribution and stored-row integrity are separate checks.'] };
  }
  function month(key, requested = {}) {
    const from = requested.from && requested.from > `${key}-01` ? requested.from : `${key}-01`;
    const to = requested.to && requested.to < lastDayOf(key) ? requested.to : lastDayOf(key);
    const report = at(from, to);
    const fullMonth = from === `${key}-01` && to === lastDayOf(key);
    return { ...report, fullMonth, eligibleForMonthlyAverage: fullMonth && report.complete };
  }
  return { ledger, firstDate, lastDate, bounds, at, month,
    get asOf() { const period = bounds(); return period ? at(period.from, period.to).dataAsOf : null; },
    isComplete: key => month(key).eligibleForMonthlyAverage };
}

async function coverageContext(query = {}) {
  const [statements, plan, rowScopes] = await Promise.all([
    Statement.find(ledgerFilter(query.ledger)).select('status issuer periodStart periodEnd accounts').lean(),
    Plan.findById('plan').select('coverageAccounts').lean(),
    Transaction.aggregate([{ $match: ledgerFilter(query.ledger) }, { $group: {
      _id: { statementId: '$statementId', accountKey: '$accountKey' }, firstDate: { $min: '$date' }, lastDate: { $max: '$date' }
    } }])
  ]);
  return createCoverage(statements, plan?.coverageAccounts, query, rowScopes);
}

async function assessCoverage(query = {}) {
  const context = await coverageContext(query);
  const period = context.bounds(query);
  return period ? context.at(period.from, period.to) : { kind: 'statement_date_coverage', ledger: ledgerOf(query.ledger),
    period: null, status: 'unavailable', complete: false, inventoryConfirmed: false, accounts: [],
    reasons: [{ code: 'no_statement_period' }], dataAsOf: null };
}

module.exports = { coverageContext, assessCoverage, createCoverage, monthsBetween, uncovered, validDate,
  PAYROLL_ACCOUNT, payrollCoverage: coverageContext, coversMonth, lastDayOf, dayAfter, DAY_MS };
require('./financeAccess').guard(module.exports, ['coverageContext', 'assessCoverage', 'payrollCoverage']);
