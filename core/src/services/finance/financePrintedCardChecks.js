'use strict';

const { error } = require('./financeAccess');
const { parts } = require('./financeRepairStatementContract');
const { keyOf } = require('./financeTransactionIdentity');
const { canonical, hash } = require('./financeRepairStorage');
const money = require('./financeMoneyTotals');
const conflict = () => error('The reviewed printed card scope or monthly money changed','FINANCE_REPAIR_STATE_CONFLICT',409);

function validateScope(state,manifest,destination) {
  const group=parts(manifest), s=group.statement.before;
  const existing=group.transactions.filter(u=>!u.insert).map(u=>u.id), owned=new Set(group.transactions.map(u=>u.id));
  const actual=state.finance_transactions.filter(t=>String(t.statementId)===s._id).map(t=>String(t._id));
  if (actual.some(id=>!owned.has(id)) || existing.some(id=>!actual.includes(id))) throw conflict();
  const targets=group.transactions.map(u=>require('./financePrintedCardContract').correctedRow(manifest,u));
  const keys=new Set([...group.transactions.filter(u=>u.before).map(u=>keyOf(u.before)),...targets.map(keyOf)]);
  const decisions=state.finance_overrides.filter(o=>keys.has(keyOf(o))).map(o=>String(o._id)).sort();
  if (canonical(decisions)!==canonical(group.overrides.map(u=>u.id).sort())) throw conflict();
  const documents=new Set(group.links.map(u=>u.before.documentId));
  const links=state.finance_document_links.filter(l=>documents.has(l.documentId) || keys.has(l.transactionKey)).map(l=>String(l._id)).sort();
  if (canonical(links)!==canonical(group.links.map(u=>u.id).sort())) throw conflict();
  for (const name of ['finance_statements','finance_transactions','finance_overrides','finance_document_links']) {
    const identity=name==='finance_statements'?row=>row.statementKey:name==='finance_document_links'?row=>row.key:keyOf;
    for (const [i,u] of manifest.updates.entries()) {
      if (u.collection!==name || destination[i]===null) continue;
      // Never rely on dropping a unique index or temporarily moving another row.
      if (state[name].some(row=>String(row._id)!==u.id && identity(row)===identity(destination[i]))) throw conflict();
    }
  }
}
async function plan(db,manifest,state,target,direction='apply') {
  const before=await money.nativeMonthly(db), expected=manifest.expectedAccounting.monthlyProjection;
  if (canonical(money.projectMonthly(state.finance_transactions))!==canonical(before)
    || (direction==='apply' && hash(before)!==expected.beforeSha256)
    || hash(money.projectMonthly(target.finance_transactions))!==(direction==='apply'?expected.afterSha256:expected.beforeSha256)) throw conflict();
  return before;
}
async function result(db,manifest,before,direction='apply') {
  const after=await money.nativeMonthly(db), expected=manifest.expectedAccounting.monthlyProjection;
  if ((direction==='apply' && hash(before)!==expected.beforeSha256)
    || hash(after)!==(direction==='apply'?expected.afterSha256:expected.beforeSha256)) throw conflict();
  return {reviewedMonthlyProjectionMatched:true,monthlyProjectionBeforeSha256:hash(before),monthlyProjectionAfterSha256:hash(after)};
}
module.exports={validateScope,plan,result};
