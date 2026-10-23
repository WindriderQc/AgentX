'use strict';

// Payroll-account coverage. A month is complete only when the payroll account
// (EOP) statements cover every day of it. An incomplete month may lack income,
// so it is shown apart and left out of averages and savings rates.

const FinanceStatement = require('../../../models/FinanceStatement');
const { ledgerFilter } = require('./ledgers');

const PAYROLL_ACCOUNT = 'EOP';
const DAY_MS = 86400000;

const dayAfter = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// Last day of a YYYY-MM month (month number 0 of the next year is day 0 here).
function lastDayOf(month) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}

// True when the intervals ({ from, to } dates sorted by from) cover every day of the month.
function coversMonth(sorted, month) {
  let cursor = `${month}-01`;
  for (const { from, to } of sorted) {
    if (from <= cursor && to >= cursor) cursor = dayAfter(to, 1);
  }
  return cursor > lastDayOf(month);
}

// Coverage of the personal ledger's payroll account. Without any payroll
// statement (for example the corporate ledger) nothing is marked incomplete.
async function payrollCoverage({ ledger } = {}) {
  const statements = await FinanceStatement.find({ status: 'reconciled', ...ledgerFilter(ledger), 'accounts.code': PAYROLL_ACCOUNT })
    .select('periodStart periodEnd').lean();
  const intervals = statements.filter((s) => s.periodStart && s.periodEnd)
    .map((s) => ({ from: s.periodStart, to: s.periodEnd }))
    .sort((a, b) => a.from.localeCompare(b.from));
  const asOf = statements.map((s) => s.periodEnd).filter(Boolean).sort().at(-1) || null;
  return {
    account: PAYROLL_ACCOUNT,
    required: intervals.length > 0,
    asOf,
    isComplete: (month) => !intervals.length || coversMonth(intervals, month)
  };
}

module.exports = { PAYROLL_ACCOUNT, payrollCoverage, coversMonth, lastDayOf, dayAfter, DAY_MS };

require('./financeAccess').guard(module.exports, ['payrollCoverage']);
