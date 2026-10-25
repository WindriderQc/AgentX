'use strict';

// Both manifest versions describe one whole statement. Version 1 retains its
// original one-row/one-decision shape; version 2 names every printed row and
// each existing manual decision, with no document-link migration.
const { error } = require('./financeAccess');
const { canonical } = require('./financeRepairStorage');
const { ledgerOf, ledgerPrefix, flowOf } = require('./ledgers');
const invalid = message => error(message, 'FINANCE_REPAIR_MANIFEST_INVALID', 400);
const keyOf = row => [row.accountKey, row.date, row.fingerprint, row.occurrence].join('|');
const parts = manifest => ({
  statement: manifest.updates[0],
  transactions: manifest.updates.filter(u => u.collection === 'finance_transactions'),
  overrides: manifest.updates.filter(u => u.collection === 'finance_overrides')
});

function validate(manifest) {
  const m = manifest;
  const group = parts(m);
  const s = group.statement.before;
  const rows = group.transactions.map(u => u.before);
  const decisions = group.overrides.map(u => u.before);
  if (group.statement.collection !== 'finance_statements' || rows.length < 1 || rows.length > 50
    || decisions.length > rows.length || m.updates.length !== 1 + rows.length + decisions.length
    || (m.schemaVersion === 1 && (rows.length !== 1 || decisions.length !== 1))) throw invalid('One whole bounded statement is required');
  const ordered = [group.statement, ...group.transactions, ...group.overrides];
  if (ordered.some((u,i) => u !== m.updates[i])) throw invalid('Statement, rows and decisions must be grouped in that order');
  for (const updates of [group.transactions, group.overrides]) {
    const ids = updates.map(u => u.id);
    if (new Set(ids).size !== ids.length || canonical(ids) !== canonical([...ids].sort())) throw invalid('Reviewed document IDs must be unique and ordered');
  }
  const source = ledgerOf(s.ledger), target = m.verifiedIdentity?.ledger;
  if (!['perso','corp'].includes(target) || target === source || ![undefined,'perso','corp'].includes(s.ledger)
    || !Array.isArray(s.accounts) || !s.accounts.length || s.accounts.length > 20
    || typeof s.archivePath !== 'string' || s.status !== 'reconciled' || s.accountLast4 !== null
    || !/^[a-f0-9]{64}$/.test(s.fileSha256 || '') || s.fileSha256 !== m.verifiedIdentity.pdfSha256
    || s.archivePath !== m.verifiedIdentity.originalArchivePath || s.periodStart !== m.verifiedIdentity.periodStart
    || s.periodEnd !== m.verifiedIdentity.periodEnd || s.issuer !== m.verifiedIdentity.issuer
    || !/^\d{4}$/.test(m.verifiedIdentity.last4 || '') || m.legacyIdentityRetained?.accountLast4 !== null
    || m.expectedAccounting?.latestBalancesExpectedUnchangedInBothLedgers !== true) throw invalid('Inconsistent reviewed statement identity');
  const base = s.statementKey?.replace(/^corp:/, '');
  if (!base || s.statementKey !== ledgerPrefix(source) + base || base.split('|').length !== 4
    || base.split('|')[1] !== '-' || base.split('|')[2] !== s.periodStart || base.split('|')[3] !== s.periodEnd
    || !/^\d{4}-\d{2}-\d{2}$/.test(s.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(s.periodEnd)
    || s.periodStart > s.periodEnd) throw invalid('Invalid statement key or period');
  const accountBase = base.split('|').slice(0,2).join('|');
  const codes = s.accounts.map(a => a?.code);
  if (codes.some(code => typeof code !== 'string' || !code) || new Set(codes).size !== codes.length) throw invalid('Account codes must be unique');
  for (const a of s.accounts) {
    if (a.accountKey !== ledgerPrefix(source) + accountBase + '|' + a.code
      || !Number.isSafeInteger(a.openingCents) || !Number.isSafeInteger(a.closingCents)
      || !Number.isInteger(a.transactionCount) || a.transactionCount < 0) throw invalid('Inconsistent account identity or totals');
  }
  if (s.accounts.reduce((n,a) => n + a.transactionCount,0) !== rows.length) throw invalid('The manifest must include the whole row set');
  if (new Set(rows.map(keyOf)).size !== rows.length) throw invalid('Duplicate transaction identity');
  for (const t of rows) {
    if (t.statementId !== s._id || ledgerOf(t.ledger) !== source || ![undefined,'perso','corp'].includes(t.ledger)
      || !s.accounts.some(a => a.accountKey === t.accountKey && a.code === t.accountCode)
      || !Array.isArray(t.tags) || t.tags.some(tag => typeof tag !== 'string') || typeof t.category !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(t.date || '') || t.date < s.periodStart || t.date > s.periodEnd
      || typeof t.fingerprint !== 'string' || !t.fingerprint || !Number.isSafeInteger(t.occurrence) || t.occurrence < 1
      || !Number.isSafeInteger(t.amountCents) || t.flowCents !== flowOf(t.accountCode,t.amountCents)
      || !Number.isSafeInteger(t.balanceAfterCents)) throw invalid('Inconsistent reviewed transaction');
  }
  let order = m.verifiedIdentity.transactionOrder;
  if (m.schemaVersion === 1) order = Object.fromEntries(s.accounts.map(a => [a.code,rows.filter(t => t.accountKey === a.accountKey).map(t => t._id)]));
  if (!order || typeof order !== 'object' || Array.isArray(order)
    || canonical(Object.keys(order).sort()) !== canonical([...codes].sort())) throw invalid('Version 2 requires the printed row order for every account');
  for (const a of s.accounts) {
    const ids = order[a.code];
    const accountRows = rows.filter(t => t.accountKey === a.accountKey);
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length !== a.transactionCount
      || canonical([...ids].sort()) !== canonical(accountRows.map(t => t._id).sort())) throw invalid('Printed order does not cover the exact account rows');
    let balance = a.openingCents, date = s.periodStart;
    for (const id of ids) {
      const row = accountRows.find(t => t._id === id);
      balance += row.amountCents;
      if (!Number.isSafeInteger(balance) || balance !== row.balanceAfterCents || row.date < date) throw invalid('A printed running balance does not reconcile');
      date = row.date;
    }
    if (balance !== a.closingCents) throw invalid('Account arithmetic does not reconcile');
  }
  if (new Set(decisions.map(keyOf)).size !== decisions.length) throw invalid('Duplicate owner decision');
  for (const row of rows) {
    const related = decisions.filter(o => keyOf(o) === keyOf(row));
    if (related.length !== (row.manual === true ? 1 : 0)) throw invalid('Every manual row must retain exactly its existing decision');
  }
  for (const o of decisions) {
    const t = rows.find(row => keyOf(row) === keyOf(o));
    if (!t || t.manual !== true || !Array.isArray(o.tags) || o.category !== t.category
      || canonical(o.tags) !== canonical(t.tags)) throw invalid('The owner decision must follow the exact transaction');
  }
  const move = key => ledgerPrefix(target) + key.replace(/^corp:/, '');
  const sets = [{ledger:target,statementKey:ledgerPrefix(target)+base,
    ...Object.fromEntries(s.accounts.map((a,i) => [`accounts.${i}.accountKey`,move(a.accountKey)]))},
  ...rows.map(t => ({ledger:target,accountKey:move(t.accountKey)})), ...decisions.map(o => ({accountKey:move(o.accountKey)}))];
  for (let i=0;i<sets.length;i++) if (canonical(sets[i]) !== canonical(m.updates[i].set)) throw invalid('Manifest attempts an unreviewed Finance mutation');
}

module.exports = { validate, keyOf, parts };
