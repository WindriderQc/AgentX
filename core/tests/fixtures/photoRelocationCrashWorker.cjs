'use strict';
// Isolated test worker, deliberately not a product executor. Fixed synthetic names
// only; its parent creates a fresh marked OS temporary directory for every test.
// Rename follows a collision check under this fixture's single-worker lock.
// It is NOT atomic no-replace against external writers; hostile races, power loss
// and physical storage durability are not qualified by these process-exit tests.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=process.cwd(),base=path.basename(root),temp=fs.realpathSync(require('node:os').tmpdir());
const action=process.argv[2],fault=process.argv[3]||'none';
const allowed=['forward','observe','rollback'];
const faults=['none','image-before','image-after','xmp-before','xmp-after','rollback-image-before','rollback-image-after','rollback-xmp-before','rollback-xmp-after'];
function fail(code){throw Object.assign(new Error(code),{code});}
if(!allowed.includes(action)||!faults.includes(fault))fail('INVALID_TEST_ACTION');
if(!/^agentx-relocation-crash-[a-zA-Z0-9]+$/.test(base)||path.dirname(fs.realpathSync(root))!==temp||fs.realpathSync(root)!==root)fail('NOT_TEST_SANDBOX');
function regular(name){const stat=fs.lstatSync(name,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n)fail('UNSAFE_TEST_FILE');return stat;}
regular('fixture.json');const fixture=JSON.parse(fs.readFileSync('fixture.json','utf8'));
if(fixture.schema!=='synthetic-relocation-crash/v1'||! /^[a-f0-9]{32}$/.test(fixture.nonce))fail('INVALID_TEST_MARKER');
const pairs=[['image','source-image.txt','target-image.txt'],['xmp','source-xmp.txt','target-xmp.txt']];
const expected=kind=>'SYNTHETIC TEST ONLY '+fixture.nonce+' '+kind+'\n';
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
let dirSync='supported';
function syncDirectory(){let fd;try{fd=fs.openSync('.','r');fs.fsyncSync(fd);}catch(error){
 if(process.platform!=='win32'||!['EPERM','EACCES','EINVAL','EISDIR','ENOTSUP'].includes(error.code))throw error;
 dirSync='unsupported-on-this-Windows-runtime';
}finally{if(fd!==undefined)fs.closeSync(fd);}}
function atomicJournal(value){
 if(fs.existsSync('journal.next'))fail('UNRECONCILED_JOURNAL_TEMP');
 const fd=fs.openSync('journal.next','wx',0o600);try{const payload=JSON.stringify(value);fs.writeFileSync(fd,JSON.stringify({payload,journalSha256:digest(payload)}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync('journal.next','journal.json');syncDirectory();
}
function observation(name){try{const stat=regular(name),bytes=fs.readFileSync(name);return {sha256:digest(bytes),size:bytes.length,ino:String(stat.ino),dev:String(stat.dev),mtimeNs:String(stat.mtimeNs)};}
 catch(error){if(error.code==='ENOENT')return null;throw error;}}
function matches(row,kind){return row&&row.sha256===digest(expected(kind))&&row.size===Buffer.byteLength(expected(kind));}
function identity(row,original){return row&&row.ino===original.ino&&row.dev===original.dev;}
function crash(point){if(fault===point)process.exit(73);}
let lock;
try{
 try{lock=fs.openSync('worker.lock','wx',0o600);}catch(error){if(error.code==='EEXIST')fail('LOCK_REQUIRES_PARENT_OBSERVATION');throw error;}
 fs.writeFileSync(lock,JSON.stringify({pid:process.pid,nonce:fixture.nonce}));fs.fsyncSync(lock);syncDirectory();
 if(fs.existsSync('journal.next'))fail('UNRECONCILED_JOURNAL_TEMP');
 let journal;
 if(fs.existsSync('journal.json')){regular('journal.json');const envelope=JSON.parse(fs.readFileSync('journal.json','utf8'));
   if(typeof envelope.payload!=='string'||envelope.journalSha256!==digest(envelope.payload))fail('JOURNAL_DIGEST_MISMATCH');
   journal=JSON.parse(envelope.payload);}
 else{
  if(action!=='forward')fail('NO_JOURNAL');
  journal={simulation:true,migrationReady:false,nonce:fixture.nonce,revision:0,items:pairs.map(([kind,source,target])=>{
   const original=observation(source);if(!matches(original,kind))fail('SYNTHETIC_SOURCE_CHANGED');if(observation(target))fail('COLLISION');
   return {kind,source,target,original,state:'prepared'};})};atomicJournal(journal);
 }
 if(journal.nonce!==fixture.nonce||journal.simulation!==true||journal.migrationReady!==false
   || !Array.isArray(journal.items)||journal.items.length!==2)fail('JOURNAL_IDENTITY_CONFLICT');
 for(let i=0;i<2;i++){
  const item=journal.items[i],fixed=pairs[i];
  if(item.kind!==fixed[0]||item.source!==fixed[1]||item.target!==fixed[2]
    || !['prepared','dispatching','verified','rollback-dispatching','rolled-back'].includes(item.state))fail('INVALID_TEST_JOURNAL');
 }
 function save(){journal.revision++;atomicJournal(journal);}
 const unknown=journal.items.some(item=>['dispatching','rollback-dispatching'].includes(item.state));
 if(unknown&&action!=='observe')fail('UNKNOWN_REQUIRES_OBSERVATION');
 if(action==='observe'){
  for(const item of journal.items){
   if(!['dispatching','rollback-dispatching'].includes(item.state))continue;
   const source=observation(item.source),target=observation(item.target),reversing=item.state==='rollback-dispatching';
   if(matches(source,item.kind)&&identity(source,item.original)&&!target)item.state=reversing?'rolled-back':'prepared';
   else if(!source&&matches(target,item.kind)&&identity(target,item.original)){item.state='verified';item.destination=target;}
   else fail('AMBIGUOUS_OBSERVATION');save();
  }
 }else if(action==='forward'){
  if(journal.items.some(item=>item.state==='rolled-back'))fail('ROLLED_BACK_OPERATION');
  for(const item of journal.items){
   if(item.state==='verified'){
    const target=observation(item.target);
    if(observation(item.source)||!matches(target,item.kind)||!identity(target,item.original)
       ||target.mtimeNs!==item.destination.mtimeNs)fail('VERIFIED_DESTINATION_CHANGED');
    continue;
   }
   const source=observation(item.source);if(!matches(source,item.kind)||!identity(source,item.original))fail('SYNTHETIC_SOURCE_CHANGED');
   if(observation(item.target))fail('COLLISION');
   item.state='dispatching';save();crash(item.kind+'-before');
   fs.renameSync(item.source,item.target);syncDirectory();crash(item.kind+'-after');
   item.destination=observation(item.target);item.state='verified';save();
  }
 }else{
  for(const item of [...journal.items].reverse()){
   if(item.state==='rolled-back'){
    const source=observation(item.source);
    if(!matches(source,item.kind)||!identity(source,item.original)||source.mtimeNs!==item.original.mtimeNs||observation(item.target))fail('ROLLBACK_CHANGED');
    continue;
   }
   if(item.state==='prepared'){
    const source=observation(item.source);
    if(!matches(source,item.kind)||!identity(source,item.original)||observation(item.target))fail('ROLLBACK_CHANGED');
    item.state='rolled-back';save();continue;
   }
   const target=observation(item.target);
   if(!matches(target,item.kind)||!identity(target,item.original)||target.mtimeNs!==item.destination.mtimeNs)fail('ROLLBACK_CHANGED');
   if(observation(item.source))fail('ROLLBACK_COLLISION');
   item.state='rollback-dispatching';save();crash('rollback-'+item.kind+'-before');
   fs.renameSync(item.target,item.source);syncDirectory();crash('rollback-'+item.kind+'-after');
   item.state='rolled-back';save();
  }
 }
 process.stdout.write(JSON.stringify({simulation:true,migrationReady:false,dirSync,journal}));
}catch(error){process.stderr.write(error.code||error.message);process.exitCode=1;}
finally{if(lock!==undefined){fs.closeSync(lock);fs.unlinkSync('worker.lock');syncDirectory();}}
