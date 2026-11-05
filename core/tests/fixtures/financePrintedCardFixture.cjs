'use strict';

const fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
const { once }=require('node:events');
const mongoose=require('mongoose');
const Statement=require('../../models/FinanceStatement'), Transaction=require('../../models/FinanceTransaction');
const Override=require('../../models/FinanceOverride'), Link=require('../../models/FinanceDocumentLink');
const storage=require('../../src/services/finance/financeRepairStorage'), check=require('../../src/services/finance/financeRepairChecks');
const contract=require('../../src/services/finance/financeRepairManifest'), balances=require('../../src/services/finance/financeRepairBalanceProof');
const money=require('../../src/services/finance/financeMoneyTotals'), printed=require('../../src/services/finance/financePrintedCardContract');
const register=require('../../src/services/finance/financeDocumentRegister'), linkContract=require('../../src/services/finance/financeRepairLinkContract');
const {createExecutor}=require('../../src/services/finance/financeRepairExecutor');
const update=(collection,before,set)=>({collection,id:before._id,before,expectedBeforeSha256:storage.hash(before),set,
  setAtExecution:Object.keys(set).length?{updatedAt:'receipt.appliedAtUtc'}:{},insert:false,upsert:false,matchCountRequired:1});

async function fixture() {
  const previousRegister=process.env.FINANCE_SECRETARY_REGISTER, previousNames=process.env.FINANCE_CORP_NAMES;
  delete process.env.FINANCE_CORP_NAMES;
  for (const n of [...contract.COLLECTIONS,'finance_repairs','finance_coordination','finance_ingestions']) await mongoose.connection.db.collection(n).deleteMany({});
  await Promise.all([Statement.syncIndexes(),Transaction.syncIndexes(),Override.syncIndexes(),Link.syncIndexes()]);
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'finance-printed-card-test-')), archive=temp+'/archive';await fs.mkdir(archive);
  const original=archive+'/original.pdf';await fs.writeFile(original,'synthetic reviewed printed card');
  process.env.FINANCE_SECRETARY_REGISTER=temp+'/register.json';
  const rawDocument={supplier:'Example Supplier',documentNumber:'P-1',documentDate:'2025-07-04',kind:'receipt',grossAmountCents:3000};
  const writeRegister=invoices=>fs.writeFile(process.env.FINANCE_SECRETARY_REGISTER,JSON.stringify({schemaVersion:3,invoices,complete:true}));
  await writeRegister([rawDocument]);const doc=(await register.loadRegister()).invoices[0];
  const s=await Statement.create({issuer:'Example Bank',accountLast4:null,status:'reconciled',statementKey:'example-bank|-|2025-07-01|2025-07-28',
    periodStart:'2025-07-01',periodEnd:'2025-07-28',archivePath:original,fileName:'original.pdf',fileSha256:storage.hash('synthetic reviewed printed card'),
    accounts:[{code:'CARD',accountKey:'example-bank|-|CARD',openingCents:10000,closingCents:13500,transactionCount:4}]});
  const ids=[1,2,3,4].map(i=>i.toString(16).padStart(24,'0'));
  const rows=await Transaction.create([3000,-1000,250].map((amountCents,i)=>({_id:ids[i],statementId:s._id,accountKey:'example-bank|-|CARD',
    accountCode:'CARD',date:['2025-07-05','2025-06-15','2025-07-28'][i],description:['Example Supplier North','Example transfer','Example fee'][i],
    amountCents,flowCents:-amountCents,balanceAfterCents:null,fingerprint:'example-'+i,occurrence:1,
    category:i===2?null:'Owner category',tags:i===0?['owner-tag']:[],manual:i===0})));
  await Transaction.collection.updateOne({_id:rows[2]._id},{$unset:{manual:''}});
  await Override.create({accountKey:rows[0].accountKey,date:rows[0].date,fingerprint:rows[0].fingerprint,occurrence:1,
    category:rows[0].category,tags:rows[0].tags,createdBy:'owner'});
  await Link.create({key:doc.id+'|'+contract.keyOf(rows[0]),documentId:doc.id,transactionKey:contract.keyOf(rows[0]),status:'proposed',ambiguous:true,
    document:{...linkContract.documentImage(doc),ledger:'perso'},transaction:{accountKey:rows[0].accountKey,date:rows[0].date,
      description:rows[0].description,flowCents:rows[0].flowCents,category:rows[0].category}});
  for(const ledger of ['perso','corp']) {
    const prefix=ledger==='corp'?'corp:':'';
    await Statement.create({issuer:'Example Bank',ledger,status:'reconciled',fileName:ledger+'.pdf',fileSha256:storage.hash(ledger),
      statementKey:prefix+'example-bank|-|2026-01-01|2026-01-31',periodStart:'2026-01-01',periodEnd:'2026-01-31',
      accounts:[{code:'CARD',accountKey:prefix+'example-bank|-|CARD',openingCents:14000,closingCents:14000,transactionCount:0}]});
  }
  const initial=await check.snapshot(mongoose.connection.db), before=storage.plain(initial), st=before.finance_statements.find(t=>t._id===String(s._id));
  const pr=(i,reference,date,description,amountCents)=>({id:ids[i],reference,date,postingDate:date,description,amountCents});
  const manifest={schemaVersion:5,operation:'printed-card-correction',requestKey:'synthetic-printed-card-v1',legacyIdentityRetained:{accountLast4:null},
    verifiedIdentity:{issuer:st.issuer,ledger:'perso',last4:'1234',periodStart:'2025-06-01',periodEnd:st.periodEnd,pdfSha256:st.fileSha256,
      originalArchivePath:original,documents:[doc],printedRows:[pr(0,'001','2025-06-05','Example Supplier',3000),pr(1,'002','2025-06-15','Example transfer',-1000),
        pr(3,'003','2025-07-10','Missing Example',1250),pr(2,'004','2025-07-28','Example fee',250)]},updates:[],expectedAccounting:{latestBalancesExpectedUnchangedInBothLedgers:true}};
  manifest.updates=[update('finance_statements',st,{periodStart:'2025-06-01',statementKey:'example-bank|-|2025-06-01|2025-07-28'}),
    ...before.finance_transactions.map((t,i)=>update('finance_transactions',t,i===0?{date:'2025-06-05'}:{})),
    {collection:'finance_transactions',id:ids[3],before:null,expectedBeforeSha256:storage.hash(null),insert:true,upsert:false,matchCountRequired:0,
      set:{},setAtExecution:{createdAt:'receipt.appliedAtUtc',updatedAt:'receipt.appliedAtUtc'}},
    ...before.finance_overrides.map(o=>update('finance_overrides',o,{date:'2025-06-05'})),
    ...before.finance_document_links.map(l=>update('finance_document_links',l,{key:doc.id+'|example-bank|-|CARD|2025-06-05|example-0|1',
      transactionKey:'example-bank|-|CARD|2025-06-05|example-0|1','transaction.accountKey':'example-bank|-|CARD','transaction.date':'2025-06-05',
      bookRepair:{requestKey:manifest.requestKey,documentSha256:storage.hash(doc)}}))];
  manifest.updates[4].set=printed.newRow(manifest,manifest.verifiedIdentity.printedRows[2]);
  const pin=()=>{
    const after=check.derive(initial,manifest,contract.afterImages(manifest,'2026-01-01T00:00:00.000Z'));
    manifest.expectedAccounting.balanceProjection={beforeSha256:storage.hash(balances.project(initial)),afterSha256:storage.hash(balances.project(after))};
    manifest.expectedAccounting.monthlyProjection={beforeSha256:storage.hash(money.projectMonthly(initial.finance_transactions)),afterSha256:storage.hash(money.projectMonthly(after.finance_transactions))};
  };pin();
  const app=require('express')().use('/api/finance',require('../../routes/finance')());let server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const options={mode:'apply',actor:'synthetic-test',receiptRoot:temp+'/receipts',archiveRoot:archive,coreOrigin:'http://127.0.0.1:'+server.address().port};
  const serialize=()=>{const bytes=Buffer.from(JSON.stringify(manifest));return {bytes,confirmedDigest:storage.hash(bytes)};};
  return {temp,original,initial,manifest,options,rawDocument,writeRegister,serialize,pin,
    execute:extra=>createExecutor().execute({...options,...serialize(),...extra}),
    journal:()=>mongoose.connection.db.collection('finance_repairs').findOne({_id:manifest.requestKey}),
    replaceServer:async app=>{await new Promise(r=>server.close(r));server=app.listen(0,'127.0.0.1');await once(server,'listening');options.coreOrigin='http://127.0.0.1:'+server.address().port;},
    close:async()=>{await new Promise(r=>server.close(r));await fs.rm(temp,{recursive:true,force:true});
      if(previousRegister===undefined)delete process.env.FINANCE_SECRETARY_REGISTER;else process.env.FINANCE_SECRETARY_REGISTER=previousRegister;
      if(previousNames===undefined)delete process.env.FINANCE_CORP_NAMES;else process.env.FINANCE_CORP_NAMES=previousNames;}
  };
}
module.exports={fixture,update};
