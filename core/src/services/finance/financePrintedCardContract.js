'use strict';

// A closed original-source correction, separate from book/issuer moves. All
// existing rows are reviewed, including byte-identical rows needing no write.
const { error } = require('./financeAccess');
const { canonical, hash } = require('./financeRepairStorage');
const { ledgerOf, flowOf, isLiability } = require('./ledgers');
const { statementKeyOf, accountKeyOf, fingerprintOf } = require('./financeIngestionService');
const { keyOf } = require('./financeTransactionIdentity');
const invalid = text => error(text,'FINANCE_REPAIR_MANIFEST_INVALID',400);
const date = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const fold = s => s.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/\s+/g,' ').trim();

function correctedRow(m,update) {
  const printed=m.verifiedIdentity.printedRows.find(p=>p.id===update.id);
  return update.before ? {...update.before,date:printed.date} : {_id:update.id,...newRow(m,printed)};
}
function newRow(m,printed) {
  const s=m.updates[0].before, a=s.accounts[0];
  return {statementId:s._id,ledger:ledgerOf(s.ledger),accountKey:a.accountKey,accountCode:a.code,
    date:printed.date,description:printed.description,amountCents:printed.amountCents,flowCents:flowOf(a.code,printed.amountCents),
    balanceAfterCents:null,fingerprint:fingerprintOf(printed),occurrence:1,category:null,tags:[],manual:false,
    sourceRepair:{requestKey:m.requestKey,pdfSha256:s.fileSha256,printedReference:printed.reference,printedRowSha256:hash(printed)}};
}
function validate(m,group) {
  const s=group.statement.before, identity=m.verifiedIdentity, ledger=ledgerOf(s?.ledger);
  const rows=group.transactions.filter(u=>!u.insert).map(u=>u.before), added=group.transactions.filter(u=>u.insert);
  const decisions=group.overrides.map(u=>u.before);
  if (m.operation!=='printed-card-correction' || group.statement.collection!=='finance_statements'
    || group.statement.insert || group.overrides.some(u=>u.insert) || group.links.some(u=>u.insert)
    || group.transactions.length<1 || group.transactions.length>100 || added.length>10
    || decisions.length>rows.length || group.links.length>50
    || m.updates.length!==1+group.transactions.length+decisions.length+group.links.length) throw invalid('One bounded printed card statement is required');
  const ordered=[group.statement,...group.transactions,...group.overrides,...group.links];
  if (ordered.some((u,i)=>u!==m.updates[i])) throw invalid('Printed card updates must be grouped');
  for (const groupRows of [group.transactions,group.overrides,group.links]) {
    const ids=groupRows.map(u=>u.id);
    if (new Set(ids).size!==ids.length || canonical(ids)!==canonical([...ids].sort())) throw invalid('Printed card document IDs must be unique and ordered');
  }
  if (!s || s.status!=='reconciled' || s.accountLast4!==null || Array.isArray(s.rowKeys)
    || ![undefined,'perso','corp'].includes(s.ledger) || !identity || identity.ledger!==ledger || identity.issuer!==s.issuer
    || !/^\d{4}$/.test(identity.last4||'') || m.legacyIdentityRetained?.accountLast4!==null
    || !/^[a-f0-9]{64}$/.test(s.fileSha256||'') || identity.pdfSha256!==s.fileSha256 || identity.originalArchivePath!==s.archivePath
    || !date(s.periodStart) || !date(s.periodEnd) || s.periodStart>s.periodEnd || s.statementKey!==statementKeyOf(s,ledger)
    || !date(identity.periodStart) || !date(identity.periodEnd) || identity.periodStart>identity.periodEnd
    || !Array.isArray(s.accounts) || s.accounts.length!==1 || !Array.isArray(identity.documents)
    || (!group.links.length && identity.documents.length) || m.expectedAccounting?.latestBalancesExpectedUnchangedInBothLedgers!==true) throw invalid('Inconsistent printed card identity');
  for (const name of ['balanceProjection','monthlyProjection']) {
    const proof=m.expectedAccounting[name];
    if (!/^[a-f0-9]{64}$/.test(proof?.beforeSha256||'') || !/^[a-f0-9]{64}$/.test(proof?.afterSha256||'')
      || (name==='balanceProjection' && proof.beforeSha256!==proof.afterSha256)) throw invalid('Reviewed balance and monthly monetary projections are required');
  }
  const a=s.accounts[0], printed=identity.printedRows;
  if (!a || !isLiability(a.code) || a.accountKey!==accountKeyOf(s,a.code,ledger)
    || !Number.isSafeInteger(a.openingCents) || !Number.isSafeInteger(a.closingCents)
    || !Number.isInteger(a.transactionCount) || a.transactionCount!==group.transactions.length
    || !Array.isArray(printed) || printed.length!==group.transactions.length || new Set(printed.map(p=>p?.id)).size!==printed.length
    || new Set(printed.map(p=>p?.reference)).size!==printed.length
    || canonical(printed.map(p=>p?.id).sort())!==canonical(group.transactions.map(u=>u.id).sort())) throw invalid('The complete printed account must be reviewed');
  let balance=a.openingCents;
  for (const p of printed) {
    if (!p || canonical(Object.keys(p).sort())!==canonical(['id','reference','date','postingDate','description','amountCents'].sort())
      || typeof p.reference!=='string' || !/^[a-zA-Z0-9-]{1,16}$/.test(p.reference) || !date(p.date) || !date(p.postingDate)
      || p.date>p.postingDate || p.postingDate<identity.periodStart || p.postingDate>identity.periodEnd
      || Date.parse(p.postingDate)-Date.parse(p.date)>31*86400000
      || typeof p.description!=='string' || !p.description.trim() || p.description.length>1024 || !Number.isSafeInteger(p.amountCents)) throw invalid('Invalid reviewed printed row');
    balance+=p.amountCents;
    if (!Number.isSafeInteger(balance)) throw invalid('Printed card arithmetic exceeds safe integer cents');
  }
  if (balance!==a.closingCents) throw invalid('The full printed card account must reconcile');
  for (const t of rows) {
    const p=printed.find(p=>p.id===t._id);
    if (String(t.statementId)!==s._id || ledgerOf(t.ledger)!==ledger || ![undefined,'perso','corp'].includes(t.ledger)
      || t.accountKey!==a.accountKey || t.accountCode!==a.code || !date(t.date)
      || t.amountCents!==p.amountCents || t.flowCents!==flowOf(a.code,t.amountCents)
      || typeof t.description!=='string' || !fold(t.description).startsWith(fold(p.description))
      || t.balanceAfterCents!==null || typeof t.fingerprint!=='string' || !t.fingerprint
      || !Number.isSafeInteger(t.occurrence) || t.occurrence<1 || !(t.category===null || typeof t.category==='string')
      || !Array.isArray(t.tags) || t.tags.some(tag=>typeof tag!=='string')) throw invalid('Existing card facts must be retained exactly');
  }
  const target={...s,periodStart:identity.periodStart,periodEnd:identity.periodEnd};
  const statementSet=Object.fromEntries(['periodStart','periodEnd','statementKey'].flatMap(k=>{
    const value=k==='statementKey'?statementKeyOf(target,ledger):target[k];return value===s[k]?[]:[[k,value]];
  }));
  require('./financeRepairStatementContract').validateDecisions(rows,decisions);
  const rowSets=group.transactions.map(u=>u.insert?newRow(m,printed.find(p=>p.id===u.id)):
    u.before.date===printed.find(p=>p.id===u.id).date?{}:{date:printed.find(p=>p.id===u.id).date});
  const after=group.transactions.map(u=>correctedRow(m,u));
  if (new Set(rows.map(keyOf)).size!==rows.length || new Set(after.map(keyOf)).size!==after.length) throw invalid('Printed card transaction identities must be unique');
  const decisionSets=decisions.map(o=>{
    const i=rows.findIndex(t=>keyOf(t)===keyOf(o)), p=printed.find(p=>p.id===rows[i]._id);
    return p.date===o.date?{}:{date:p.date};
  });
  const moveRow=row=>after.find(t=>t._id===row._id);
  const sets=[statementSet,...rowSets,...decisionSets];
  if (group.links.length) sets.push(...require('./financeRepairLinkContract').sets(m,group,{source:ledger,target:ledger,moveRow}));
  for (let i=0;i<sets.length;i++) if (canonical(sets[i])!==canonical(m.updates[i].set)) throw invalid('Printed card repair attempts an unreviewed mutation');
}
module.exports={validate,correctedRow,newRow};
