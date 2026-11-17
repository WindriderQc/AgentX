'use strict';
// Self-generated sentinel text only. No externally supplied directory or media.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const worker=path.resolve(__dirname,'../fixtures/photoRelocationCrashWorker.cjs');
let root,nonce,lastCrash;
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const exists=name=>fs.existsSync(path.join(root,name));
const text=kind=>'SYNTHETIC TEST ONLY '+nonce+' '+kind+'\n';
function run(action='forward',fault='none'){
 const result=spawnSync(process.execPath,[worker,action,fault],{cwd:root,encoding:'utf8',timeout:10000,windowsHide:true});
 if(result.error)throw result.error;
 if(result.status===73)lastCrash=result.pid;
 return result;
}
function releaseObservedExitedChild(){
 // spawnSync has reaped this exact child. A PID still alive (including reuse)
 // refuses cleanup. No age-based takeover or deletion of another lock.
 if(!lastCrash)throw Error('No reaped crash');
 const lock=JSON.parse(read('worker.lock'));
 expect(lock).toEqual({pid:lastCrash,nonce});
 let absent=false;try{process.kill(lastCrash,0);}catch(error){if(error.code==='ESRCH')absent=true;else throw error;}
 if(!absent)throw Error('PID still live; lock retained');
 fs.unlinkSync(path.join(root,'worker.lock'));lastCrash=undefined;
}
beforeEach(()=>{
 root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agentx-relocation-crash-')));
 nonce=crypto.randomBytes(16).toString('hex');lastCrash=undefined;
 fs.writeFileSync(path.join(root,'fixture.json'),JSON.stringify({schema:'synthetic-relocation-crash/v1',nonce}));
 for(const kind of ['image','xmp'])fs.writeFileSync(path.join(root,'source-'+kind+'.txt'),text(kind));
});
afterEach(()=>{
 if(!root)return;
 const resolved=fs.realpathSync(root);
 if(path.dirname(resolved)!==fs.realpathSync(os.tmpdir())||!/^agentx-relocation-crash-[a-zA-Z0-9]+$/.test(path.basename(resolved)))throw Error('Unsafe test cleanup');
 fs.rmSync(resolved,{recursive:true,force:true});
});
test('fresh child persists exact pair and retry is idempotent; durability capability explicit',()=>{
 const first=run();expect(first.status).toBe(0);const out=JSON.parse(first.stdout);
 expect(out).toMatchObject({simulation:true,migrationReady:false});
 expect(['supported','unsupported-on-this-Windows-runtime']).toContain(out.dirSync);
 console.info('Synthetic process-crash filesystem qualification:',process.platform,'directory fsync:',out.dirSync,'not power-loss proof');
 if(process.platform!=='win32')expect(out.dirSync).toBe('supported');
 expect(read('target-image.txt')).toBe(text('image'));expect(read('target-xmp.txt')).toBe(text('xmp'));
 const journal=read('journal.json');expect(run().status).toBe(0);expect(read('journal.json')).toBe(journal);
});
test.each(['image-before','image-after','xmp-before','xmp-after'])('process exit at %s is fenced until explicit post-exit observation',fault=>{
 expect(run('forward',fault).status).toBe(73);expect(exists('worker.lock')).toBe(true);
 expect(run().stderr).toBe('LOCK_REQUIRES_PARENT_OBSERVATION');
 releaseObservedExitedChild();expect(run().stderr).toBe('UNKNOWN_REQUIRES_OBSERVATION');
 expect(run('observe').status).toBe(0);expect(run().status).toBe(0);
 expect(read('target-image.txt')).toBe(text('image'));expect(read('target-xmp.txt')).toBe(text('xmp'));
 expect(exists('source-image.txt')).toBe(false);expect(exists('source-xmp.txt')).toBe(false);
});
test.each(['xmp-before','xmp-after'])('partial pair %s can instead reconcile and roll back',fault=>{
 expect(run('forward',fault).status).toBe(73);expect(exists('target-image.txt')).toBe(true);
 releaseObservedExitedChild();expect(run('observe').status).toBe(0);expect(run('rollback').status).toBe(0);
 expect(read('source-image.txt')).toBe(text('image'));expect(read('source-xmp.txt')).toBe(text('xmp'));
 expect(run('rollback').status).toBe(0);expect(run().stderr).toBe('ROLLED_BACK_OPERATION');
});
test.each(['rollback-xmp-before','rollback-xmp-after','rollback-image-before','rollback-image-after'])('rollback process exit %s preserves its original identity',fault=>{
 expect(run().status).toBe(0);expect(run('rollback',fault).status).toBe(73);
 releaseObservedExitedChild();expect(run('rollback').stderr).toBe('UNKNOWN_REQUIRES_OBSERVATION');
 expect(run('observe').status).toBe(0);expect(run('rollback').status).toBe(0);
 expect(read('source-image.txt')).toBe(text('image'));expect(read('source-xmp.txt')).toBe(text('xmp'));
});
test('collision never overwrites destination',()=>{
 fs.writeFileSync(path.join(root,'target-image.txt'),'SYNTHETIC COLLISION');
 expect(run().stderr).toBe('COLLISION');expect(read('target-image.txt')).toBe('SYNTHETIC COLLISION');
 expect(read('source-image.txt')).toBe(text('image'));
});
test('rollback refuses edited destination and preserves edits',()=>{
 expect(run().status).toBe(0);fs.writeFileSync(path.join(root,'target-xmp.txt'),'SYNTHETIC HUMAN EDIT');
 expect(run('rollback').stderr).toBe('ROLLBACK_CHANGED');expect(read('target-xmp.txt')).toBe('SYNTHETIC HUMAN EDIT');
});
test('rollback refuses occupied original location',()=>{
 expect(run().status).toBe(0);fs.writeFileSync(path.join(root,'source-xmp.txt'),'SYNTHETIC NEW SOURCE');
 expect(run('rollback').stderr).toBe('ROLLBACK_COLLISION');expect(read('source-xmp.txt')).toBe('SYNTHETIC NEW SOURCE');
});
test('uncertain dispatch with modified bytes stays suspended',()=>{
 expect(run('forward','xmp-after').status).toBe(73);releaseObservedExitedChild();
 fs.writeFileSync(path.join(root,'target-xmp.txt'),'SYNTHETIC CONCURRENT EDIT');
 expect(run('observe').stderr).toBe('AMBIGUOUS_OBSERVATION');expect(run().stderr).toBe('UNKNOWN_REQUIRES_OBSERVATION');
});
test('live process lock is never taken over',()=>{
 fs.writeFileSync(path.join(root,'worker.lock'),JSON.stringify({pid:process.pid,nonce}));
 expect(run().stderr).toBe('LOCK_REQUIRES_PARENT_OBSERVATION');
 expect(JSON.parse(read('worker.lock')).pid).toBe(process.pid);
});
test('uncommitted journal temporary file suspends rather than replacing it',()=>{
 fs.writeFileSync(path.join(root,'journal.next'),'SYNTHETIC INTERRUPTED JOURNAL');
 expect(run().stderr).toBe('UNRECONCILED_JOURNAL_TEMP');expect(read('journal.next')).toBe('SYNTHETIC INTERRUPTED JOURNAL');
});
test('corrupted journal digest suspends with no file effects',()=>{
 expect(run('forward','image-before').status).toBe(73);releaseObservedExitedChild();
 const envelope=JSON.parse(read('journal.json'));envelope.payload=envelope.payload.replace('dispatching','verified');
 fs.writeFileSync(path.join(root,'journal.json'),JSON.stringify(envelope));
 expect(run('observe').stderr).toBe('JOURNAL_DIGEST_MISMATCH');
 expect(read('source-image.txt')).toBe(text('image'));expect(exists('target-image.txt')).toBe(false);
});

test('idempotent repeat does not attest an edited completed destination',()=>{
 expect(run().status).toBe(0);fs.writeFileSync(path.join(root,'target-image.txt'),'SYNTHETIC LATER EDIT');
 expect(run().stderr).toBe('VERIFIED_DESTINATION_CHANGED');expect(read('target-image.txt')).toBe('SYNTHETIC LATER EDIT');
});


test('completed operation refuses an unreconciled journal temp even on retry',()=>{
 expect(run().status).toBe(0);
 fs.writeFileSync(path.join(root,'journal.next'),'SYNTHETIC UNCOMMITTED JOURNAL');
 expect(run().stderr).toBe('UNRECONCILED_JOURNAL_TEMP');
 expect(read('journal.next')).toBe('SYNTHETIC UNCOMMITTED JOURNAL');
});
test('rollback retry refuses an edited restored source',()=>{
 expect(run().status).toBe(0);expect(run('rollback').status).toBe(0);
 fs.writeFileSync(path.join(root,'source-image.txt'),'SYNTHETIC RESTORED EDIT');
 expect(run('rollback').stderr).toBe('ROLLBACK_CHANGED');
 expect(read('source-image.txt')).toBe('SYNTHETIC RESTORED EDIT');
});
