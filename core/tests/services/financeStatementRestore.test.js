'use strict';

const fs=require('node:fs/promises'),path=require('node:path'),{fork}=require('node:child_process'),{once}=require('node:events');
const mongoose=require('mongoose');
const {fixture,id}=require('../fixtures/financeStatementRestoreFixture.cjs');
const Statement=require('../../models/FinanceStatement'),Transaction=require('../../models/FinanceTransaction');
const Override=require('../../models/FinanceOverride'),Link=require('../../models/FinanceDocumentLink');
const storage=require('../../src/services/finance/financeRepairStorage'),contract=require('../../src/services/finance/financeRepairManifest');
const check=require('../../src/services/finance/financeRepairChecks'),access=require('../../src/services/finance/financeAccess'),docs=require('../../src/services/finance/financeDocumentLinks');
let f,quiet;
beforeEach(async()=>{quiet=jest.spyOn(console,'error').mockImplementation(()=>{});f=await fixture();});
afterEach(async()=>{if(f)await f.close();quiet.mockRestore();});

test('restores the full printed statement and rows without new accounts or changes to existing money/categories/decisions/links',async()=>{
  const receipt=await f.execute();expect(receipt).toMatchObject({schema:'agentx.finance-statement-restoration/v1',phase:'applied',reviewedDocuments:4,documents:4,
    inserted:4,updated:0,deleted:0,latestBalancesUnchanged:true,reviewedMonthlyProjectionMatched:true,reviewedBalanceProjectionMatched:true});
  const after=await check.snapshot(mongoose.connection.db);
  for(const name of contract.COLLECTIONS)for(const old of f.initial[name])expect(after[name].find(d=>String(d._id)===String(old._id))).toEqual(old);
  const statement=after.finance_statements.find(s=>String(s._id)===f.manifest.updates[0].id);
  expect(statement).toMatchObject({accountLast4:null,attempts:0,model:null,status:'reconciled',source:'text',sourceRepair:{requestKey:f.manifest.requestKey}});
  expect(statement.ingestedAt.toISOString()).toBe(receipt.appliedAtUtc);
  const rows=after.finance_transactions.filter(t=>String(t.statementId)===String(statement._id));expect(rows).toHaveLength(3);
  expect(rows.every(t=>t.category===null&&!t.manual&&t.tags.length===0)).toBe(true);
  expect(rows.find(t=>t.accountCode==='MC1')).toMatchObject({amountCents:-10000,flowCents:10000,balanceAfterCents:40000});
  const oldLink=after.finance_document_links[0];await docs.documents({ledger:'perso'});await docs.documents({ledger:'corp'});
  expect((await check.snapshot(mongoose.connection.db)).finance_document_links.find(l=>String(l._id)===String(oldLink._id))).toEqual(oldLink);
  expect((await access.state()).repair).toBeNull();expect(await f.execute({mode:'resume'})).toEqual(receipt);
});

test('reverses only its inserted statement and rows, restoring exact initial absence and all views',async()=>{
  await f.execute();expect(await f.execute({mode:'rollback'})).toMatchObject({phase:'rolled_back',documents:4,inserted:0,updated:0,deleted:4,exactBeforeImagesRestored:true});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(f.initial);expect((await access.state()).repair).toBeNull();
});

test.each(['amount','flow','category','manual','account-suffix','wrong-book','statement-total','statement-attempts','statement-model','source-provenance','source-description','source-column','source-opening','source-line','running-balance','closing-balance','omitted-row','duplicate-row','invalid-date','partial-month','empty-account-change','missing-ingested-timestamp'])('refuses unreviewed %s before journal creation',async kind=>{
  const m=f.manifest,u=m.updates,a=m.verifiedIdentity.accounts;
  if(kind==='amount')u[1].set.amountCents=30001;
  if(kind==='flow')u[1].set.flowCents=-30000;
  if(kind==='category')u[1].set.category='Invented';
  if(kind==='manual')u[1].set.manual=true;
  if(kind==='account-suffix')u[0].set.accountLast4='1234';
  if(kind==='wrong-book')u[0].set.ledger='corp';
  if(kind==='statement-total')u[0].set.accounts[0].closingCents++;
  if(kind==='statement-attempts')u[0].set.attempts=4;
  if(kind==='statement-model')u[0].set.model='invented-extractor';
  if(kind==='source-provenance')u[1].set.sourceRepair.printedReference='different';
  if(kind==='source-description')a[0].rows[0].description='Different source';
  if(kind==='source-column')a[0].rows[0].columns.creditCents=3000000;
  if(kind==='source-opening')a[0].openingCents=10100;
  if(kind==='source-line')a[0].rows[0].sourceLines[0].text='Unrelated source';
  if(kind==='running-balance')a[0].rows[0].balanceAfterCents++;
  if(kind==='closing-balance')a[0].closingCents++;
  if(kind==='omitted-row')u.splice(1,1);
  if(kind==='duplicate-row')a[0].rows[1].id=a[0].rows[0].id;
  if(kind==='invalid-date')a[0].rows[0].date='2025-02-31';
  if(kind==='partial-month')m.verifiedIdentity.periodStart='2025-02-02';
  if(kind==='empty-account-change')a[2].closingCents=501;
  if(kind==='missing-ingested-timestamp')delete u[0].setAtExecution.ingestedAt;
  await expect(f.execute()).rejects.toMatchObject({code:'FINANCE_REPAIR_MANIFEST_INVALID'});expect(await f.journal()).toBeNull();expect(await check.snapshot(mongoose.connection.db)).toEqual(f.initial);
});

test.each(['occupied-statement-id','occupied-row-id','same-pdf-needs-review','statement-key','transaction-key','orphan-decision','orphan-link','unlisted-statement-row','monthly-before','monthly-after','latest-balance-proof','changed-original'])('refuses %s before any accounting dispatch and preserves current owner data',async kind=>{
  const m=f.manifest,first=m.updates[1].set;
  if(kind==='occupied-statement-id')await Statement.create({...m.updates[0].set,_id:m.updates[0].id,statementKey:'other|-|2025-01-01|2025-01-31',fileSha256:storage.hash('different')});
  if(kind==='occupied-row-id')await Transaction.create({...first,_id:m.updates[1].id,date:'2024-01-01'});
  if(kind==='same-pdf-needs-review')await Statement.create({fileName:'failed.pdf',fileSha256:m.verifiedIdentity.pdfSha256,status:'needs_review',attempts:4,problems:['source discrepancy']});
  if(kind==='statement-key')await Statement.create({...m.updates[0].set,_id:new mongoose.Types.ObjectId(),fileSha256:storage.hash('other-original')});
  if(kind==='transaction-key')await Transaction.create({...first,_id:new mongoose.Types.ObjectId(),statementId:new mongoose.Types.ObjectId()});
  if(kind==='orphan-decision')await Override.create({...first,category:'Owner choice',createdBy:'owner'});
  if(kind==='orphan-link')await Link.create({...f.initial.finance_document_links[0],_id:new mongoose.Types.ObjectId(),key:'orphan|'+contract.keyOf(first),transactionKey:contract.keyOf(first)});
  if(kind==='unlisted-statement-row')await Transaction.create({...first,_id:new mongoose.Types.ObjectId(),fingerprint:'unlisted'});
  if(kind==='monthly-before')m.expectedAccounting.monthlyProjection.beforeSha256='0'.repeat(64);
  if(kind==='monthly-after')m.expectedAccounting.monthlyProjection.afterSha256='0'.repeat(64);
  if(kind==='latest-balance-proof')m.expectedAccounting.balanceProjection.beforeSha256=m.expectedAccounting.balanceProjection.afterSha256='0'.repeat(64);
  if(kind==='changed-original')await fs.writeFile(f.original,'changed source');
  const before=await check.snapshot(mongoose.connection.db);await expect(f.execute()).rejects.toMatchObject({code:kind==='changed-original'?'FINANCE_REPAIR_ORIGINAL_CHANGED':'FINANCE_REPAIR_STATE_CONFLICT'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(before);expect((await f.journal()).phase).toBe('rejected');expect((await access.state()).repair).toBeNull();
});

test('requires served statement-restoration support, separately from printed-card support',async()=>{
  const proof=require('../../src/services/finance/financeRepairCoreProof');await f.replaceServer(require('express')().get('/api/finance/maintenance',async(_req,res)=>res.json({data:{protocol:proof.PROTOCOL,
    databaseIdentity:(await access.state()).identity,capabilities:[proof.LINKED_DOCUMENTS,proof.ISSUER_CORRECTION,proof.PRINTED_CARD_CORRECTION]}})));
  await expect(f.execute()).rejects.toMatchObject({code:'FINANCE_REPAIR_CORE_UNQUALIFIED'});expect(await check.snapshot(mongoose.connection.db)).toEqual(f.initial);
});

test('preserves later owner categorization instead of deleting the restored row',async()=>{
  await f.execute();await Transaction.updateOne({_id:f.manifest.updates[1].id},{$set:{category:'Later owner choice',manual:true}});const before=await check.snapshot(mongoose.connection.db);
  await expect(f.execute({mode:'rollback'})).rejects.toMatchObject({code:'FINANCE_REPAIR_STATE_CONFLICT'});expect(await check.snapshot(mongoose.connection.db)).toEqual(before);expect((await access.state()).repair).toBeNull();
});

test('retains a new ordinary document proposal and refuses an old rollback that would orphan it',async()=>{
  await f.execute();await docs.documents({ledger:'perso'});const before=await check.snapshot(mongoose.connection.db);expect(before.finance_document_links.length).toBeGreaterThan(f.initial.finance_document_links.length);
  await expect(f.execute({mode:'rollback'})).rejects.toMatchObject({code:'FINANCE_REPAIR_STATE_CONFLICT'});expect(await check.snapshot(mongoose.connection.db)).toEqual(before);
});

test('refuses unreviewed later money before restoring initial absence',async()=>{
  await f.execute();await Transaction.create({...f.manifest.updates[1].set,_id:new mongoose.Types.ObjectId(),date:'2026-01-10',fingerprint:'later'});const before=await check.snapshot(mongoose.connection.db);
  await expect(f.execute({mode:'rollback'})).rejects.toMatchObject({code:'FINANCE_REPAIR_STATE_CONFLICT'});expect(await check.snapshot(mongoose.connection.db)).toEqual(before);
});

test('supports two hundred exact rows and refuses an additional row',()=>{
  const m=f.manifest,a=m.verifiedIdentity.accounts[0];
  const add=i=>a.rows.push({id:id(i),reference:'EOP-L'+(i+10),date:'2025-02-12',description:'Zero source '+i,bankCode:'ZI',columns:{debitCents:0,creditCents:0,feesCents:0},balanceAfterCents:29500,sourceLines:[{line:i+10,text:'Zero source '+i+' 0.00 295.00'}]});
  for(let i=4;i<=200;i++)add(i);f.build();expect(()=>contract.read(f.serialize().bytes,f.serialize().confirmedDigest)).not.toThrow();
  add(201);f.build();expect(()=>contract.read(f.serialize().bytes,f.serialize().confirmedDigest)).toThrow('up to200');
});

test('refuses unsafe intermediate arithmetic even with individually exact source numbers',()=>{
  const a=f.manifest.verifiedIdentity.accounts[0],r=a.rows[0];r.columns.creditCents=Number.MAX_SAFE_INTEGER;r.balanceAfterCents=Number.MAX_SAFE_INTEGER;r.sourceLines[0].text='Example payroll 90071992547409.91';
  expect(()=>contract.read(f.serialize().bytes,f.serialize().confirmedDigest)).toThrow('safe integer cents');
});

test('retains a printed negative withdrawal as a one-cent refund, including its actual sign evidence',async()=>{
  const a=f.manifest.verifiedIdentity.accounts[0],r=a.rows[1];r.description='Example fee refund';r.bankCode='CDT';r.date='2025-02-13';r.columns.debitCents=-1;r.balanceAfterCents=a.closingCents=40001;
  r.sourceLines[0].text='13 FEB CDT Example fee refund     0.01-     400.01';f.build();f.pin();await f.execute();
  expect(await Transaction.findById(r.id).lean()).toMatchObject({amountCents:1,flowCents:1,balanceAfterCents:40001});
});

test('retains an interest-only repayment as zero change to the debt principal',async()=>{
  const a=f.manifest.verifiedIdentity.accounts[0],loan=f.manifest.verifiedIdentity.accounts[1],r=a.rows[1],principal=loan.rows[0];
  r.columns.debitCents=500;r.balanceAfterCents=a.closingCents=39500;r.sourceLines[0].text='12 FEB RA Example loan payment     5.00     395.00';
  principal.columns.principalRepaidCents=0;principal.balanceAfterCents=loan.closingCents=50000;principal.sourceLines[0].text='12 FEB REC Example repayment    5.00    0.00    500.00';
  f.build();f.pin();await f.execute();expect(await Transaction.findById(principal.id).lean()).toMatchObject({amountCents:0,flowCents:0,balanceAfterCents:50000});
});

test('refuses a column sign change that the source does not print',()=>{
  f.manifest.verifiedIdentity.accounts[0].rows[1].columns.debitCents=-10500;f.build();
  expect(()=>contract.read(f.serialize().bytes,f.serialize().confirmedDigest)).toThrow('source lines');
});

async function killAt(mode,stop,index){
  const file=f.temp+'/manifest.json';await fs.writeFile(file,f.serialize().bytes);
  const child=fork(path.join(__dirname,'../fixtures/financeRepairProcess.cjs'),[process.env.MONGODB_URI,f.options.receiptRoot,f.options.archiveRoot,file,mode,stop,String(index),f.options.coreOrigin],{stdio:['ignore','ignore','ignore','ipc'],env:{...process.env}});
  const [message]=await once(child,'message');const exited=once(child,'exit');child.kill('SIGKILL');await exited;expect(message).toMatchObject({checkpoint:stop,index});
}
test('resumes actual death after statement insertion and a later row, then reverses once after interrupted deletion',async()=>{
  await killAt('apply','applied_step',0);await killAt('resume','applied_step',2);expect((await f.execute({mode:'resume'})).phase).toBe('applied');
  expect(await Statement.countDocuments({_id:f.manifest.updates[0].id})).toBe(1);await killAt('rollback','rollback_step',2);expect((await f.execute({mode:'resume'})).phase).toBe('rolled_back');expect(await check.snapshot(mongoose.connection.db)).toEqual(f.initial);
});
test.each([0,1])('never repeats uncertain insertion at index%s until the exact late effect arrives',async index=>{
  await killAt('apply','dispatch_saved',index);const before=await check.snapshot(mongoose.connection.db);
  for(const mode of ['resume','rollback'])await expect(f.execute({mode})).rejects.toMatchObject({code:'FINANCE_REPAIR_WRITE_UNCERTAIN'});expect(await check.snapshot(mongoose.connection.db)).toEqual(before);
  const journal=await f.journal();await mongoose.connection.db.collection(f.manifest.updates[index].collection).insertOne(journal.after[index]);expect((await f.execute({mode:'resume'})).phase).toBe('applied');
});
test('keeps uncertain final statement deletion fenced until that native effect is independently received',async()=>{
  await f.execute();await killAt('rollback','dispatch_saved',0);await expect(f.execute({mode:'resume'})).rejects.toMatchObject({code:'FINANCE_REPAIR_WRITE_UNCERTAIN'});
  await Statement.collection.deleteOne({_id:new mongoose.Types.ObjectId(f.manifest.updates[0].id)});expect((await f.execute({mode:'resume'})).phase).toBe('rolled_back');expect(await check.snapshot(mongoose.connection.db)).toEqual(f.initial);
});
test('counts only the actually inserted statement when reversing a partial restoration',async()=>{
  await killAt('apply','applied_step',0);expect(await f.execute({mode:'rollback'})).toMatchObject({documents:1,deleted:1,inserted:0,updated:0});expect(await check.snapshot(mongoose.connection.db)).toEqual(f.initial);
});
