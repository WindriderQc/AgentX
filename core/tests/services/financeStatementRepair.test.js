'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const mongoose = require('mongoose');
const Statement = require('../../models/FinanceStatement');
const Transaction = require('../../models/FinanceTransaction');
const Override = require('../../models/FinanceOverride');
const Link = require('../../models/FinanceDocumentLink');
const { createExecutor } = require('../../src/services/finance/financeRepairExecutor');
const contract = require('../../src/services/finance/financeRepairManifest');
const access = require('../../src/services/finance/financeAccess');
const storage = require('../../src/services/finance/financeRepairStorage');
const check = require('../../src/services/finance/financeRepairChecks');

let temp, server, manifest, options, initial, consoleSpy;
const serialize = () => {
  const bytes = Buffer.from(JSON.stringify(manifest));
  return {bytes,confirmedDigest:storage.hash(bytes)};
};
const execute = (extra={}) => createExecutor().execute({...options,...serialize(),...extra});
const journal = () => mongoose.connection.db.collection('finance_repairs').findOne({_id:manifest.requestKey});
function update(collection,before,set) {
  return {collection,id:before._id,before,expectedBeforeSha256:storage.hash(before),set,
    setAtExecution:{updatedAt:'receipt.appliedAtUtc'},insert:false,upsert:false,matchCountRequired:1};
}
beforeEach(async () => {
  consoleSpy=jest.spyOn(console,'error').mockImplementation(()=>{});
  for (const name of [...contract.COLLECTIONS,'finance_repairs','finance_coordination']) await mongoose.connection.db.collection(name).deleteMany({});
  await Promise.all([Statement.syncIndexes(),Transaction.syncIndexes(),Override.syncIndexes(),Link.syncIndexes()]);
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'finance-statement-repair-test-'));
  const archive=path.join(temp,'archive');await fs.mkdir(archive);
  const original=path.join(archive,'original.pdf');await fs.writeFile(original,'synthetic complete statement');
  const statement=await Statement.create({issuer:'Example Bank',accountLast4:null,status:'reconciled',
    statementKey:'example|-|2025-08-01|2025-08-31',periodStart:'2025-08-01',periodEnd:'2025-08-31',
    fileName:'original.pdf',fileSha256:storage.hash('synthetic complete statement'),archivePath:original,
    accounts:[{code:'EOP',accountKey:'example|-|EOP',openingCents:10000,closingCents:12575,transactionCount:3},
      {code:'CS',accountKey:'example|-|CS',openingCents:700,closingCents:700,transactionCount:0}]});
  // ID order deliberately differs from printed order for these same-day rows.
  const ids=['000000000000000000000003','000000000000000000000001','000000000000000000000002'];
  const rows=await Transaction.create([5000,-2300,-125].map((amountCents,i)=>({_id:ids[i],statementId:statement._id,
    accountKey:'example|-|EOP',accountCode:'EOP',date:'2025-08-12',description:'Example row '+i,
    amountCents,flowCents:amountCents,balanceAfterCents:[15000,12700,12575][i],fingerprint:'example-row-'+i,occurrence:1,
    category:['Revenus','Impôts','Frais'][i],tags:['reviewed-'+i],manual:false})));
  await mongoose.connection.db.collection('finance_statements').updateOne({_id:statement._id},{$unset:{ledger:''}});
  await mongoose.connection.db.collection('finance_transactions').updateMany({statementId:statement._id},{$unset:{ledger:''}});
  // Later statements keep this historical move out of current balances.
  for(const ledger of ['perso','corp']) {
    const prefix=ledger==='corp'?'corp:':'';
    await Statement.create({issuer:'Example Bank',ledger,status:'reconciled',fileName:ledger+'.pdf',fileSha256:storage.hash(ledger),
      statementKey:prefix+'example|-|2026-01-01|2026-01-31',periodStart:'2026-01-01',periodEnd:'2026-01-31',
      accounts:[{code:'EOP',accountKey:prefix+'example|-|EOP',openingCents:25000,closingCents:25000,transactionCount:0},
        {code:'CS',accountKey:prefix+'example|-|CS',openingCents:700,closingCents:700,transactionCount:0}]});
  }
  await Link.create({key:'unrelated|decision',documentId:'unrelated',transactionKey:'unrelated',status:'confirmed',decidedBy:'owner'});
  await mongoose.connection.db.collection('finance_repairs').insertOne({_id:'previous-v1-receipt',phase:'applied',
    applyReceipt:{schema:'agentx.finance-repair/v1',documents:3,completedAt:new Date('2026-01-01')}});
  initial=await check.snapshot(mongoose.connection.db);
  const s=storage.plain(initial.finance_statements.find(s=>String(s._id)===String(statement._id)));
  const tx=initial.finance_transactions.map(storage.plain);
  manifest={schemaVersion:2,requestKey:'synthetic-statement-repair-v2',verifiedIdentity:{ledger:'corp',issuer:s.issuer,last4:'1234',
    periodStart:s.periodStart,periodEnd:s.periodEnd,pdfSha256:s.fileSha256,originalArchivePath:original,
    transactionOrder:{EOP:rows.map(t=>String(t._id)),CS:[]}},legacyIdentityRetained:{accountLast4:null},
    expectedAccounting:{latestBalancesExpectedUnchangedInBothLedgers:true},updates:[
      update('finance_statements',s,{ledger:'corp',statementKey:'corp:'+s.statementKey,
        'accounts.0.accountKey':'corp:example|-|EOP','accounts.1.accountKey':'corp:example|-|CS'}),
      ...tx.map(t=>update('finance_transactions',t,{ledger:'corp',accountKey:'corp:'+t.accountKey}))]};
  const app=require('express')().use('/api/finance',require('../../routes/finance')());
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  options={mode:'apply',actor:'synthetic-test',receiptRoot:path.join(temp,'receipts'),archiveRoot:archive,
    coreOrigin:'http://127.0.0.1:'+server.address().port};
});
afterEach(async()=>{await new Promise(r=>server.close(r));consoleSpy.mockRestore();await fs.rm(temp,{recursive:true,force:true});});

test('moves the whole row set without creating decisions and restores exact legacy images',async()=>{
  const previous=await mongoose.connection.db.collection('finance_repairs').findOne({_id:'previous-v1-receipt'});
  const balances=await check.nativeViews();
  const receipt=await execute();
  expect(receipt).toMatchObject({phase:'applied',documents:4,inserted:0,deleted:0,arithmeticResidualCents:0,latestBalancesUnchanged:true});
  const state=await check.snapshot(mongoose.connection.db);
  expect(state).toEqual(check.derive(initial,manifest,check.typedAfter(check.images(initial,manifest),manifest,new Date(receipt.appliedAtUtc))));
  expect(state.finance_overrides).toHaveLength(0);
  expect(await check.nativeViews()).toEqual(balances);
  expect(await mongoose.connection.db.collection('finance_repairs').findOne({_id:'previous-v1-receipt'})).toEqual(previous);
  expect(await execute({mode:'resume'})).toEqual(receipt);
  expect(await execute({mode:'rollback'})).toMatchObject({phase:'rolled_back',documents:4,exactBeforeImagesRestored:true});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(initial);
  expect((await access.state()).repair).toBeNull();
});

test('retains existing manual decisions alongside automatic categories and tags',async()=>{
  const u=manifest.updates[2];
  await Transaction.updateOne({_id:u.id},{$set:{manual:true}});
  const row=storage.plain(await mongoose.connection.db.collection('finance_transactions').findOne({_id:new mongoose.Types.ObjectId(u.id)}));
  manifest.updates[2]=update(u.collection,row,u.set);
  const decision=await Override.create({...Object.fromEntries(['accountKey','date','fingerprint','occurrence','category','tags'].map(k=>[k,row[k]])),createdBy:'owner'});
  const before=storage.plain(await mongoose.connection.db.collection('finance_overrides').findOne({_id:decision._id}));
  manifest.updates.push(update('finance_overrides',before,{accountKey:'corp:'+before.accountKey}));
  const baseline=await check.snapshot(mongoose.connection.db);
  expect((await execute()).documents).toBe(5);
  expect(storage.plain(await Override.findById(decision._id).lean())).toEqual({...before,accountKey:'corp:'+before.accountKey,updatedAt:(await journal()).appliedAt.toISOString()});
  expect((await execute({mode:'rollback'})).documents).toBe(5);
  expect(await check.snapshot(mongoose.connection.db)).toEqual(baseline);
});

test('accepts the explicit fifty-row/fifty-decision bound with exact running balances',()=>{
  const sample=manifest.updates[1].before;
  const rows=Array.from({length:50},(_,i)=>({...sample,_id:(i+1).toString(16).padStart(24,'0'),
    fingerprint:'bounded-row-'+i,amountCents:1,flowCents:1,balanceAfterCents:10001+i,manual:true}));
  const s=structuredClone(manifest.updates[0].before);
  s.accounts[0].transactionCount=50;s.accounts[0].closingCents=10050;
  manifest.verifiedIdentity.transactionOrder.EOP=rows.map(t=>t._id);
  manifest.updates=[update('finance_statements',s,manifest.updates[0].set),
    ...rows.map(t=>update('finance_transactions',t,{ledger:'corp',accountKey:'corp:'+t.accountKey})),
    ...rows.map((t,i)=>update('finance_overrides',{...t,_id:(i+100).toString(16).padStart(24,'0')},{accountKey:'corp:'+t.accountKey}))];
  expect(manifest.updates).toHaveLength(101);
  expect(contract.read(serialize().bytes,serialize().confirmedDigest).manifest).toEqual(manifest);
});

test('derives reverse corporate-to-personal prefixes without normalizing legacy identities',()=>{
  manifest.verifiedIdentity.ledger='perso';
  for(const u of manifest.updates){
    const b=u.before;b.ledger='corp';
    if(u.collection==='finance_statements'){
      b.statementKey='corp:'+b.statementKey;b.accounts.forEach(a=>{a.accountKey='corp:'+a.accountKey;});
      u.set={ledger:'perso',statementKey:b.statementKey.slice(5),...Object.fromEntries(b.accounts.map((a,i)=>['accounts.'+i+'.accountKey',a.accountKey.slice(5)]))};
    }else{b.accountKey='corp:'+b.accountKey;u.set={ledger:'perso',accountKey:b.accountKey.slice(5)};}
    u.expectedBeforeSha256=storage.hash(b);
  }
  expect(contract.read(serialize().bytes,serialize().confirmedDigest).manifest).toEqual(manifest);
});

test.each(['order','balance','count','missing-row','automatic-decision','extra-set','wrong-flow','missing-empty-account','too-many-rows'])('refuses invalid %s before taking admission',async kind=>{
  if(kind==='order')manifest.verifiedIdentity.transactionOrder.EOP.reverse();
  if(kind==='balance')manifest.updates[1].before.balanceAfterCents++;
  if(kind==='count')manifest.updates[0].before.accounts[0].transactionCount++;
  if(kind==='missing-row')manifest.updates.pop();
  if(kind==='automatic-decision')manifest.updates[1].before.manual=true;
  if(kind==='extra-set')manifest.updates[1].set.category='Autres';
  if(kind==='wrong-flow')manifest.updates[1].before.flowCents*=-1;
  if(kind==='missing-empty-account')delete manifest.verifiedIdentity.transactionOrder.CS;
  if(kind==='too-many-rows')for(let i=0;i<48;i++)manifest.updates.push(structuredClone(manifest.updates[1]));
  for(const u of manifest.updates)u.expectedBeforeSha256=storage.hash(u.before);
  await expect(execute()).rejects.toMatchObject({code:'FINANCE_REPAIR_MANIFEST_INVALID'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(initial);
  expect(await journal()).toBeNull();
});

test.each(['extra-row','missing-row','new-decision','destination-row','destination-statement','source-link','target-link','stored-reference'])('refuses live %s drift before dispatch',async kind=>{
  const row=manifest.updates[1].before;
  if(kind==='extra-row'||kind==='destination-row')await Transaction.create({...row,_id:new mongoose.Types.ObjectId(),
    accountKey:kind==='destination-row'?'corp:'+row.accountKey:row.accountKey,occurrence:kind==='extra-row'?2:row.occurrence});
  if(kind==='missing-row')await Transaction.deleteOne({_id:row._id});
  if(kind==='new-decision')await Override.create({...row,_id:new mongoose.Types.ObjectId()});
  if(kind==='destination-statement')await Statement.create({...manifest.updates[0].before,_id:new mongoose.Types.ObjectId(),statementKey:manifest.updates[0].set.statementKey});
  if(kind.endsWith('link'))await Link.create({key:'new-link',documentId:'new',transactionKey:contract.keyOf({...row,accountKey:(kind==='target-link'?'corp:':'')+row.accountKey})});
  if(kind==='stored-reference')await Link.create({key:'new-link',documentId:'new',transactionKey:'old-format',transaction:{accountKey:row.accountKey,date:row.date}});
  const before=await check.snapshot(mongoose.connection.db);
  await expect(execute()).rejects.toMatchObject({code:'FINANCE_REPAIR_STATE_CONFLICT'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(before);
  expect((await journal()).phase).toBe('rejected');
  expect((await access.state()).repair).toBeNull();
});

async function killAt(mode,name,index) {
  const file=path.join(temp,'manifest.json');await fs.writeFile(file,serialize().bytes);
  const child=fork(path.join(__dirname,'../fixtures/financeRepairProcess.cjs'),[process.env.MONGODB_URI,options.receiptRoot,options.archiveRoot,file,mode,name,String(index),options.coreOrigin],
    {stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,NODE_ENV:'test'}});
  const message=await Promise.race([once(child,'message').then(([m])=>m),once(child,'exit').then(()=>({error:'child exited before checkpoint'}))]);
  if(message.error){child.kill('SIGKILL');throw new Error(message.error);}
  expect(message.checkpoint).toBe(name);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
}

test.each([1,3])('recovers a killed forward writer after row step %s without duplicating effects',async index=>{
  await killAt('apply','applied_step',index);
  expect((await access.state()).repair.requestKey).toBe(manifest.requestKey);
  await expect(require('../../src/services/finance/financeQueryService').monthly()).rejects.toMatchObject({code:'FINANCE_MAINTENANCE'});
  const received=await check.snapshot(mongoose.connection.db);
  expect((await execute({mode:'resume'})).documents).toBe(4);
  const after=await check.snapshot(mongoose.connection.db);
  expect(after.finance_transactions.filter(t=>t.ledger==='corp')).toHaveLength(3);
  for(let i=0;i<=index;i++)expect(check.images(after,manifest)[i]).toEqual(check.images(received,manifest)[i]);
});

test('recovers reverse direction across all rows and follows saved rollback intent',async()=>{
  await execute();
  await killAt('rollback','rollback_step',2);
  expect(await execute({mode:'resume'})).toMatchObject({phase:'rolled_back',documents:4});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(initial);
  expect(Object.keys((await journal()).rollbackSteps)).toHaveLength(4);
});

test('keeps an unanswered later row dispatch closed until its one exact effect arrives',async()=>{
  await killAt('apply','dispatch_saved',2);
  const partial=await check.snapshot(mongoose.connection.db);
  await expect(execute({mode:'resume'})).rejects.toMatchObject({code:'FINANCE_REPAIR_WRITE_UNCERTAIN'});
  await expect(execute({mode:'rollback'})).rejects.toMatchObject({code:'FINANCE_REPAIR_WRITE_UNCERTAIN'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(partial);
  const record=await journal();
  await mongoose.connection.db.collection(manifest.updates[2].collection).replaceOne({_id:new mongoose.Types.ObjectId(manifest.updates[2].id)},record.after[2]);
  expect((await execute({mode:'resume'})).phase).toBe('applied');
  expect((await access.state()).repair).toBeNull();
});
