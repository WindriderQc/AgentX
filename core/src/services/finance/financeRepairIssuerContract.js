'use strict';

// A separate closed operation: correct a card issuer without moving its book,
// normalizing account numbers, changing monetary facts or inventing balances.
const { error } = require('./financeAccess');
const { canonical } = require('./financeRepairStorage');
const { ledgerOf, flowOf, isLiability } = require('./ledgers');
const { keyOf } = require('./financeTransactionIdentity');
const { statementKeyOf, accountKeyOf } = require('./financeIngestionService');
const { normalizeIssuer } = require('./statementExtraction');
const invalid = message => error(message,'FINANCE_REPAIR_MANIFEST_INVALID',400);

function validate(m,group) {
  const s = group.statement.before, identity = m.verifiedIdentity;
  const rows = group.transactions.map(u => u.before), decisions = group.overrides.map(u => u.before);
  const ledger = ledgerOf(s.ledger);
  if (m.operation !== 'issuer-reassignment' || group.statement.collection !== 'finance_statements'
    || rows.length < 1 || rows.length > 100 || decisions.length > rows.length || group.links.length > 50
    || m.updates.length !== 1 + rows.length + decisions.length + group.links.length) throw invalid('One complete bounded card statement is required');
  const ordered = [group.statement,...group.transactions,...group.overrides,...group.links];
  if (ordered.some((u,i) => u !== m.updates[i])) throw invalid('Statement, rows, decisions and links must be grouped');
  for (const updates of [group.transactions,group.overrides,group.links]) {
    const ids = updates.map(u => u.id);
    if (new Set(ids).size !== ids.length || canonical(ids) !== canonical([...ids].sort())) throw invalid('Document IDs must be unique and ordered');
  }
  if (!identity || identity.ledger !== ledger || ![undefined,'perso','corp'].includes(s.ledger)
    || typeof s.issuer !== 'string' || !s.issuer || typeof identity.issuer !== 'string' || !identity.issuer
    || identity.issuer !== normalizeIssuer(identity.issuer) || identity.issuer === s.issuer
    || typeof s.archivePath !== 'string' || s.status !== 'reconciled' || s.accountLast4 !== null
    || m.legacyIdentityRetained?.accountLast4 !== null || !/^\d{4}$/.test(identity.last4 || '')
    || !/^[a-f0-9]{64}$/.test(s.fileSha256 || '') || identity.pdfSha256 !== s.fileSha256
    || identity.originalArchivePath !== s.archivePath || identity.periodStart !== s.periodStart || identity.periodEnd !== s.periodEnd
    || !/^\d{4}-\d{2}-\d{2}$/.test(s.periodStart || '') || !/^\d{4}-\d{2}-\d{2}$/.test(s.periodEnd || '') || s.periodStart > s.periodEnd
    || !Array.isArray(s.accounts) || !s.accounts.length || s.accounts.length > 20
    || !Array.isArray(identity.documents) || (!group.links.length && identity.documents.length)
    || !/^[a-f0-9]{64}$/.test(m.expectedAccounting?.balanceProjection?.beforeSha256 || '')
    || !/^[a-f0-9]{64}$/.test(m.expectedAccounting?.balanceProjection?.afterSha256 || '')) throw invalid('Inconsistent reviewed issuer identity or balance proof');
  const target = { ...s, issuer: identity.issuer };
  const sourceKey = statementKeyOf(s,ledger), targetKey = statementKeyOf(target,ledger);
  if (s.statementKey !== sourceKey || sourceKey === targetKey) throw invalid('Issuer keys must use the native unchanged legacy account identity');
  const from = sourceKey.split('|')[0], to = targetKey.split('|')[0];
  const move = key => {
    if (typeof key !== 'string' || !key.startsWith(from+'|')) throw invalid('Account identity escaped the reviewed issuer');
    return to+key.slice(from.length);
  };
  if (s.accounts.some(a => !a || typeof a !== 'object') || new Set(s.accounts.map(a => a.code)).size !== s.accounts.length
    || new Set(rows.map(keyOf)).size !== rows.length) throw invalid('Duplicate account or transaction identity');
  for (const account of s.accounts) {
    const selected = rows.filter(t => t.accountKey === account.accountKey);
    if (!isLiability(account.code) || account.accountKey !== accountKeyOf(s,account.code,ledger)
      || !Number.isSafeInteger(account.openingCents) || !Number.isSafeInteger(account.closingCents)
      || !Number.isInteger(account.transactionCount) || selected.length !== account.transactionCount) throw invalid('The full card account must reconcile in integer cents');
    let total = account.openingCents;
    for (const row of selected) {
      total += row.amountCents;
      if (!Number.isSafeInteger(row.amountCents) || !Number.isSafeInteger(total)) throw invalid('Card arithmetic exceeds safe integer cents');
    }
    if (total !== account.closingCents) throw invalid('The full card account must reconcile in integer cents');
  }
  for (const row of rows) {
    if (row.statementId !== s._id || ledgerOf(row.ledger) !== ledger || ![undefined,'perso','corp'].includes(row.ledger)
      || !s.accounts.some(a => a.accountKey === row.accountKey && a.code === row.accountCode)
      || !Number.isSafeInteger(row.amountCents) || row.flowCents !== flowOf(row.accountCode,row.amountCents)
      || !(row.balanceAfterCents === null || Number.isSafeInteger(row.balanceAfterCents))
      || !/^\d{4}-\d{2}-\d{2}$/.test(row.date || '') || typeof row.fingerprint !== 'string' || !row.fingerprint
      || !Number.isSafeInteger(row.occurrence) || row.occurrence < 1 || !(row.category === null || typeof row.category === 'string')
      || !Array.isArray(row.tags) || row.tags.some(tag => typeof tag !== 'string')) throw invalid('Inconsistent existing card row');
  }
  require('./financeRepairStatementContract').validateDecisions(rows,decisions);
  const sets = [{ issuer: identity.issuer, statementKey: targetKey,
    ...Object.fromEntries(s.accounts.map((a,i) => ['accounts.'+i+'.accountKey',move(a.accountKey)])) },
  ...rows.map(t => ({ accountKey: move(t.accountKey) })),...decisions.map(o => ({ accountKey: move(o.accountKey) }))];
  if (group.links.length) sets.push(...require('./financeRepairLinkContract').sets(m,group,{source:ledger,target:ledger,move}));
  for (let i=0;i<sets.length;i++) if (canonical(sets[i]) !== canonical(m.updates[i].set)) throw invalid('Issuer repair attempts an unreviewed mutation');
}

module.exports = { validate };
