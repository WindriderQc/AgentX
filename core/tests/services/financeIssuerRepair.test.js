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
const access = require('../../src/services/finance/financeAccess');
const storage = require('../../src/services/finance/financeRepairStorage');
const check = require('../../src/services/finance/financeRepairChecks');
const contract = require('../../src/services/finance/financeRepairManifest');
const balances = require('../../src/services/finance/financeRepairBalanceProof');
const documents = require('../../src/services/finance/financeDocumentLinks');
const register = require('../../src/services/finance/financeDocumentRegister');
const linkContract = require('../../src/services/finance/financeRepairLinkContract');
const { createExecutor } = require('../../src/services/finance/financeRepairExecutor');

let temp, server, manifest, options, initial, rawDocument, previousRegister, previousNames, consoleSpy;
const serialize = () => { const bytes=Buffer.from(JSON.stringify(manifest)); return {bytes,confirmedDigest:storage.hash(bytes)}; };
const execute = (extra={}) => createExecutor().execute({...options,...serialize(),...extra});
const update = (collection,before,set) => ({collection,id:before._id,before,expectedBeforeSha256:storage.hash(before),set,
  setAtExecution:{updatedAt:'receipt.appliedAtUtc'},insert:false,upsert:false,matchCountRequired:1});
const journal = () => mongoose.connection.db.collection('finance_repairs').findOne({_id:manifest.requestKey});
const writeRegister = invoices => fs.writeFile(process.env.FINANCE_SECRETARY_REGISTER,JSON.stringify({schemaVersion:3,invoices,complete:true}));
function pinViews() {
  manifest.expectedAccounting={balanceProjection:{beforeSha256:storage.hash(balances.project(initial)),
    afterSha256:storage.hash(balances.project(check.derive(initial,manifest,contract.afterImages(manifest,'2026-01-01T00:00:00.000Z'))))}};
}

beforeEach(async()=>{
  consoleSpy=jest.spyOn(console,'error').mockImplementation(()=>{});
  previousRegister=process.env.FINANCE_SECRETARY_REGISTER;previousNames=process.env.FINANCE_CORP_NAMES;
  delete process.env.FINANCE_CORP_NAMES;
  for(const name of [...contract.COLLECTIONS,'finance_repairs','finance_coordination','finance_ingestions']) await mongoose.connection.db.collection(name).deleteMany({});
  await Promise.all([Statement.syncIndexes(),Transaction.syncIndexes(),Override.syncIndexes(),Link.syncIndexes()]);
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'finance-issuer-repair-test-'));
  const archive=path.join(temp,'archive');await fs.mkdir(archive);
  const original=path.join(archive,'original.pdf');await fs.writeFile(original,'synthetic reviewed card issuer');
  process.env.FINANCE_SECRETARY_REGISTER=path.join(temp,'register.json');
  rawDocument={supplier:'Example Supplier',documentNumber:'S-1',documentDate:'2025-02-04',kind:'receipt',grossAmountCents:3000};
  await writeRegister([rawDocument]);
  const doc=(await register.loadRegister()).invoices[0];
  const statement=await Statement.create({issuer:'Example Bank',accountLast4:null,status:'reconciled',
    statementKey:'example-bank|-|2025-02-01|2025-02-28',periodStart:'2025-02-01',periodEnd:'2025-02-28',
    archivePath:original,fileName:'original.pdf',fileSha256:storage.hash('synthetic reviewed card issuer'),
    accounts:[{code:'CARD',accountKey:'example-bank|-|CARD',openingCents:10000,closingCents:12250,transactionCount:3}]});
  const rows=await Transaction.create([3000,-1000,250].map((amountCents,i)=>({_id:(i+1).toString(16).padStart(24,'0'),
    statementId:statement._id,accountKey:'example-bank|-|CARD',accountCode:'CARD',date:['2025-02-05','2025-02-15','2025-02-28'][i],
    description:'Example Supplier '+i,amountCents,flowCents:-amountCents,balanceAfterCents:null,fingerprint:'card-row-'+i,
    occurrence:1,category:i===2?null:i?'Autres':'Impôts',tags:['retained'],manual:i===0})));
  await Statement.collection.updateOne({_id:statement._id},{$unset:{ledger:''}});
  await Transaction.collection.updateMany({statementId:statement._id},{$unset:{ledger:''}});
  await Transaction.collection.updateOne({_id:rows[2]._id},{$unset:{manual:''}});
  await Override.create({accountKey:rows[0].accountKey,date:rows[0].date,fingerprint:rows[0].fingerprint,occurrence:1,
    category:rows[0].category,tags:rows[0].tags,createdBy:'owner'});
  await Link.create({key:doc.id+'|'+contract.keyOf(rows[0]),documentId:doc.id,transactionKey:contract.keyOf(rows[0]),
    status:'proposed',ambiguous:true,document:{...linkContract.documentImage(doc),ledger:'perso'},
    transaction:{accountKey:rows[0].accountKey,date:rows[0].date,description:rows[0].description,flowCents:rows[0].flowCents,category:rows[0].category}});
  for(const ledger of ['perso','corp']){
    const prefix=ledger==='corp'?'corp:':'';
    await Statement.create({issuer:'Example Rewards',ledger,status:'reconciled',fileName:ledger+'.pdf',fileSha256:storage.hash(ledger),
      statementKey:prefix+'example-rewards|-|2026-01-01|2026-01-31',periodStart:'2026-01-01',periodEnd:'2026-01-31',
      accounts:[{code:'CARD',accountKey:prefix+'example-rewards|-|CARD',openingCents:15500,closingCents:15500,transactionCount:0}]});
  }
  initial=await check.snapshot(mongoose.connection.db);
  const before=storage.plain(initial),s=before.finance_statements.find(s=>s._id===String(statement._id));
  const move=key=>key.replace(/^example-bank\|/,'example-rewards|');
  manifest={schemaVersion:4,operation:'issuer-reassignment',requestKey:'synthetic-card-issuer-repair-v1',
    verifiedIdentity:{issuer:'Example Rewards',ledger:'perso',last4:'1234',periodStart:s.periodStart,periodEnd:s.periodEnd,
      pdfSha256:s.fileSha256,originalArchivePath:original,documents:[doc]},legacyIdentityRetained:{accountLast4:null},updates:[
      update('finance_statements',s,{issuer:'Example Rewards',statementKey:move(s.statementKey),'accounts.0.accountKey':move(s.accounts[0].accountKey)}),
      ...before.finance_transactions.map(t=>update('finance_transactions',t,{accountKey:move(t.accountKey)})),
      ...before.finance_overrides.map(o=>update('finance_overrides',o,{accountKey:move(o.accountKey)})),
      ...before.finance_document_links.map(l=>update('finance_document_links',l,{key:l.documentId+'|'+move(l.transactionKey),transactionKey:move(l.transactionKey),
        'transaction.accountKey':move(l.transaction.accountKey),bookRepair:{requestKey:'synthetic-card-issuer-repair-v1',documentSha256:storage.hash(doc)}}))]};
  pinViews();expect(balances.project(initial)).toEqual(await check.nativeViews());
  const app=require('express')().use('/api/finance',require('../../routes/finance')());server=app.listen(0,'127.0.0.1');await once(server,'listening');
  options={mode:'apply',actor:'synthetic-test',receiptRoot:temp+'/receipts',archiveRoot:archive,coreOrigin:'http://127.0.0.1:'+server.address().port};
});
afterEach(async()=>{
  await new Promise(r=>server.close(r));await fs.rm(temp,{recursive:true,force:true});consoleSpy.mockRestore();
  if(previousRegister===undefined)delete process.env.FINANCE_SECRETARY_REGISTER;else process.env.FINANCE_SECRETARY_REGISTER=previousRegister;
  if(previousNames===undefined)delete process.env.FINANCE_CORP_NAMES;else process.env.FINANCE_CORP_NAMES=previousNames;
});

test('corrects only issuer identities, retains null balances/owner decisions/ambiguous links and proves the changed account view',async()=>{
  const receipt=await execute();
  expect(receipt).toMatchObject({schema:'agentx.finance-issuer-repair/v1',phase:'applied',documents:6,
    inserted:0,deleted:0,arithmeticResidualCents:0,latestBalancesUnchanged:false,reviewedBalanceProjectionMatched:true});
  const after=await check.snapshot(mongoose.connection.db);
  expect(after).toEqual(check.derive(initial,manifest,check.typedAfter(check.images(initial,manifest),manifest,new Date(receipt.appliedAtUtc))));
  expect((await check.nativeViews()).perso.accounts).toHaveLength(1);
  expect((await check.nativeViews()).perso.accounts[0]).toMatchObject({accountKey:'example-rewards|-|CARD',balanceCents:15500,asOf:'2026-01-31'});
  expect(after.finance_transactions.every(t=>t.balanceAfterCents===null&&!Object.hasOwn(t,'ledger'))).toBe(true);
  expect(after.finance_transactions[2]).not.toHaveProperty('manual');
  expect(after.finance_transactions[2].category).toBeNull();
  const view=await documents.documents({ledger:'perso'});
  expect(view.ambiguous[0].candidates[0].id).toBe(String(initial.finance_document_links[0]._id));
  expect(await check.snapshot(mongoose.connection.db)).toEqual(after);
  expect(await execute({mode:'resume'})).toEqual(receipt);
  expect(await execute({mode:'rollback'})).toMatchObject({phase:'rolled_back',exactBeforeImagesRestored:true,reviewedBalanceProjectionMatched:true});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(initial);
  expect((await access.state()).repair).toBeNull();
});

test('accepts a complete card statement without links or a configured register',async()=>{
  await Link.deleteMany({});initial=await check.snapshot(mongoose.connection.db);
  manifest.updates=manifest.updates.filter(u=>u.collection!=='finance_document_links');manifest.verifiedIdentity.documents=[];
  delete process.env.FINANCE_SECRETARY_REGISTER;pinViews();
  expect((await execute()).documents).toBe(5);
  expect((await execute({mode:'rollback'})).exactBeforeImagesRestored).toBe(true);
  expect(await check.snapshot(mongoose.connection.db)).toEqual(initial);
});

test.each(['amount','ledger','category','account-number','issuer-tier','duplicate-row','omitted-decision','omitted-link','invented-balance','wrong-flow'])('rejects an unreviewed %s change before admission',async kind=>{
  if(kind==='amount')manifest.updates[1].set.amountCents=0;
  if(kind==='ledger')manifest.verifiedIdentity.ledger='corp';
  if(kind==='category')manifest.updates[1].set.category='Autres';
  if(kind==='account-number')manifest.updates[0].set.accountLast4='1234';
  if(kind==='issuer-tier')manifest.verifiedIdentity.issuer='Example Rewards Mastercard';
  if(kind==='duplicate-row')manifest.updates.splice(2,0,structuredClone(manifest.updates[1]));
  if(kind==='omitted-decision')manifest.updates=manifest.updates.filter(u=>u.collection!=='finance_overrides');
  if(kind==='omitted-link')manifest.updates=manifest.updates.filter(u=>u.collection!=='finance_document_links');
  if(kind==='invented-balance')manifest.updates[1].set.balanceAfterCents=13000;
  if(kind==='wrong-flow'){manifest.updates[1].before.flowCents=3000;manifest.updates[1].expectedBeforeSha256=storage.hash(manifest.updates[1].before);}
  await expect(execute()).rejects.toMatchObject({code:'FINANCE_REPAIR_MANIFEST_INVALID'});
  expect(await journal()).toBeNull();expect(await check.snapshot(mongoose.connection.db)).toEqual(initial);
});

test.each(['reviewed-before','reviewed-after','new-current-balance','destination-row','destination-statement','unlisted-link','document-drift'])('refuses %s drift before any accounting write',async kind=>{
  if(kind==='reviewed-before')manifest.expectedAccounting.balanceProjection.beforeSha256='0'.repeat(64);
  if(kind==='reviewed-after')manifest.expectedAccounting.balanceProjection.afterSha256='0'.repeat(64);
  if(kind==='new-current-balance')await Statement.create({issuer:'Other Example',ledger:'corp',status:'reconciled',fileName:'new.pdf',fileSha256:storage.hash('new'),
    statementKey:'corp:other-example|-|2026-02-01|2026-02-28',periodStart:'2026-02-01',periodEnd:'2026-02-28',
    accounts:[{code:'CARD',accountKey:'corp:other-example|-|CARD',openingCents:7,closingCents:7,transactionCount:0}]});
  if(kind==='destination-row')await Transaction.create({...manifest.updates[1].before,_id:new mongoose.Types.ObjectId(),accountKey:'example-rewards|-|CARD'});
  if(kind==='destination-statement')await Statement.create({...manifest.updates[0].before,_id:new mongoose.Types.ObjectId(),statementKey:manifest.updates[0].set.statementKey});
  if(kind==='unlisted-link')await Link.create({...manifest.updates.at(-1).before,_id:new mongoose.Types.ObjectId(),documentId:'another',key:'another|'+manifest.updates.at(-1).before.transactionKey});
  if(kind==='document-drift')await writeRegister([{...rawDocument,kind:'invoice'}]);
  const before=await check.snapshot(mongoose.connection.db);
  await expect(execute()).rejects.toMatchObject({code:kind==='document-drift'?'FINANCE_REPAIR_DOCUMENTS_CHANGED':'FINANCE_REPAIR_STATE_CONFLICT'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(before);expect((await journal()).phase).toBe('rejected');expect((await access.state()).repair).toBeNull();
});

test('retains a later owner confirmation and refuses the old rollback',async()=>{
  await execute();await documents.decide(manifest.updates.at(-1).id,'confirmed','owner');
  const decided=await check.snapshot(mongoose.connection.db);
  await expect(execute({mode:'rollback'})).rejects.toMatchObject({code:'FINANCE_REPAIR_STATE_CONFLICT'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(decided);expect((await access.state()).repair).toBeNull();
});

test('refuses an unreviewed later balance change before rollback dispatch',async()=>{
  await execute();
  await Statement.create({issuer:'Other Example',ledger:'corp',status:'reconciled',fileName:'later.pdf',fileSha256:storage.hash('later'),
    statementKey:'corp:other-example|-|2026-02-01|2026-02-28',periodStart:'2026-02-01',periodEnd:'2026-02-28',
    accounts:[{code:'CARD',accountKey:'corp:other-example|-|CARD',openingCents:8,closingCents:8,transactionCount:0}]});
  const changed=await check.snapshot(mongoose.connection.db);
  await expect(execute({mode:'rollback'})).rejects.toMatchObject({code:'FINANCE_REPAIR_STATE_CONFLICT'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(changed);expect((await access.state()).repair).toBeNull();
});

test('refuses rounded intermediate arithmetic even when its final number looks safe',()=>{
  manifest.verifiedIdentity.documents=[];manifest.updates=manifest.updates.filter(u=>u.collection!=='finance_document_links');
  const s=manifest.updates[0].before;s.accounts[0].openingCents=0;s.accounts[0].closingCents=1;
  for(const [i,amount] of [Number.MAX_SAFE_INTEGER,1,-Number.MAX_SAFE_INTEGER].entries()){
    manifest.updates[i+1].before.amountCents=amount;manifest.updates[i+1].before.flowCents=-amount;
  }
  for(const u of manifest.updates)u.expectedBeforeSha256=storage.hash(u.before);
  expect(()=>contract.read(serialize().bytes,serialize().confirmedDigest)).toThrow('safe integer cents');
});

test('accepts the full hundred-row card bound while preserving absent running balances',()=>{
  const s=structuredClone(manifest.updates[0].before),sample=manifest.updates[1].before;
  const rows=Array.from({length:100},(_,i)=>({...sample,_id:(i+1).toString(16).padStart(24,'0'),fingerprint:'bounded-'+i,
    amountCents:1,flowCents:-1,manual:false,balanceAfterCents:null}));s.accounts[0].transactionCount=100;s.accounts[0].closingCents=10100;
  manifest.verifiedIdentity.documents=[];manifest.updates=[update('finance_statements',s,manifest.updates[0].set),
    ...rows.map(t=>update('finance_transactions',t,{accountKey:'example-rewards|-|CARD'}))];
  expect(contract.read(serialize().bytes,serialize().confirmedDigest).manifest).toEqual(manifest);
  const extra=structuredClone(rows[0]);extra._id='f'.repeat(24);extra.fingerprint='one-too-many';
  manifest.updates.push(update('finance_transactions',extra,{accountKey:'example-rewards|-|CARD'}));
  expect(()=>contract.read(serialize().bytes,serialize().confirmedDigest)).toThrow();
});

test('requires served issuer support in addition to linked-document support',async()=>{
  await new Promise(r=>server.close(r));const proof=require('../../src/services/finance/financeRepairCoreProof');
  const app=require('express')().get('/api/finance/maintenance',async(_req,res)=>res.json({data:{protocol:proof.PROTOCOL,
    capabilities:[proof.LINKED_DOCUMENTS],databaseIdentity:(await access.state()).identity}}));
  server=app.listen(0,'127.0.0.1');await once(server,'listening');options.coreOrigin='http://127.0.0.1:'+server.address().port;
  await expect(execute()).rejects.toMatchObject({code:'FINANCE_REPAIR_CORE_UNQUALIFIED'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(initial);expect((await access.state()).repair).toBeNull();
});

async function killAt(mode,stop,index){
  const file=temp+'/manifest.json';await fs.writeFile(file,serialize().bytes);
  const child=fork(path.join(__dirname,'../fixtures/financeRepairProcess.cjs'),[process.env.MONGODB_URI,options.receiptRoot,
    options.archiveRoot,file,mode,stop,String(index),options.coreOrigin],{stdio:['ignore','ignore','ignore','ipc'],env:{...process.env}});
  const [message]=await once(child,'message');const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  expect(message).toMatchObject({checkpoint:stop,index});
}
test('resumes actual interruption after issuer change and during exact reverse rollback',async()=>{
  await killAt('apply','applied_step',0);expect((await execute({mode:'resume'})).phase).toBe('applied');
  await killAt('rollback','rollback_step',manifest.updates.length-1);
  expect((await execute({mode:'resume'})).phase).toBe('rolled_back');expect(await check.snapshot(mongoose.connection.db)).toEqual(initial);
});
test('keeps an unanswered issuer dispatch held until the exact original effect arrives',async()=>{
  await killAt('apply','dispatch_saved',0);const partial=await check.snapshot(mongoose.connection.db);
  await expect(execute({mode:'resume'})).rejects.toMatchObject({code:'FINANCE_REPAIR_WRITE_UNCERTAIN'});
  await expect(execute({mode:'rollback'})).rejects.toMatchObject({code:'FINANCE_REPAIR_WRITE_UNCERTAIN'});
  expect(await check.snapshot(mongoose.connection.db)).toEqual(partial);
  const saved=await journal();await Statement.collection.replaceOne({_id:new mongoose.Types.ObjectId(manifest.updates[0].id)},saved.after[0]);
  expect((await execute({mode:'resume'})).phase).toBe('applied');expect((await access.state()).repair).toBeNull();
});
