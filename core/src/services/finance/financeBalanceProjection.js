'use strict';

const { isLiability } = require('./ledgers');

// The caller supplies reconciled statements in descending period-end order.
// Both the native reader and reviewed repairs use this one balance projection.
function projectBalances(statements) {
  const latest = new Map();
  for (const statement of statements) {
    for (const account of statement.accounts) {
      if (!latest.has(account.accountKey)) {
        latest.set(account.accountKey, {
          accountKey: account.accountKey, code: account.code, issuer: statement.issuer,
          balanceCents: account.closingCents, asOf: statement.periodEnd,
          liability: isLiability(account.code)
        });
      }
    }
  }
  return [...latest.values()].sort((a,b) => a.accountKey.localeCompare(b.accountKey));
}

module.exports = { projectBalances };
