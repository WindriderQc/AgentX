'use strict';

const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{once}=require('node:events');
const mongoose=require('mongoose');
const Statement=require('../../models/FinanceStatement'),Transaction=require('../../models/FinanceTransaction');
const Override=require('../../models/FinanceOverride'),Link=require('../../models/FinanceDocumentLink');
const storage=require('../../src/services/finance/financeRepairStorage'),check=require('../../src/services/finance/financeRepairChecks');
const contract=require('../../src/services/finance/financeRepairManifest'),restore=require('../../src/services/finance/financeStatementRestoreContract');
const balance=require('../../src/services/finance/financeRepairBalanceProof'),money=require('../../src/services/finance/financeMoneyTotals');
const register=require('../../src/services/finance/financeDocumentRegister'),links=require('../../src/services/finance/financeRepairLinkContract');
const {createExecutor}=require('../../src/services/finance/financeRepairExecutor');
const id=n=>n.toString(16).padStart(24,'0');
const evidence=(line,text)=>[{line,text}];
function build(manifest) {
  const target=restore.content(manifest);
  const insert=(collection,key,set)=>({collection,id:key,before:null,expectedBeforeSha256:storage.hash(null),insert:true,upsert:false,matchCountRequired:0,set,
    setAtExecution:{createdAt:'receipt.appliedAtUtc',updatedAt:'receipt.appliedAtUtc',...(collection==='finance_statements'?{ingestedAt:'receipt.appliedAtUtc'}:{})}});
  manifest.updates=[insert('finance_statements',manifest.updates[0].id,target.statement),...target.rows.sort((a,b)=>a.id.localeCompare(b.id)).map(r=>insert('finance_transactions',r.id,r.set))];
}
async function fixture() {
  const previousRegister=process.env.FINANCE_SECRETARY_REGISTER,previousNames=process.env.FINANCE_CORP_NAMES;delete process.env.FINANCE_CORP_NAMES;
  for(const name of [...contract.COLLECTIONS,'finance_repairs','finance_coordination','finance_ingestions'])await mongoose.connection.db.collection(name).deleteMany({});
  await Promise.all([Statement.syncIndexes(),Transaction.syncIndexes(),Override.syncIndexes(),Link.syncIndexes()]);
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'finance-statement-restore-test-')),archive=temp+'/archive';await fs.mkdir(archive);
  const original=archive+'/original.pdf';await fs.writeFile(original,'synthetic completely reviewed monthly original');process.env.FINANCE_SECRETARY_REGISTER=temp+'/register.json';
  const rawDocuments=[{supplier:'Old Example Supplier',documentNumber:'OLD',documentDate:'2026-01-04',grossAmountCents:200,kind:'receipt'},
    {supplier:'Example Loan',documentNumber:'NEW',documentDate:'2025-02-12',grossAmountCents:10500,kind:'receipt'}];
  await fs.writeFile(process.env.FINANCE_SECRETARY_REGISTER,JSON.stringify({schemaVersion:3,invoices:rawDocuments,complete:true}));
  const doc=(await register.loadRegister()).invoices[0];
  const latest=await Statement.create({issuer:'Example Bank',ledger:'perso',accountLast4:null,status:'reconciled',fileName:'latest.pdf',fileSha256:storage.hash('latest'),
    statementKey:'example-bank|-|2026-01-01|2026-01-31',periodStart:'2026-01-01',periodEnd:'2026-01-31',accounts:[
      {code:'EOP',accountKey:'example-bank|-|EOP',openingCents:89088,closingCents:88888,transactionCount:1},
      {code:'MC1',accountKey:'example-bank|-|MC1',openingCents:50000,closingCents:50000,transactionCount:0},
      {code:'CS',accountKey:'example-bank|-|CS',openingCents:500,closingCents:500,transactionCount:0}]});
  const oldRow=await Transaction.create({statementId:latest._id,ledger:'perso',accountKey:'example-bank|-|EOP',accountCode:'EOP',date:'2026-01-05',description:'Old Example Supplier',
    amountCents:-200,flowCents:-200,balanceAfterCents:88888,fingerprint:'old-example',occurrence:1,category:'Owner category',tags:['retained'],manual:true});
  await Override.create({accountKey:oldRow.accountKey,date:oldRow.date,fingerprint:oldRow.fingerprint,occurrence:1,category:oldRow.category,tags:oldRow.tags,createdBy:'owner'});
  await Link.create({key:doc.id+'|'+contract.keyOf(oldRow),documentId:doc.id,transactionKey:contract.keyOf(oldRow),status:'proposed',ambiguous:true,
    bookRepair:{requestKey:'synthetic-previous-v1',documentSha256:storage.hash(doc)},
    document:{...links.documentImage(doc),ledger:'perso'},transaction:{accountKey:oldRow.accountKey,date:oldRow.date,description:oldRow.description,flowCents:oldRow.flowCents,category:oldRow.category}});
  const row=(key,reference,date,description,bankCode,columns,balanceAfterCents,line,text)=>({id:id(key),reference,date,description,bankCode,columns,balanceAfterCents,sourceLines:evidence(line,text)});
  const accounts=[{code:'EOP',openingCents:10000,closingCents:29500,openingSource:evidence(1,'EOP opening 100.00'),rows:[
    row(1,'EOP-L2','2025-02-05','Example payroll','DI',{debitCents:0,creditCents:30000,feesCents:0},40000,2,'05 FEB DI Example payroll     300.00     400.00'),
    row(2,'EOP-L3','2025-02-12','Example loan payment','RA',{debitCents:10500,creditCents:0,feesCents:0},29500,3,'12 FEB RA Example loan payment     105.00     295.00')]},
    {code:'MC1',openingCents:50000,closingCents:40000,openingSource:evidence(4,'MC1 opening 500.00'),rows:[
      row(3,'MC1-L5','2025-02-12','Example repayment','REC',{advanceCents:0,principalRepaidCents:10000,interestPaidCents:500},40000,5,'12 FEB REC Example repayment     5.00    100.00    400.00')]},
    {code:'CS',openingCents:500,closingCents:500,openingSource:evidence(6,'CS opening 5.00'),rows:[]}];
  const manifest={schemaVersion:6,operation:'statement-restoration',requestKey:'synthetic-monthly-restoration-v1',legacyIdentityRetained:{accountLast4:null},
    verifiedIdentity:{issuer:'Example Bank',ledger:'perso',last4:'1234',periodStart:'2025-02-01',periodEnd:'2025-02-28',originalArchivePath:original,
      pdfSha256:storage.hash('synthetic completely reviewed monthly original'),accounts},expectedAccounting:{latestBalancesExpectedUnchangedInBothLedgers:true},updates:[{id:'1'.repeat(24)}]};
  build(manifest);const initial=await check.snapshot(mongoose.connection.db);
  const pin=()=>{const target=check.derive(initial,manifest,contract.afterImages(manifest,'2026-01-01T00:00:00.000Z'));
    manifest.expectedAccounting.balanceProjection={beforeSha256:storage.hash(balance.project(initial)),afterSha256:storage.hash(balance.project(target))};
    manifest.expectedAccounting.monthlyProjection={beforeSha256:storage.hash(money.projectMonthly(initial.finance_transactions)),afterSha256:storage.hash(money.projectMonthly(target.finance_transactions))};};pin();
  const app=require('express')().use('/api/finance',require('../../routes/finance')());let server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const options={mode:'apply',actor:'synthetic-test',receiptRoot:temp+'/receipts',archiveRoot:archive,coreOrigin:'http://127.0.0.1:'+server.address().port};
  const serialize=()=>{const bytes=Buffer.from(JSON.stringify(manifest));return {bytes,confirmedDigest:storage.hash(bytes)};};
  return {temp,original,manifest,initial,options,serialize,pin,build:()=>build(manifest),execute:extra=>createExecutor().execute({...options,...serialize(),...extra}),
    journal:()=>mongoose.connection.db.collection('finance_repairs').findOne({_id:manifest.requestKey}),
    replaceServer:async app=>{await new Promise(r=>server.close(r));server=app.listen(0,'127.0.0.1');await once(server,'listening');options.coreOrigin='http://127.0.0.1:'+server.address().port;},
    close:async()=>{await new Promise(r=>server.close(r));await fs.rm(temp,{recursive:true,force:true});
      if(previousRegister===undefined)delete process.env.FINANCE_SECRETARY_REGISTER;else process.env.FINANCE_SECRETARY_REGISTER=previousRegister;
      if(previousNames===undefined)delete process.env.FINANCE_CORP_NAMES;else process.env.FINANCE_CORP_NAMES=previousNames;}}
}
module.exports={fixture,id};
