'use strict';

const { error } = require('./financeAccess');
const { parts } = require('./financeRepairStatementContract');
const { keyOf } = require('./financeTransactionIdentity');
const { canonical } = require('./financeRepairStorage');
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
module.exports={validateScope,...require('./financeRepairMonthlyProof')};
