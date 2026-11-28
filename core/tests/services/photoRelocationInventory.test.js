'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createPhotoRelocationInventory } = require('../../src/services/photos/photoRelocationInventory');
let root, input;
const hash = text => createHash('sha256').update(text).digest('hex');
const make = (options={}) => createPhotoRelocationInventory({inspectReparse:async()=>false,...options});
beforeEach(async()=>{
  root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'photo-inventory-synthetic-')));
  const sourceRoot=path.join(root,'source'),destinationRoot=path.join(root,'target');
  await fs.mkdir(sourceRoot); await fs.mkdir(destinationRoot);
  const source=path.join(sourceRoot,'synthetic.jpg'),destination=path.join(destinationRoot,'synthetic.jpg');
  await fs.writeFile(source,'image'); await fs.writeFile(source+'.xmp','xmp');
  input={sourceRoot,destinationRoot,image:{source,destination,sha256:hash('image'),size:5},
    xmp:{source:source+'.xmp',destination:destination+'.xmp',sha256:hash('xmp'),size:3}};
});
afterEach(async()=>{ if(root) await fs.rm(root,{recursive:true,force:true}); });
test('read-only intact pair evidence is recursively immutable, never migration-ready',async()=>{
  const output=await make().inspectPair(input);
  expect(output.migrationReady).toBe(false); expect(output.consistency).toBe('non-atomic-observation');
  expect(output.image.sha256).toBe(hash('image')); expect(output.image.nlink).toBeGreaterThan(0);
  expect(Object.isFrozen(output.image)).toBe(true); expect(Object.isFrozen(output.limitations)).toBe(true);
  expect(await fs.readFile(input.image.source,'utf8')).toBe('image');
  expect(await fs.readdir(input.destinationRoot)).toEqual([]);
});
test.each(['image','xmp'])('refuses %s collision even identical content',async key=>{
  await fs.writeFile(input[key].destination,key==='image'?'image':'xmp');
  await expect(make().inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_COLLISION'});
});
test.each(['image','xmp'])('refuses missing %s',async key=>{
  await fs.unlink(input[key].source); await expect(make().inspectPair(input)).rejects.toMatchObject({code:'ENOENT'});
});
test.each(['image','xmp'])('refuses wrong expected hash for %s',async key=>{
  input[key].sha256='0'.repeat(64); await expect(make().inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_BYTES'});
});
test('refuses size mismatch and missing expectations',async()=>{
  input.image.size=4; await expect(make().inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_CHANGED'});
  delete input.xmp.sha256; await expect(make().inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_EXPECTATION'});
});
test('refuses escaped roots, identical paths and detached sidecars',async()=>{
  input.image.destination=path.join(root,'outside.jpg');
  await expect(make().inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_SCOPE'});
  input.image.destination=path.join(input.destinationRoot,'synthetic.jpg'); input.xmp.destination=path.join(input.destinationRoot,'other.xmp');
  await expect(make().inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_PAIR'});
});
test('never creates a missing destination directory',async()=>{
  input.destinationRoot=path.join(root,'missing'); input.image.destination=path.join(input.destinationRoot,'synthetic.jpg');
  input.xmp.destination=input.image.destination+'.xmp';
  await expect(make().inspectPair(input)).rejects.toMatchObject({code:'ENOENT'});
  await expect(fs.stat(input.destinationRoot)).rejects.toMatchObject({code:'ENOENT'});
});
test('refuses junction traversal',async()=>{
  const alias=path.join(root,'alias'); let options={};
  try { await fs.symlink(input.sourceRoot,alias,process.platform==='win32'?'junction':'dir'); }
  catch(error) {
    if (!['EPERM','EACCES','ENOTSUP'].includes(error.code)) throw error;
    await fs.mkdir(alias);
    options={fs:{...fs,lstat:async (file,options)=>{const stat=await fs.lstat(file,options);
      if(file===alias)stat.isSymbolicLink=()=>true;return stat;}}};
  }
  input.sourceRoot=alias; input.image.source=path.join(alias,'synthetic.jpg'); input.xmp.source=input.image.source+'.xmp';
  await expect(make(options).inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_LINK'});
});
test('Windows native reparse observation is required and fail closed',async()=>{
  await expect(make({platform:'win32',inspectReparse:undefined}).inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_REPARSE_UNVERIFIED'});
  await expect(make({platform:'win32',inspectReparse:async()=>true}).inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_REPARSE_UNVERIFIED'});
});
test('cross-device observation refuses without copying',async()=>{
  const wrapped={...fs,lstat:async (file,options)=>{const stat=await fs.lstat(file,options);if(file===input.destinationRoot)stat.dev+=1n;return stat;}};
  await expect(make({fs:wrapped}).inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_CROSS_DEVICE'});
});
test('read handle identity change refuses',async()=>{
  const wrapped={...fs,open:async(...args)=>{const handle=await fs.open(...args); return {close:()=>handle.close(),
    stat:async(options)=>{const stat=await handle.stat(options);stat.ino+=1n;return stat;},read:(...a)=>handle.read(...a)};}};
  await expect(make({fs:wrapped}).inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_CHANGED'});
});
test('hardlink count is recorded without claiming independent backup',async()=>{
  await fs.link(input.image.source,path.join(input.sourceRoot,'synthetic-other.jpg'));
  const output=await make().inspectPair(input); expect(output.image.nlink).toBeGreaterThan(1);
  expect(output.limitations.join(' ')).toMatch(/not independent backup/);
});
test('trusted managed sidecar source may differ from canonical image directory',async()=>{
  const gallery=path.join(input.sourceRoot,'managed-gallery'); await fs.mkdir(gallery);
  const sidecar=path.join(gallery,'projection.jpg.xmp'); await fs.rename(input.xmp.source,sidecar);
  input.xmp.source=sidecar;
  const output=await make().inspectPair(input);
  expect(output.xmp.source).toBe(sidecar);
  expect(output.xmp.destination).toBe(output.image.destination+'.xmp');
  expect(await fs.readFile(sidecar,'utf8')).toBe('xmp');
});

(process.platform==='win32'?test.each:test.skip.each)(['CON.jpg','aux.xmp','LPT9.png','COM1','trailing.','trailing ','bad?.jpg','bad|name.jpg'])('Windows rejects ambiguous destination %s before access',async name=>{
 input.image.destination=path.join(input.destinationRoot,name);input.xmp.destination=input.image.destination+'.xmp';
 await expect(make().inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_PATH'});
});
test('managed sidecar cannot share image inode',async()=>{
 await fs.unlink(input.xmp.source);await fs.link(input.image.source,input.xmp.source);
 input.xmp.sha256=input.image.sha256;input.xmp.size=input.image.size;
 await expect(make().inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_SIDECAR_SHARED'});
});
test('managed sidecar cannot have another hardlink even to a non-image file',async()=>{
 await fs.link(input.xmp.source,path.join(input.sourceRoot,'sidecar-alias'));
 await expect(make().inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_SIDECAR_SHARED'});
});
// Reproduce IDs that IEEE-754 Number would collapse into one apparent inode.
function largeIdentityFs({changeHandle=false,changeTime=false}={}) {
 const base=9007199254740992n;
 function patch(stat,file,handle=false){
  if(file===input.image.source)stat.ino=base+(handle&&changeHandle?1n:0n);
  if(file===input.xmp.source)stat.ino=base+1n;
  if(handle&&changeTime)stat.mtimeNs+=1n;
  return stat;
 }
 return {...fs,lstat:async(file,options)=>{
  expect(options).toEqual({bigint:true});return patch(await fs.lstat(file,options),file);
 },open:async(file,...args)=>{
  const handle=await fs.open(file,...args);return {close:()=>handle.close(),read:(...values)=>handle.read(...values),
   stat:async options=>{expect(options).toEqual({bigint:true});return patch(await handle.stat(options),file,true);}};
 }};
}
test('distinct >2^53 inodes never become a falsely shared sidecar; evidence is exact JSON',async()=>{
 expect(Number(9007199254740992n)).toBe(Number(9007199254740993n));
 const output=await make({fs:largeIdentityFs()}).inspectPair(input);
 expect(output.image.inode).toBe('9007199254740992');expect(output.xmp.inode).toBe('9007199254740993');
 expect(typeof output.image.device).toBe('string');expect(output.image.mtimeNs).toMatch(/^-?\d+$/);
 expect(()=>JSON.stringify(output)).not.toThrow();
});
test('one-unit >2^53 inode replacement cannot pass handle identity checks',async()=>{
 await expect(make({fs:largeIdentityFs({changeHandle:true})}).inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_CHANGED'});
});
test('one-nanosecond change cannot disappear through millisecond rounding',async()=>{
 await expect(make({fs:largeIdentityFs({changeTime:true})}).inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_CHANGED'});
});
test('adapter dropping bigint option is rejected instead of silently rounding identity',async()=>{
 const wrapped={...fs,lstat:async file=>fs.lstat(file)};
 await expect(make({fs:wrapped}).inspectPair(input)).rejects.toMatchObject({code:'PHOTO_RELOCATION_STAT_PRECISION'});
});
