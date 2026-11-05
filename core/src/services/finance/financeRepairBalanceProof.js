'use strict';

const { projectBalances } = require('./financeBalanceProjection');
const { hash, canonical } = require('./financeRepairStorage');
const { error } = require('./financeAccess');
const conflict = () => error('The reviewed issuer balance projection changed','FINANCE_REPAIR_STATE_CONFLICT',409);

function project(state) {
  return Object.fromEntries(['perso','corp'].map(ledger => {
    const statements = state.finance_statements.filter(s => s.status === 'reconciled'
      && (ledger === 'corp' ? s.ledger === 'corp' : s.ledger !== 'corp'))
      .sort((a,b) => b.periodEnd.localeCompare(a.periodEnd));
    return [ledger,{accounts:projectBalances(statements)}];
  }));
}
function assertPlan(manifest,state,nativeBefore,targetState,direction='apply') {
  const expected = manifest.expectedAccounting.balanceProjection;
  if (canonical(project(state)) !== canonical(nativeBefore)
    || (direction === 'apply' ? hash(nativeBefore) !== expected.beforeSha256 : ![expected.beforeSha256,expected.afterSha256].includes(hash(nativeBefore)))
    || hash(project(targetState)) !== (direction === 'apply' ? expected.afterSha256 : expected.beforeSha256)) throw conflict();
}
function assertResult(manifest,before,after,direction='apply') {
  const expected = manifest.expectedAccounting.balanceProjection;
  if ((direction === 'apply' ? hash(before) !== expected.beforeSha256 : ![expected.beforeSha256,expected.afterSha256].includes(hash(before)))
    || hash(after) !== (direction === 'apply' ? expected.afterSha256 : expected.beforeSha256)) throw conflict();
  return { latestBalancesUnchanged: canonical(before) === canonical(after), reviewedBalanceProjectionMatched:true,
    balanceProjectionBeforeSha256:hash(before), balanceProjectionAfterSha256:hash(after) };
}

module.exports = { project, assertPlan, assertResult };
