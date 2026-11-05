'use strict';

// Restore one absent, completely reviewed monthly statement. Never replace a
// previous extraction or turn an owner decision into a new default category.
const path=require('node:path');
const { error }=require('./financeAccess');
const { canonical, hash }=require('./financeRepairStorage');
const { validDate }=require('./financeCompleteness');
const { isLiability, flowOf }=require('./ledgers');
const { normalizeIssuer }=require('./statementExtraction');
const { statementKeyOf, accountKeyOf, fingerprintOf }=require('./financeIngestionService');
const invalid=text=>error(text,'FINANCE_REPAIR_MANIFEST_INVALID',400);
const same=(a,b)=>canonical(a)===canonical(b);
const safe=value=>Number.isSafeInteger(value);
const fold=text=>text.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/\s+/g,' ').trim();

function sourceEvidence(evidence) {
  if (!Array.isArray(evidence) || !evidence.length || evidence.length>8 || evidence.some((s,i)=>!s
    || !same(Object.keys(s).sort(),['line','text']) || !Number.isSafeInteger(s.line) || s.line<1 || s.line>100000
    || typeof s.text!=='string' || !s.text.trim() || s.text.length>400 || (i>0 && evidence[i-1].line>=s.line))) throw invalid('Exact source line evidence is required');
  return evidence.map(s=>s.text).join(' ');
}
function amountOf(account,row) {
  const c=row.columns, names=isLiability(account.code)?['advanceCents','principalRepaidCents','interestPaidCents']:['debitCents','creditCents','feesCents'];
  if (!c || !same(Object.keys(c).sort(),names.sort()) || Object.values(c).some(v=>!safe(v))) throw invalid('Exact printed monetary columns in integer cents are required');
  let amount=isLiability(account.code)?c.advanceCents-c.principalRepaidCents:c.creditCents-c.debitCents;
  if (!safe(amount)) throw invalid('Statement arithmetic exceeds safe integer cents');
  if (!isLiability(account.code)) amount-=c.feesCents;
  if (!safe(amount)) throw invalid('Statement arithmetic exceeds safe integer cents');
  return amount;
}
function sourceNumbers(text) {
  return [...text.matchAll(/-?(?:\d{1,3}(?:[ \u00a0]\d{3})+|\d+)[.,]\d{2}-?/g)].map(m=>
    (m[0].startsWith('-')||m[0].endsWith('-')?-1:1)*Number(m[0].replace(/[ \u00a0.,-]/g,'')));
}
function content(m) {
  const i=m.verifiedIdentity, ledger=i.ledger;
  const base={issuer:i.issuer,accountLast4:null,periodStart:i.periodStart,periodEnd:i.periodEnd};
  const statement={...base,ledger,statementKey:statementKeyOf(base,ledger),status:'reconciled',fileName:path.basename(i.originalArchivePath),
    fileSha256:i.pdfSha256,archivePath:i.originalArchivePath,model:null,attempts:0,source:'text',problems:[],
    accounts:i.accounts.map(a=>({code:a.code,accountKey:accountKeyOf(base,a.code,ledger),openingCents:a.openingCents,closingCents:a.closingCents,transactionCount:a.rows.length})),
    sourceRepair:{requestKey:m.requestKey,pdfSha256:i.pdfSha256,verifiedAccountsSha256:hash(i.accounts)}};
  const rows=[],seen=new Map();
  for (const a of i.accounts) for (const r of a.rows) {
    const accountKey=accountKeyOf(base,a.code,ledger),amountCents=amountOf(a,r),fingerprint=fingerprintOf({description:r.description,amountCents});
    const key=[accountKey,r.date,fingerprint].join('|'),occurrence=(seen.get(key)||0)+1;seen.set(key,occurrence);
    rows.push({id:r.id,set:{statementId:m.updates[0].id,ledger,accountKey,accountCode:a.code,date:r.date,description:r.description,amountCents,
      flowCents:flowOf(a.code,amountCents),balanceAfterCents:r.balanceAfterCents,fingerprint,occurrence,category:null,tags:[],manual:false,
      sourceRepair:{requestKey:m.requestKey,pdfSha256:i.pdfSha256,printedReference:r.reference,printedRowSha256:hash(r)}}});
  }
  return {statement,rows};
}
function validate(m,group) {
  const i=m.verifiedIdentity;
  if (m.operation!=='statement-restoration' || group.statement.collection!=='finance_statements' || !group.statement.insert
    || group.transactions.length<1 || group.transactions.length>200 || group.overrides.length || group.links.length
    || m.updates.some(u=>!u.insert) || m.updates.length!==group.transactions.length+1) throw invalid('One absent monthly statement and up to200new rows are required');
  if (!i || typeof i.issuer!=='string' || !i.issuer || i.issuer!==normalizeIssuer(i.issuer) || !['perso','corp'].includes(i.ledger)
    || !/^\d{4}$/.test(i.last4||'') || m.legacyIdentityRetained?.accountLast4!==null
    || typeof i.originalArchivePath!=='string' || !path.isAbsolute(i.originalArchivePath) || !/^[a-f0-9]{64}$/.test(i.pdfSha256||'')
    || !validDate(i.periodStart) || !validDate(i.periodEnd) || !i.periodStart.endsWith('-01')
    || i.periodStart.slice(0,7)!==i.periodEnd.slice(0,7)
    || new Date(Date.parse(i.periodEnd+'T00:00:00Z')+86400000).getUTCDate()!==1
    || !Array.isArray(i.accounts) || !i.accounts.length || i.accounts.length>20
    || m.expectedAccounting?.latestBalancesExpectedUnchangedInBothLedgers!==true) throw invalid('Inconsistent reviewed monthly restoration identity');
  for (const name of ['balanceProjection','monthlyProjection']) {
    const proof=m.expectedAccounting[name];
    if (!/^[a-f0-9]{64}$/.test(proof?.beforeSha256||'') || !/^[a-f0-9]{64}$/.test(proof?.afterSha256||'')
      || (name==='balanceProjection' && proof.beforeSha256!==proof.afterSha256)) throw invalid('Reviewed restoration monetary projections are required');
  }
  const rows=i.accounts.flatMap(a=>Array.isArray(a?.rows)?a.rows:[]),ids=group.transactions.map(u=>u.id);
  if (new Set(i.accounts.map(a=>a?.code)).size!==i.accounts.length || rows.length!==group.transactions.length
    || new Set(rows.map(r=>r?.id)).size!==rows.length || !same(rows.map(r=>r?.id).sort(),[...ids].sort())
    || !same(ids,[...ids].sort()) || group.transactions.some((u,n)=>u!==m.updates[n+1])) throw invalid('Restore the complete uniquely identified printed row set');
  for (const a of i.accounts) {
    if (!a || !/^[A-Z][A-Z0-9]{0,7}$/.test(a.code||'') || !safe(a.openingCents) || !safe(a.closingCents) || !Array.isArray(a.rows)) throw invalid('Invalid printed account');
    const openingText=sourceEvidence(a.openingSource);
    if (!sourceNumbers(openingText).includes(a.openingCents)) throw invalid('The printed opening source amount differs');
    let balance=a.openingCents,date=i.periodStart;
    const references=new Set();
    for (const r of a.rows) {
      if (!r || !validDate(r.date) || r.date<date || r.date>i.periodEnd || !/^[a-zA-Z0-9_.:-]{1,40}$/.test(r.reference||'') || references.has(r.reference)
        || !/^[A-Z][A-Z0-9]{0,7}$/.test(r.bankCode||'') || typeof r.description!=='string' || !r.description.trim() || r.description.length>1024
        || !safe(r.balanceAfterCents)) throw invalid('Invalid printed restoration row');
      references.add(r.reference);const text=sourceEvidence(r.sourceLines),numbers=sourceNumbers(text),amount=amountOf(a,r);
      if (!fold(text).includes(fold(r.description)) || !numbers.includes(r.balanceAfterCents)
        || Object.values(r.columns).some(v=>v!==0&&!numbers.includes(v))) throw invalid('The source lines must retain the printed description and amounts');
      balance+=amount;if (!safe(balance) || balance!==r.balanceAfterCents) throw invalid('Every printed running balance must reconcile in safe integer cents');date=r.date;
    }
    if (balance!==a.closingCents) throw invalid('The full printed closing balance must reconcile');
  }
  const derived=content(m);
  if (!same(group.statement.set,derived.statement)) throw invalid('Restoration attempts an unreviewed statement mutation');
  for (const u of group.transactions) if (!same(u.set,derived.rows.find(r=>r.id===u.id).set)) throw invalid('Restoration attempts an unreviewed row mutation');
}
module.exports={validate,content,amountOf};
