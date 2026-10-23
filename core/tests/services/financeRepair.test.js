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
const access = require('../../src/services/finance/financeAccess');
const storage = require('../../src/services/finance/financeRepairStorage');
const check = require('../../src/services/finance/financeRepairChecks');
const query = require('../../src/services/finance/financeQueryService');
const { applyRules } = require('../../src/services/finance/financeCategories');

let temp, options, initial, manifest, server, consoleSpy;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; };
beforeEach(async () => {
  consoleSpy=jest.spyOn(console,'error').mockImplementation(()=>{});
  for (const name of [...require('../../src/services/finance/financeRepairManifest').COLLECTIONS,'finance_repairs','finance_coordination']) {
    await mongoose.connection.db.collection(name).deleteMany({});
  }
  await Promise.all([Statement.syncIndexes(),Transaction.syncIndexes(),Override.syncIndexes(),Link.syncIndexes()]);
  temp = await fs.mkdtemp(path.join(os.tmpdir(),'finance-repair-test-'));
  const archive = path.join(temp,'archive'); await fs.mkdir(archive);
  const original = path.join(archive,'original.pdf'); await fs.writeFile(original,'synthetic reviewed PDF');
  const s = await Statement.create({issuer:'Bank Example', accountLast4:null,status:'reconciled',
    statementKey:'bank-example|-|2025-09-01|2025-09-30',periodStart:'2025-09-01',periodEnd:'2025-09-30',
    fileName:'original.pdf',fileSha256:storage.hash('synthetic reviewed PDF'),archivePath:original,
    accounts:[{code:'EOP',accountKey:'bank-example|-|EOP',openingCents:120000,closingCents:0,transactionCount:1},
      {code:'CS',accountKey:'bank-example|-|CS',openingCents:500,closingCents:500,transactionCount:0}]});
  const t = await Transaction.create({statementId:s._id,accountKey:'bank-example|-|EOP',accountCode:'EOP',date:'2025-09-04',
    description:'Example transfer',amountCents:-120000,flowCents:-120000,balanceAfterCents:0,fingerprint:'0123456789abcdef01234567',occurrence:1,
    category:'Impôts',tags:['to-check'],manual:true});
  const o = await Override.create({accountKey:t.accountKey,date:t.date,fingerprint:t.fingerprint,occurrence:1,category:t.category,tags:t.tags,createdBy:'owner'});
  // Legacy personal rows have no ledger field. Rollback must restore absence,
  // not add the schema's current default.
  await mongoose.connection.db.collection('finance_statements').updateOne({_id:s._id},{$unset:{ledger:''}});
  await mongoose.connection.db.collection('finance_transactions').updateOne({_id:t._id},{$unset:{ledger:''}});
  // Later statements keep this single historical repair out of current balances.
  for (const ledger of ['perso','corp']) {
    const prefix = ledger === 'corp' ? 'corp:' : '';
    await Statement.create({issuer:'Bank Example',ledger,status:'reconciled',fileName:ledger+'.pdf',fileSha256:storage.hash(ledger),
      statementKey:prefix+'bank-example|-|2026-01-01|2026-01-31',periodStart:'2026-01-01',periodEnd:'2026-01-31',
      accounts:[{code:'EOP',accountKey:prefix+'bank-example|-|EOP',openingCents:1000,closingCents:1000,transactionCount:0},
        {code:'CS',accountKey:prefix+'bank-example|-|CS',openingCents:500,closingCents:500,transactionCount:0}]});
  }
  await Link.create({key:'unrelated|other',documentId:'unrelated',transactionKey:'other',status:'rejected',decidedBy:'owner'});
  const before = [];
  for(const [collection,doc] of [['finance_statements',s],['finance_transactions',t],['finance_overrides',o]]) before.push(storage.plain(await mongoose.connection.db.collection(collection).findOne({_id:doc._id})));
  const sets = [{ledger:'corp',statementKey:'corp:'+s.statementKey,'accounts.0.accountKey':'corp:bank-example|-|EOP','accounts.1.accountKey':'corp:bank-example|-|CS'},
    {ledger:'corp',accountKey:'corp:bank-example|-|EOP'},{accountKey:'corp:bank-example|-|EOP'}];
  manifest = {schemaVersion:1,requestKey:'synthetic-book-repair-v1',verifiedIdentity:{ledger:'corp',issuer:s.issuer,last4:'1234',
    periodStart:s.periodStart,periodEnd:s.periodEnd,pdfSha256:s.fileSha256,originalArchivePath:original},legacyIdentityRetained:{accountLast4:null},
  expectedAccounting:{latestBalancesExpectedUnchangedInBothLedgers:true},updates:before.map((doc,i) => ({collection:['finance_statements','finance_transactions','finance_overrides'][i],
    id:doc._id,before:doc,expectedBeforeSha256:storage.hash(doc),set:sets[i],setAtExecution:{updatedAt:'receipt.appliedAtUtc'},insert:false,upsert:false,matchCountRequired:1}))};
  const bytes = Buffer.from(JSON.stringify(manifest));
  const app=require('express')().use('/api/finance',require('../../routes/finance')());
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  options={bytes,confirmedDigest:storage.hash(bytes),mode:'apply',actor:'synthetic-test',receiptRoot:path.join(temp,'receipts'),archiveRoot:archive,
    coreOrigin:'http://127.0.0.1:'+server.address().port};
  initial = await check.snapshot(mongoose.connection.db);
});
afterEach(async () => { await new Promise(r=>server.close(r));consoleSpy.mockRestore();await fs.rm(temp,{recursive:true,force:true}); });
const execute = (extra={}) => createExecutor().execute({...options,...extra});
async function journal() { return mongoose.connection.db.collection('finance_repairs').findOne({_id:manifest.requestKey}); }
async function expectClosed() {
  await expect(query.monthly()).rejects.toMatchObject({code:'FINANCE_MAINTENANCE'});
  await expect(Transaction.updateMany({},{$set:{category:'Autres'}})).rejects.toMatchObject({code:'FINANCE_MAINTENANCE'});
  await expect(Transaction.insertMany([{...manifest.updates[1].before,_id:new mongoose.Types.ObjectId()}])).rejects.toMatchObject({code:'FINANCE_MAINTENANCE'});
}

test('applies only the three images, preserves the owner decision and replays the same terminal receipt',async () => {
  const receipt=await execute();
  expect(receipt).toMatchObject({phase:'applied',documents:3,arithmeticResidualCents:0,latestBalancesUnchanged:true});
  expect((await Statement.findById(manifest.updates[0].id).lean()).ledger).toBe('corp');
  const transaction=await Transaction.findById(manifest.updates[1].id).lean();
  expect(transaction).toMatchObject({ledger:'corp',category:'Impôts',tags:['to-check'],manual:true});
  expect((await applyRules({_id:transaction._id})).changed).toBe(0);
  const after=await check.snapshot(mongoose.connection.db);
  for (const name of ['finance_document_links','finance_rules','finance_plan','finance_alerts']) expect(after[name]).toEqual(initial[name]);
  expect(await execute({mode:'resume'})).toEqual(receipt);
  expect((await journal()).applyReceipt.completedAt).toBeInstanceOf(Date);
  expect((await access.state()).repair).toBeNull();
});

test('drains existing readers and blocks new API, model, scan and stream work',async () => {
  const started=deferred(), finish=deferred();
  const admitted=access.withAccess(async()=>{started.resolve();await finish.promise;});
  await started.promise;
  await expect(execute()).rejects.toMatchObject({code:'FINANCE_REPAIR_DRAINING'});
  await expectClosed();
  const app=require('express')().use('/api/finance',require('../../routes/finance')());
  const request=require('supertest');
  for (const endpoint of ['statements','balances','inbox','export.csv']) await request(app).get('/api/finance/'+endpoint).expect(503);
  await request(app).post('/api/finance/inbox/scan').expect(503);
  const inbox=require('../../src/services/finance/financeInboxService').createFinanceInbox({env:{FINANCE_INBOX_PATH:options.archiveRoot,FINANCE_ARCHIVE_PATH:options.archiveRoot}});
  await expect(inbox.scanOnce()).rejects.toMatchObject({code:'FINANCE_MAINTENANCE'});
  finish.resolve();await admitted;
  expect((await execute({mode:'resume'})).phase).toBe('applied');
});

test.each(['before-image','destination','original','missing-original','links'])('refuses %s drift without an accounting write',async kind => {
  if(kind==='before-image')await Transaction.updateOne({_id:manifest.updates[1].id},{$set:{tags:['changed']}});
  if(kind==='destination')await Override.create({...manifest.updates[2].before,_id:new mongoose.Types.ObjectId(),accountKey:'corp:bank-example|-|EOP'});
  if(kind==='original')await fs.writeFile(manifest.verifiedIdentity.originalArchivePath,'different PDF');
  if(kind==='missing-original')await fs.unlink(manifest.verifiedIdentity.originalArchivePath);
  if(kind==='links')await Link.create({key:'doc|'+require('../../src/services/finance/financeRepairManifest').keyOf(manifest.updates[1].before),documentId:'doc',transactionKey:require('../../src/services/finance/financeRepairManifest').keyOf(manifest.updates[1].before)});
  const before=await check.snapshot(mongoose.connection.db);
  await expect(execute()).rejects.toMatchObject({code:kind.includes('original')?'FINANCE_REPAIR_ORIGINAL_CHANGED':'FINANCE_REPAIR_STATE_CONFLICT'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(before);
  expect((await access.state()).repair).toBeNull();
  expect((await journal()).phase).toBe('rejected');
});

test('requires the reviewed digest and rejects arbitrary mutation expressions',async()=>{
  await expect(execute({confirmedDigest:'0'.repeat(64)})).rejects.toMatchObject({code:'FINANCE_REPAIR_CONFIRMATION_REQUIRED'});
  manifest.updates[1].set.amountCents=1;
  const bytes=Buffer.from(JSON.stringify(manifest));
  await expect(execute({bytes,confirmedDigest:storage.hash(bytes)})).rejects.toMatchObject({code:'FINANCE_REPAIR_MANIFEST_INVALID'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(initial);
});

test('restores the exact before images, including missing legacy fields, and keeps both receipts',async()=>{
  await execute();
  const receipt=await execute({mode:'rollback'});
  expect(receipt).toMatchObject({phase:'rolled_back',documents:3,exactBeforeImagesRestored:true});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(initial);
  expect(Object.hasOwn((await check.snapshot(mongoose.connection.db)).finance_statements.find(x=>String(x._id)===manifest.updates[0].id),'ledger')).toBe(false);
  expect((await journal()).applyReceipt.phase).toBe('applied');
  expect((await journal()).rollbackReceipt.phase).toBe('rolled_back');
  expect(await execute({mode:'resume'})).toEqual(receipt);
});

test('rollback refuses a later owner decision without overwriting it',async()=>{
  await execute();
  await Override.updateOne({_id:manifest.updates[2].id},{$set:{tags:['new-owner-decision']}});
  const before=await check.snapshot(mongoose.connection.db);
  await expect(execute({mode:'rollback'})).rejects.toMatchObject({code:'FINANCE_REPAIR_STATE_CONFLICT'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(before);
  expect((await access.state()).repair).toBeNull();
});

test('two executors cannot run simultaneously, even with the same request key',async()=>{
  const entered=deferred(),finish=deferred();
  const first=createExecutor({checkpoint:async name=>{if(name==='fenced'){entered.resolve();await finish.promise;}}}).execute(options);
  await entered.promise;
  await expect(execute({mode:'resume'})).rejects.toMatchObject({code:'FINANCE_EXECUTOR_BUSY'});
  await expectClosed();
  finish.resolve();expect((await first).phase).toBe('applied');
});

test('another receipt root cannot bypass the registered kernel lock',async()=>{
  await execute();
  await expect(execute({receiptRoot:path.join(temp,'alternate-root')})).rejects.toMatchObject({code:'FINANCE_EXECUTOR_ROOT_CONFLICT'});
  const copied=path.join(temp,'copied-root');
  await fs.cp(options.receiptRoot,copied,{recursive:true});
  await fs.chmod(copied,0o700);
  await expect(execute({receiptRoot:copied})).rejects.toMatchObject({code:'FINANCE_EXECUTOR_ROOT_CONFLICT'});
});

test('changed content under a used request key is refused rather than substituted',async()=>{
  await execute();
  const changed=Buffer.from(JSON.stringify({...manifest,note:'different reviewed intent'}));
  await expect(execute({bytes:changed,confirmedDigest:storage.hash(changed)})).rejects.toMatchObject({code:'FINANCE_REPAIR_INTENT_CONFLICT'});
});

test('a served Core which still allows Finance cannot start accounting dispatch',async()=>{
  const fake=require('express')();
  fake.get('/api/finance/maintenance',async(_req,res)=>res.json({data:{protocol:require('../../src/services/finance/financeRepairCoreProof').PROTOCOL,databaseIdentity:(await access.state()).identity}}));
  fake.get('/api/finance/inbox',(_req,res)=>res.json({status:'success'}));
  const old=fake.listen(0,'127.0.0.1');await once(old,'listening');
  try{
    await expect(execute({coreOrigin:'http://127.0.0.1:'+old.address().port})).rejects.toMatchObject({code:'FINANCE_REPAIR_CORE_UNQUALIFIED'});
    expect(await check.snapshot(mongoose.connection.db)).toEqual(initial);
    expect((await access.state()).repair).toBeNull();
  }finally{await new Promise(r=>old.close(r));}
});

test('a rejected parent waits for admitted sibling operations to settle',async()=>{
  const started=deferred(),finish=deferred();
  const operation=access.withAccess(async()=>{
    access.withAccess(async()=>{started.resolve();await finish.promise;});
    await started.promise;
    throw new Error('parent failed');
  });
  const settled=operation.catch(e=>e.message);
  await started.promise;
  await expect(execute()).rejects.toMatchObject({code:'FINANCE_REPAIR_DRAINING'});
  expect((await access.state()).readers.length).toBe(1);
  finish.resolve();expect(await settled).toBe('parent failed');
  expect((await execute({mode:'resume'})).phase).toBe('applied');
});

test('a paused streaming export holds admission until cancellation closes its cursor',async()=>{
  const statement=await Statement.create({issuer:'Other Bank',ledger:'perso',status:'reconciled',fileName:'other.pdf',fileSha256:storage.hash('other'),statementKey:'other|-|2024-01-01|2024-01-31',
    periodStart:'2024-01-01',periodEnd:'2024-01-31',accounts:[{code:'CARD',accountKey:'other|-|CARD',openingCents:0,closingCents:600,transactionCount:600}]});
  await Transaction.insertMany(Array.from({length:600},(_,i)=>({statementId:statement._id,accountKey:'other|-|CARD',accountCode:'CARD',date:'2024-01-02',description:'Example purchase',amountCents:1,flowCents:-1,fingerprint:'abcdef0123456789abcdef01',occurrence:i+1})));
  const exported=await require('../../src/services/finance/financeExport').exportCsv();
  await exported.chunks.next();
  await expect(execute()).rejects.toMatchObject({code:'FINANCE_REPAIR_DRAINING'});
  await exported.chunks.return();
  expect((await execute({mode:'resume'})).phase).toBe('applied');
});

test('an uncertain partial repair retains exclusion when unrelated data drifted',async()=>{
  await expect(createExecutor({checkpoint:async(name,d)=>{if(name==='applied_step'&&d.index===0)throw new Error('lost response');}}).execute(options)).rejects.toThrow('lost response');
  // Simulate an external native database writer, outside supported Finance APIs.
  await mongoose.connection.db.collection('finance_rules').insertOne({pattern:'externally changed'});
  await expect(execute({mode:'resume'})).rejects.toMatchObject({code:'FINANCE_REPAIR_STATE_CONFLICT'});
  await expectClosed();
  expect((await access.state()).repair.requestKey).toBe(manifest.requestKey);
});

async function killAt(mode,name,index='-') {
  const file=path.join(temp,'manifest.json');await fs.writeFile(file,options.bytes);
  const child=fork(path.join(__dirname,'../fixtures/financeRepairProcess.cjs'),[process.env.MONGODB_URI,options.receiptRoot,options.archiveRoot,file,mode,name,String(index),options.coreOrigin],
    {stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,NODE_ENV:'test'}});
  const result=await Promise.race([once(child,'message').then(([m])=>m),once(child,'exit').then(()=>({error:'child exited before checkpoint'}))]);
  if(result.error){child.kill('SIGKILL');throw new Error(result.error);}
  expect(result.checkpoint).toBe(name);
  child.kill('SIGKILL');await once(child,'exit');
}
async function resume(extra={}) {
  for(let i=0;i<100;i++) {
    try{return await execute({mode:'resume',...extra});}catch(e){if(e.code!=='FINANCE_EXECUTOR_BUSY')throw e;await new Promise(r=>setTimeout(r,10));}
  }
  throw new Error('OS process lock did not settle');
}
test.each([['fenced','-'],['backup_saved','-'],['intent_saved','-'],['applied_step',0],['applied_step',1],['applied_step',2],['verified','-'],['terminal_saved','-']])(
  'SIGKILL at %s/%s reconciles under the same identity',async(name,index)=>{
    await killAt('apply',name,index);await expectClosed();
    expect((await resume()).phase).toBe('applied');
    expect(await Transaction.countDocuments()).toBe(1);
    expect((await journal())._id).toBe(manifest.requestKey);
  }
);
test.each([['rollback_intent_saved','-'],['rollback_step',2],['rollback_step',1],['rollback_step',0],['terminal_saved','-']])(
  'SIGKILL during rollback at %s/%s resumes rollback, not forward application',async(name,index)=>{
    await execute();await killAt('rollback',name,index);await expectClosed();
    expect((await resume()).phase).toBe('rolled_back');
    expect(await check.snapshot(mongoose.connection.db)).toEqual(initial);
  }
);

test('terminal recovery retains its process lock until receipt publication and release settle',async()=>{
  await killAt('apply','terminal_saved');
  const entered=deferred(),finish=deferred();
  const immutable=storage.immutable;
  const spy=jest.spyOn(storage,'immutable').mockImplementation(async(file,value)=>{
    if(file.endsWith('/applied.json')){entered.resolve();await finish.promise;}
    return immutable(file,value);
  });
  try{
    const recovered=resume();
    await entered.promise;
    await expect(execute({mode:'rollback'})).rejects.toMatchObject({code:'FINANCE_EXECUTOR_BUSY'});
    finish.resolve();
    expect((await recovered).phase).toBe('applied');
  }finally{finish.resolve();spy.mockRestore();}
});

test.each(['apply','rollback'])('an unanswered %s dispatch stays fenced until its exact effect is observed',async direction=>{
  if(direction==='rollback')await execute();
  const before=await check.snapshot(mongoose.connection.db);
  await killAt(direction,'dispatch_saved',direction==='apply'?0:2);
  await expect(resume()).rejects.toMatchObject({code:'FINANCE_REPAIR_WRITE_UNCERTAIN'});
  if(direction==='apply')await expect(execute({mode:'rollback'})).rejects.toMatchObject({code:'FINANCE_REPAIR_WRITE_UNCERTAIN'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(before);
  await expectClosed();
  // Represent the late native outcome of the one issued command. No retry was
  // dispatched while its outcome was uncertain. Once observed, recovery can
  // acknowledge that effect and continue without writing this step again.
  const record=await journal(),i=direction==='apply'?0:2;
  await mongoose.connection.db.collection(manifest.updates[i].collection).replaceOne(
    {_id:new mongoose.Types.ObjectId(manifest.updates[i].id)},direction==='apply'?record.after[i]:record.before[i]);
  expect((await resume()).phase).toBe(direction==='apply'?'applied':'rolled_back');
  if(direction==='rollback')expect(await check.snapshot(mongoose.connection.db)).toEqual(initial);
});

test('a lost reply after release replays the saved receipt without another mutation',async()=>{
  await killAt('apply','released');
  expect((await access.state()).repair).toBeNull();
  const before=await check.snapshot(mongoose.connection.db);
  const receipt=await resume();
  expect(receipt.phase).toBe('applied');
  expect(await check.snapshot(mongoose.connection.db)).toEqual(before);
});

test('a process stopped before fencing reuses its saved intent and rechecks the current before images',async()=>{
  await killAt('apply','journal_created');
  expect((await access.state()).repair).toBeNull();
  expect((await resume()).phase).toBe('applied');
});
