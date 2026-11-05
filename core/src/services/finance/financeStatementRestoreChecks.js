'use strict';

const { error }=require('./financeAccess');
const { keyOf }=require('./financeTransactionIdentity');
const { content }=require('./financeStatementRestoreContract');
const conflict=()=>error('The absent statement restoration destination is occupied','FINANCE_REPAIR_STATE_CONFLICT',409);

function validateScope(state,m) {
  const target=content(m),statementId=m.updates[0].id,rows=target.rows.map(r=>({_id:r.id,...r.set}));
  const ids=new Set(rows.map(r=>r._id)),keys=new Set(rows.map(keyOf));
  if (keys.size!==rows.length || state.finance_statements.some(s=>String(s._id)!==statementId
    && (s.statementKey===target.statement.statementKey || s.fileSha256===m.verifiedIdentity.pdfSha256))) throw conflict();
  if (state.finance_transactions.some(t=>(String(t.statementId)===statementId && !ids.has(String(t._id)))
    || (keys.has(keyOf(t)) && !ids.has(String(t._id))))) throw conflict();
  if (state.finance_overrides.some(o=>keys.has(keyOf(o)))
    || state.finance_document_links.some(l=>keys.has(l.transactionKey))) throw conflict();
}
module.exports={validateScope};
