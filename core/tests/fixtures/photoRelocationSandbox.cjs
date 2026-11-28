'use strict';
// TEST FIXTURE ONLY. No filesystem, network, database, adapters or runtime exports.
// A Map mutation is not a relocation implementation or production permission.
const { createHash } = require('node:crypto');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => structuredClone(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const faults = new Set(['none','before-effect','after-effect','rollback-before-effect','rollback-after-effect']);
function createPhotoRelocationSandbox(initial = {}) {
  const files = new Map(), operations = new Map(); let sequence = 0;
  function put(name, text) {
    if (typeof name !== 'string' || !name || typeof text !== 'string') fail('INVALID_SYNTHETIC_FILE');
    files.set(name,{text,token:++sequence});
  }
  for (const [name,text] of Object.entries(initial)) put(name,text);
  function observe(name) { const row=files.get(name);return row?{sha256:sha(row.text),size:Buffer.byteLength(row.text),token:row.token}:null; }
  function match(file,item) { return file && file.sha256===item.sha256 && file.size===item.size; }
  function view(operation) { return copy({...operation,simulation:true,migrationReady:false}); }
  function cas(operation,revision,changes) {
    if(operation.revision!==revision)fail('JOURNAL_REVISION_CONFLICT');
    Object.assign(operation,changes,{revision:revision+1});
  }
  function get(id) { const operation=operations.get(id);if(!operation)fail('OPERATION_MISSING');return operation; }
  function validate(plan) {
    if(!plan || typeof plan.operationId!=='string' || !plan.operationId || !Array.isArray(plan.items) || plan.items.length!==2)
      fail('INVALID_PLAN');
    const names=new Set();
    for(const item of plan.items){
      if(!item || typeof item.id!=='string' || !item.id || !/^[a-f0-9]{64}$/.test(item.sha256)
        || !Number.isSafeInteger(item.size) || item.size<0)fail('INVALID_PLAN');
      for(const name of [item.source,item.destination]){
        if(typeof name!=='string'||!name||names.has(name))fail('PLAN_COLLISION');names.add(name);
      }
    }
    if(new Set(plan.items.map(item=>item.id)).size!==2)fail('INVALID_PLAN');
    return sha(JSON.stringify(plan.items.map(({id,source,destination,sha256,size})=>({id,source,destination,sha256,size}))));
  }
  function run(plan,{fault='none',faultItemId,expectedRevision}={}) {
    if(!faults.has(fault))fail('INVALID_FAULT');
    const planHash=validate(plan);
    if(faultItemId!==undefined && !plan.items.some(item=>item.id===faultItemId))fail('INVALID_FAULT_ITEM');
    let operation=operations.get(plan.operationId);
    if(operation && operation.planHash!==planHash)fail('OPERATION_IDENTITY_CONFLICT');
    if(!operation){
      // Freeze exact identities before either member is simulated.
      const items=plan.items.map(item=>{
        const source=observe(item.source);if(!match(source,item))fail('SOURCE_CHANGED');
        if(files.has(item.destination))fail('DESTINATION_COLLISION');
        return {...copy(item),token:source.token,state:'prepared'};
      });
      operation={operationId:plan.operationId,planHash,revision:0,state:'prepared',items};
      operations.set(plan.operationId,operation);
    }
    if(expectedRevision!==undefined && operation.revision!==expectedRevision)fail('JOURNAL_REVISION_CONFLICT');
    if(['unknown','rollback-unknown'].includes(operation.state))fail('UNKNOWN_DISPATCH');
    if(['completed','rolled-back'].includes(operation.state))return view(operation);
    if(operation.state==='rolling-back')fail('ROLLBACK_IN_PROGRESS');
    for(const item of operation.items){
      if(item.state==='verified')continue;
      const source=observe(item.source);
      if(!match(source,item)||source.token!==item.token)fail('SOURCE_CHANGED');
      if(files.has(item.destination))fail('DESTINATION_COLLISION');
      cas(operation,operation.revision,{state:'dispatching'});item.state='dispatching';
      if(fault==='before-effect' && (faultItemId===undefined || faultItemId===item.id)){item.state='unknown';cas(operation,operation.revision,{state:'unknown'});return view(operation);}
      files.set(item.destination,files.get(item.source));files.delete(item.source);
      if(fault==='after-effect' && (faultItemId===undefined || faultItemId===item.id)){item.state='unknown';cas(operation,operation.revision,{state:'unknown'});return view(operation);}
      item.state='verified';cas(operation,operation.revision,{state:'prepared'});
    }
    cas(operation,operation.revision,{state:'completed'});return view(operation);
  }
  function reconcile(id){
    const operation=get(id);
    if(!['unknown','rollback-unknown'].includes(operation.state))return view(operation);
    const rollback=operation.state==='rollback-unknown';
    const item=operation.items.find(item=>item.state===(rollback?'rollback-unknown':'unknown'));
    const source=observe(item.source),destination=observe(item.destination);
    const unchanged=file=>match(file,item)&&file.token===item.token;
    if(unchanged(source)&&!destination)item.state=rollback?'rolled-back':'prepared';
    else if(!source&&unchanged(destination))item.state='verified';
    else fail('RECONCILIATION_AMBIGUOUS');
    cas(operation,operation.revision,{state:rollback?'rolling-back':'prepared'});
    return view(operation);
  }
  function rollback(id,{fault='none',faultItemId,expectedRevision}={}){
    if(!faults.has(fault))fail('INVALID_FAULT');const operation=get(id);
    if(faultItemId!==undefined && !operation.items.some(item=>item.id===faultItemId))fail('INVALID_FAULT_ITEM');
    if(expectedRevision!==undefined && operation.revision!==expectedRevision)fail('JOURNAL_REVISION_CONFLICT');
    if(['unknown','rollback-unknown'].includes(operation.state))fail('UNKNOWN_DISPATCH');
    if(operation.state==='rolled-back')return view(operation);
    cas(operation,operation.revision,{state:'rolling-back'});
    for(const item of [...operation.items].reverse()){
      if(item.state==='rolled-back')continue;
      if(item.state==='prepared'){
        const source=observe(item.source);if(!match(source,item)||source.token!==item.token||files.has(item.destination))fail('ROLLBACK_CHANGED');
        item.state='rolled-back';continue;
      }
      const destination=observe(item.destination);
      if(!match(destination,item)||destination.token!==item.token)fail('ROLLBACK_CHANGED');
      if(files.has(item.source))fail('ROLLBACK_COLLISION');
      item.state='rollback-dispatching';cas(operation,operation.revision,{});
      if(fault==='rollback-before-effect' && (faultItemId===undefined || faultItemId===item.id)){item.state='rollback-unknown';cas(operation,operation.revision,{state:'rollback-unknown'});return view(operation);}
      files.set(item.source,files.get(item.destination));files.delete(item.destination);
      if(fault==='rollback-after-effect' && (faultItemId===undefined || faultItemId===item.id)){item.state='rollback-unknown';cas(operation,operation.revision,{state:'rollback-unknown'});return view(operation);}
      item.state='rolled-back';cas(operation,operation.revision,{});
    }
    cas(operation,operation.revision,{state:'rolled-back'});return view(operation);
  }
  return {run,reconcile,rollback,observe,edit:put,remove:name=>files.delete(name),journal:id=>view(get(id))};
}
module.exports={createPhotoRelocationSandbox};
