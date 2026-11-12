'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { reconnect, binding } = require('../reconnect.cjs');
const { runImport } = require('../import.cjs');
const { execute } = require('../receiver.cjs');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-reconnect-')); t.after(() => fs.rm(dir, { recursive:true, force:true }));
  const config = { cacheRoot:path.join(dir,'cache') }, receiver = { root:path.join(dir,'media') };
  await fs.mkdir(receiver.root);
  const files = Array.from({ length:4 }, (_,i) => ({ key:'old-'+i, name:i+'.jpg', relativePath:'DCIM/'+i+'.jpg', size:6, modified:'2020-01-02', objectId:''+i }));
  const bytes = item => Buffer.from('image'+item.objectId);
  const read = async (deviceId,item,target) => { const data=bytes(item);await fs.writeFile(target,data);return { size:data.length,sha256:sha(data),source:item }; };
  const remote = (header,payload) => execute(receiver,header,Readable.from(payload?.file ? [] : payload?.json ? [Buffer.from(JSON.stringify(payload.json))] : []));
  const send = async (header,payload) => payload?.file ? execute(receiver,header,require('node:fs').createReadStream(payload.file)) : remote(header,payload);
  const original = { devices:async()=>[{id:'original'}],inventory:async()=>({files,complete:true,errors:[],objectsVisited:4}),read:async(id,item,target)=>{
    if(item.objectId==='3')throw Error('Disconnected'); return read(id,item,target);
  } };
  const first = await runImport(config,{source:original,remote:send,log:()=>{}});assert.equal(first.counts.pending,1);
  const runId=first.runId, stateFile=path.join(config.cacheRoot,runId+'.json'),before=await fs.readFile(stateFile),state=JSON.parse(before);
  let reads=0,enumerations=0;
  const currentFiles=files.map(x=>({...x,key:'new-'+x.objectId}));
  const current={devices:async()=>[{id:'reconnected'}],inventory:async()=>{enumerations++;return {files:currentFiles,complete:true,errors:[]};},read:async(id,item,target)=>{assert.equal(id,'reconnected');reads++;return read(id,item,target);}};
  return {dir,config,receiver,send,runId,state,stateFile,before,current,currentFiles,get reads(){return reads;},get enumerations(){return enumerations;},
    input:{operationId:crypto.randomUUID(),runId,deviceId:'reconnected',samePhone:true}};
}
test('explicit same-phone recovery proves three contents and resumes the frozen import without rebinding cleanup',async t=>{
  const f=await fixture(t),receipt=await reconnect(f.config,f.input,{source:f.current,remote:f.send});
  assert.equal(f.reads,3);assert.equal(receipt.anchors.length,3);assert.equal(receipt.phoneDeletes,0);
  assert.deepEqual(await fs.readFile(f.stateFile),f.before,'recovery never rewrites the checkpoint or original device key');
  assert.deepEqual(await reconnect(f.config,f.input,{source:f.current,remote:f.send}),receipt);assert.equal(f.reads,3);assert.equal(f.enumerations,1);
  assert.equal((await binding(f.config,f.state)).deviceId,'reconnected');
  const result=await runImport(f.config,{source:f.current,remote:f.send,resume:f.runId,deviceId:'original',log:()=>{}});
  assert.equal(result.counts.pending,0);assert.equal(f.reads,4,'resume reads only its remaining original');
  const after=JSON.parse(await fs.readFile(f.stateFile));assert.equal(after.deviceId,'original');assert.equal(after.deviceKey,sha('original'));
  assert.equal(after.items[3].key,'old-3');assert.equal(after.items[3].readSource.key,'new-3');
  assert.deepEqual(after.items.map(x=>x.requestId),f.state.items.map(x=>x.requestId));
  const library=await require('../../../core/src/services/photos/phoneLibrary').createPhoneLibrary(f.receiver);
  const cleanup=require('../../../core/src/services/photos/phoneCleanup').createPhoneCleanup(library);
  const plan=await cleanup.prepare({planId:crypto.randomUUID(),runId:f.runId,items:[f.state.items[0].requestId]});
  let deletes=0;
  await assert.rejects(require('../../../core/src/services/photos/phoneCleanupExecution').executePhoneCleanup({
    input:{operationId:crypto.randomUUID(),planId:plan.planId,digest:plan.digest,confirmation:plan.confirmation},
    remote:f.send,source:f.current,enabled:true,remove:async()=>{deletes++;}
  }),{code:'PHONE_UNAVAILABLE'});
  assert.equal(deletes,0,'a read-only binding never authorizes deletion against a different device key');

  await assert.rejects(runImport(f.config,{source:f.current,remote:f.send,resume:f.runId,deviceId:'reconnected',log:()=>{}}),/Selected phone differs/);
  await assert.rejects(reconnect(f.config,{...f.input,deviceId:'another'},{source:f.current,remote:f.send}),{code:'REQUEST_CONFLICT'});
});
test('same-phone declaration is required before any source access',async t=>{
  const f=await fixture(t);await assert.rejects(reconnect(f.config,{...f.input,samePhone:false},{remote:f.send,source:{devices:()=>{throw Error('Must not access source')}}}),{code:'PHONE_IDENTITY_REQUIRED'});
});
test('changed or ambiguous pending sources refuse before reading hash anchors',async t=>{
  for(const ambiguous of [false,true]){
    const f=await fixture(t);const files=f.currentFiles.map(x=>({...x}));if(ambiguous)files.push({...files[3]});else files[3].modified='changed';
    await assert.rejects(reconnect(f.config,f.input,{remote:f.send,source:{...f.current,inventory:async()=>({complete:true,errors:[],files})}}),{code:'PHONE_SOURCE_CHANGED'});
    assert.equal(f.reads,0);assert.equal(await binding(f.config,f.state),null);
  }
});
test('a changed phone hash leaves no binding and preserves all backup receipts',async t=>{
  const f=await fixture(t);await assert.rejects(reconnect(f.config,f.input,{remote:f.send,source:{...f.current,read:async(id,item,target)=>{
    const result=await f.current.read(id,item,target);await fs.writeFile(target,'wrong!');return result;
  }}}),{code:'PHONE_IDENTITY_UNPROVEN'});
  assert.equal(await binding(f.config,f.state),null);assert.deepEqual(await fs.readFile(f.stateFile),f.before);
});
test('incomplete inventories, insufficient anchors and the still-available original device refuse recovery',async t=>{
  const f=await fixture(t);
  await assert.rejects(reconnect(f.config,f.input,{remote:f.send,source:{...f.current,inventory:async()=>({complete:false,files:f.currentFiles})}}),{code:'PHONE_INVENTORY_INCOMPLETE'});
  await assert.rejects(reconnect(f.config,f.input,{remote:f.send,source:{...f.current,devices:async()=>[{id:'original'},{id:'reconnected'}]}}),{code:'PHONE_RECONNECT_NOT_REQUIRED'});
  const files=f.currentFiles.filter(x=>x.objectId!=='0');
  await assert.rejects(reconnect(f.config,f.input,{remote:f.send,source:{...f.current,inventory:async()=>({complete:true,files})}}),{code:'PHONE_IDENTITY_UNPROVEN'});
  assert.equal(f.reads,0);
});


test('a corrupted canonical Media anchor refuses recovery before phone reads',async t=>{
  const f=await fixture(t);await fs.writeFile(f.state.items[0].receipt.path,'wrong!');
  await assert.rejects(reconnect(f.config,f.input,{source:f.current,remote:f.send}),{code:'BACKUP_REQUIRED'});
  assert.equal(f.reads,0);assert.equal(await binding(f.config,f.state),null);
});
