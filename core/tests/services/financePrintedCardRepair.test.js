'use strict';

const fs=require('node:fs/promises'),path=require('node:path');
const {fork}=require('node:child_process'),{once}=require('node:events');
const mongoose=require('mongoose');
const {fixture}=require('../fixtures/financePrintedCardFixture.cjs');
const storage=require('../../src/services/finance/financeRepairStorage'),check=require('../../src/services/finance/financeRepairChecks');
const contract=require('../../src/services/finance/financeRepairManifest'),money=require('../../src/services/finance/financeMoneyTotals');
const access=require('../../src/services/finance/financeAccess'),documents=require('../../src/services/finance/financeDocumentLinks');
const Transaction=require('../../models/FinanceTransaction'),Override=require('../../models/FinanceOverride'),Link=require('../../models/FinanceDocumentLink');
let f,quiet;
beforeEach(async()=>{quiet=jest.spyOn(console,'error').mockImplementation(()=>{});f=await fixture();});
afterEach(async()=>{if(f)await f.close();quiet.mockRestore();});

test('corrects printed dates/periods and restores only an absent source row, retaining identities, decisions and ambiguous document relation',async()=>{
  const receipt=await f.execute();
  expect(receipt).toMatchObject({schema:'agentx.finance-printed-card-repair/v1',phase:'applied',reviewedDocuments:7,documents:5,
    updated:4,inserted:1,deleted:0,arithmeticResidualCents:0,latestBalancesUnchanged:true,reviewedMonthlyProjectionMatched:true});
  const after=await check.snapshot(mongoose.connection.db);
  expect(after).toEqual(check.derive(f.initial,f.manifest,check.typedAfter(check.images(f.initial,f.manifest),f.manifest,new Date(receipt.appliedAtUtc))));
  expect(after.finance_transactions[1]).toEqual(f.initial.finance_transactions[1]);
  expect(after.finance_transactions[2]).toEqual(f.initial.finance_transactions[2]);
  expect(after.finance_transactions[0]).toMatchObject({date:'2025-06-05',amountCents:3000,flowCents:-3000,category:'Owner category',tags:['owner-tag'],manual:true,balanceAfterCents:null});
  expect(after.finance_transactions[3]).toMatchObject({date:'2025-07-10',amountCents:1250,flowCents:-1250,category:null,tags:[],manual:false,balanceAfterCents:null,
    sourceRepair:{requestKey:f.manifest.requestKey,pdfSha256:f.manifest.verifiedIdentity.pdfSha256,printedReference:'003'}});
  expect(after.finance_overrides[0]).toMatchObject({date:'2025-06-05',createdBy:'owner',category:'Owner category',tags:['owner-tag']});
  expect(after.finance_document_links[0]).toMatchObject({status:'proposed',ambiguous:true,transaction:{date:'2025-06-05'}});
  for(let i=0;i<2;i++)for(const ledger of ['perso','corp'])await documents.documents({ledger});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(after);
  expect(await money.nativeMonthly(mongoose.connection.db)).toEqual(money.projectMonthly(after.finance_transactions));
  expect((await access.state()).repair).toBeNull();
  expect(await f.execute({mode:'resume'})).toEqual(receipt);
});

test('reverses all effects exactly, deleting only its inserted row and preserving initial absence/timestamps',async()=>{
  await f.execute();const result=await f.execute({mode:'rollback'});
  expect(result).toMatchObject({phase:'rolled_back',documents:5,updated:4,inserted:0,deleted:1,exactBeforeImagesRestored:true,reviewedMonthlyProjectionMatched:true});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(f.initial);expect((await access.state()).repair).toBeNull();
});

test.each(['amount','category','manual','invented-balance','statement-total','wrong-key','wrong-ledger','fingerprint','occurrence','extra-insert-field',
  'source-provenance','source-description','source-amount','source-date','duplicate-source-reference','duplicate-source-id','omitted-row','omitted-decision','omitted-link','readonly-timestamp','invalid-date'])('refuses unreviewed %s before any journal or accounting write',async kind=>{
  const m=f.manifest,u=m.updates;
  if(kind==='amount')u[1].set.amountCents=3001;
  if(kind==='category')u[1].set.category='Other';
  if(kind==='manual')u[1].set.manual=false;
  if(kind==='invented-balance')u[1].set.balanceAfterCents=13000;
  if(kind==='statement-total')u[0].set['accounts.0.closingCents']=0;
  if(kind==='wrong-key')u[1].set.accountKey='other|-|CARD';
  if(kind==='wrong-ledger')u[1].set.ledger='corp';
  if(kind==='fingerprint')u[1].set.fingerprint='changed';
  if(kind==='occurrence')u[1].set.occurrence=2;
  if(kind==='extra-insert-field')u[4].set.category='Assigned';
  if(kind==='source-provenance')u[4].set.sourceRepair.printedReference='another';
  if(kind==='source-description')m.verifiedIdentity.printedRows[0].description='Different source';
  if(kind==='source-amount')m.verifiedIdentity.printedRows[0].amountCents++;
  if(kind==='source-date')m.verifiedIdentity.printedRows[0].date='2025-08-05';
  if(kind==='duplicate-source-reference')m.verifiedIdentity.printedRows[1].reference='001';
  if(kind==='duplicate-source-id')m.verifiedIdentity.printedRows[1].id=m.verifiedIdentity.printedRows[0].id;
  if(kind==='omitted-row')u.splice(2,1);
  if(kind==='omitted-decision')m.updates=u.filter(v=>v.collection!=='finance_overrides');
  if(kind==='omitted-link')m.updates=u.filter(v=>v.collection!=='finance_document_links');
  if(kind==='readonly-timestamp')u[2].setAtExecution={updatedAt:'receipt.appliedAtUtc'};
  if(kind==='invalid-date')m.verifiedIdentity.periodStart='2025-02-31';
  await expect(f.execute()).rejects.toMatchObject({code:'FINANCE_REPAIR_MANIFEST_INVALID'});
  expect(await f.journal()).toBeNull();expect(await check.snapshot(mongoose.connection.db)).toEqual(f.initial);
});

test.each(['monthly-before','monthly-after','balance-before','occupied-row','occupied-id','unlisted-row','unlisted-decision','unlisted-link','document-drift','changed-pdf'])('refuses %s drift before dispatch and reopens admission',async kind=>{
  const m=f.manifest;
  if(kind==='monthly-before')m.expectedAccounting.monthlyProjection.beforeSha256='0'.repeat(64);
  if(kind==='monthly-after')m.expectedAccounting.monthlyProjection.afterSha256='0'.repeat(64);
  if(kind==='balance-before')m.expectedAccounting.balanceProjection.beforeSha256=m.expectedAccounting.balanceProjection.afterSha256='0'.repeat(64);
  if(kind==='occupied-row')await Transaction.create({...m.updates[4].set,_id:new mongoose.Types.ObjectId()});
  if(kind==='occupied-id')await Transaction.create({...m.updates[4].set,_id:m.updates[4].id,date:'2024-01-01'});
  if(kind==='unlisted-row')await Transaction.create({...m.updates[2].before,_id:new mongoose.Types.ObjectId(),fingerprint:'unlisted'});
  if(kind==='unlisted-decision')await Override.create({...m.updates[4].set,category:'Owner choice',createdBy:'owner'});
  if(kind==='unlisted-link')await Link.create({...m.updates.at(-1).before,_id:new mongoose.Types.ObjectId(),documentId:'another',key:'another|'+m.updates.at(-1).before.transactionKey});
  if(kind==='document-drift')await f.writeRegister([{...f.rawDocument,kind:'invoice'}]);
  if(kind==='changed-pdf')await fs.writeFile(f.original,'changed source');
  const before=await check.snapshot(mongoose.connection.db);
  await expect(f.execute()).rejects.toMatchObject({code:kind==='document-drift'?'FINANCE_REPAIR_DOCUMENTS_CHANGED':kind==='changed-pdf'?'FINANCE_REPAIR_ORIGINAL_CHANGED':'FINANCE_REPAIR_STATE_CONFLICT'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(before);expect((await f.journal()).phase).toBe('rejected');expect((await access.state()).repair).toBeNull();
});

test('requires installed printed-card capability; a CLI update alone is insufficient',async()=>{
  const proof=require('../../src/services/finance/financeRepairCoreProof');
  await f.replaceServer(require('express')().get('/api/finance/maintenance',async(_req,res)=>res.json({data:{protocol:proof.PROTOCOL,
    databaseIdentity:(await access.state()).identity,capabilities:[proof.LINKED_DOCUMENTS,proof.ISSUER_CORRECTION]}})));
  await expect(f.execute()).rejects.toMatchObject({code:'FINANCE_REPAIR_CORE_UNQUALIFIED'});expect(await check.snapshot(mongoose.connection.db)).toEqual(f.initial);
});

test('refuses a later document decision during old rollback',async()=>{
  await f.execute();await documents.decide(f.manifest.updates.at(-1).id,'confirmed','owner');
  const before=await check.snapshot(mongoose.connection.db);
  await expect(f.execute({mode:'rollback'})).rejects.toMatchObject({code:'FINANCE_REPAIR_STATE_CONFLICT'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(before);expect((await access.state()).repair).toBeNull();
});

test('preserves a later owner categorization of its inserted row instead of deleting it on old rollback',async()=>{
  await f.execute();await Transaction.updateOne({_id:f.manifest.updates[4].id},{$set:{category:'Later owner choice',manual:true}});
  const before=await check.snapshot(mongoose.connection.db);
  await expect(f.execute({mode:'rollback'})).rejects.toMatchObject({code:'FINANCE_REPAIR_STATE_CONFLICT'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(before);expect((await access.state()).repair).toBeNull();
});

test('accepts exactly one hundred reviewed rows and refuses the next one',()=>{
  const m=f.manifest,s=m.updates[0].before;
  function add(i) {
    const id=(i+1).toString(16).padStart(24,'0'),description='Bounded row '+i;
    const p={id,reference:'B'+i,date:'2025-06-15',postingDate:'2025-06-15',description,amountCents:1};
    const row={...m.updates[2].before,_id:id,date:p.date,description,amountCents:1,flowCents:-1,fingerprint:'bounded-'+i,manual:false};
    m.verifiedIdentity.printedRows.push(p);m.updates.push({...m.updates[2],id,before:row,expectedBeforeSha256:storage.hash(row)});
  }
  for(let i=4;i<100;i++)add(i);
  s.accounts[0].transactionCount=100;s.accounts[0].closingCents+=96;m.updates[0].expectedBeforeSha256=storage.hash(s);
  const sort=()=>{const order=['finance_statements','finance_transactions','finance_overrides','finance_document_links'];m.updates.sort((a,b)=>order.indexOf(a.collection)-order.indexOf(b.collection)||a.id.localeCompare(b.id));};sort();
  expect(()=>contract.read(f.serialize().bytes,f.serialize().confirmedDigest)).not.toThrow();
  add(100);sort();s.accounts[0].transactionCount++;s.accounts[0].closingCents++;m.updates[0].expectedBeforeSha256=storage.hash(s);
  expect(()=>contract.read(f.serialize().bytes,f.serialize().confirmedDigest)).toThrow('bounded printed card');
});

test('refuses eleven inserted source rows even within the total row bound',()=>{
  const m=f.manifest,template=m.updates[4],s=m.updates[0].before;
  for(let i=0;i<10;i++) {
    const p={id:(100+i).toString(16).padStart(24,'0'),reference:'N'+i,date:'2025-07-10',postingDate:'2025-07-10',description:'Missing bound '+i,amountCents:1};
    m.verifiedIdentity.printedRows.push(p);m.updates.push({...template,id:p.id,set:require('../../src/services/finance/financePrintedCardContract').newRow(m,p)});
  }
  s.accounts[0].transactionCount=14;s.accounts[0].closingCents+=10;m.updates[0].expectedBeforeSha256=storage.hash(s);
  const order=['finance_statements','finance_transactions','finance_overrides','finance_document_links'];m.updates.sort((a,b)=>order.indexOf(a.collection)-order.indexOf(b.collection)||a.id.localeCompare(b.id));
  expect(()=>contract.read(f.serialize().bytes,f.serialize().confirmedDigest)).toThrow('bounded printed card');
});

test('refuses unsafe intermediate integer arithmetic even when the final mathematical amount is small',()=>{
  const m=f.manifest,s=m.updates[0].before;s.accounts[0].openingCents=0;s.accounts[0].closingCents=1251;
  for(const [index,amount] of [Number.MAX_SAFE_INTEGER,1,-Number.MAX_SAFE_INTEGER].entries()) {
    const u=m.updates[index+1];u.before.amountCents=amount;u.before.flowCents=-amount;u.expectedBeforeSha256=storage.hash(u.before);
    m.verifiedIdentity.printedRows.find(p=>p.id===u.id).amountCents=amount;
  }
  m.updates[0].expectedBeforeSha256=storage.hash(s);
  expect(()=>contract.read(f.serialize().bytes,f.serialize().confirmedDigest)).toThrow('safe integer cents');
});

test('refuses unreviewed later monthly money before rollback',async()=>{
  await f.execute();await Transaction.create({...f.manifest.updates[4].set,_id:new mongoose.Types.ObjectId(),date:'2026-01-01',fingerprint:'new-owner-row'});
  const before=await check.snapshot(mongoose.connection.db);
  await expect(f.execute({mode:'rollback'})).rejects.toMatchObject({code:'FINANCE_REPAIR_STATE_CONFLICT'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(before);expect((await access.state()).repair).toBeNull();
});

async function killAt(mode,stop,index) {
  const file=f.temp+'/manifest.json';await fs.writeFile(file,f.serialize().bytes);
  const child=fork(path.join(__dirname,'../fixtures/financeRepairProcess.cjs'),[process.env.MONGODB_URI,f.options.receiptRoot,f.options.archiveRoot,file,mode,stop,String(index),f.options.coreOrigin],
    {stdio:['ignore','ignore','ignore','ipc'],env:{...process.env}});
  const [message]=await once(child,'message');const exited=once(child,'exit');child.kill('SIGKILL');await exited;expect(message).toMatchObject({checkpoint:stop,index});
}
test('receives one actual insert after SIGKILL without duplicate dispatch, then resumes interrupted reverse deletion',async()=>{
  await killAt('apply','applied_step',4);expect((await f.execute({mode:'resume'})).phase).toBe('applied');
  expect(await Transaction.countDocuments({_id:f.manifest.updates[4].id})).toBe(1);
  await killAt('rollback','rollback_step',4);expect((await f.execute({mode:'resume'})).phase).toBe('rolled_back');
  expect(await check.snapshot(mongoose.connection.db)).toEqual(f.initial);
});

test('keeps uncertain insert held, then receives the exact late original effect without replacement',async()=>{
  await killAt('apply','dispatch_saved',4);const partial=await check.snapshot(mongoose.connection.db);
  for(const mode of ['resume','rollback'])await expect(f.execute({mode})).rejects.toMatchObject({code:'FINANCE_REPAIR_WRITE_UNCERTAIN'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(partial);
  await Transaction.collection.insertOne((await f.journal()).after[4]);
  expect((await f.execute({mode:'resume'})).phase).toBe('applied');expect(await Transaction.countDocuments({_id:f.manifest.updates[4].id})).toBe(1);
});

test('keeps uncertain reverse deletion held until the native deletion is received',async()=>{
  await f.execute();await killAt('rollback','dispatch_saved',4);
  await expect(f.execute({mode:'resume'})).rejects.toMatchObject({code:'FINANCE_REPAIR_WRITE_UNCERTAIN'});
  await Transaction.collection.deleteOne({_id:new mongoose.Types.ObjectId(f.manifest.updates[4].id)});
  expect((await f.execute({mode:'resume'})).phase).toBe('rolled_back');expect(await check.snapshot(mongoose.connection.db)).toEqual(f.initial);
});

test('reverses a partially applied date correction without claiming to delete an undispatched insertion',async()=>{
  await killAt('apply','applied_step',1);
  expect(await f.execute({mode:'rollback'})).toMatchObject({phase:'rolled_back',documents:2,updated:2,deleted:0,inserted:0});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(f.initial);
});
