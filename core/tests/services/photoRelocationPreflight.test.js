'use strict';
const assert = require('node:assert/strict');
const {createPhotoRelocationPreflight,BLOCKERS}=require('../../src/services/photos/photoRelocationPreflight');
const A='a'.repeat(64),B='b'.repeat(64),X='c'.repeat(64),M='d'.repeat(64);
function fixture(){
 const row={sha256:A,card:{_id:A,metadata:{type:'IMAGE'},frame:{selected:true},projection:{sha256:A,size:4},assetId:'synthetic-old',libraryId:'synthetic-owner'}};
 const snapshot={audience:'owner',manifestSha256:M,selection:[A],entries:[row]};
 const pair={sourceRoot:'/synthetic/source',destinationRoot:'/synthetic/frame',image:{source:'/synthetic/source/a.jpg',destination:'/synthetic/frame/a.jpg',sha256:A,size:4},xmp:{source:'/synthetic/source/a.jpg.xmp',destination:'/synthetic/frame/a.jpg.xmp',sha256:X,size:9}};
 const calls=[]; const deps={registry:{exportSelection:async()=>{calls.push('registry');return snapshot;}},resolve:async()=>{calls.push('resolve');return pair;},inspect:async r=>{calls.push('inspect');return {audience:'owner',migrationReady:false,image:{...r.image},xmp:{...r.xmp}};}};
 return {row,snapshot,pair,calls,deps,run:()=>createPhotoRelocationPreflight(deps).planSelection({audience:'owner',sha256s:[A]})};
}
test('bounded immutable owner preflight remains unexecutable despite valid evidence',async()=>{const f=fixture(),p=await f.run();assert.equal(p.executable,false);assert.equal(p.migrationReady,false);assert.deepEqual(p.blockers,BLOCKERS);assert.equal(Object.isFrozen(p.items[0].inventory),true);assert.deepEqual(f.calls,['registry','resolve','inspect','registry']);assert(Object.values(p.immichCopyOptions).every(x=>x===false));assert.deepEqual(p.effects,{databaseWrites:0,fileWrites:0,scans:0,modelCalls:0});});
test('audience rejected before resolver or DB',async()=>{const f=fixture();await assert.rejects(createPhotoRelocationPreflight(f.deps).planSelection({audience:'family',sha256s:[A]}));assert.equal(f.calls.length,0);});
test('missing trusted capability fails closed',async()=>{await assert.rejects(createPhotoRelocationPreflight().planSelection({audience:'owner',sha256s:[A]}),{code:'PHOTO_RELOCATION_NOT_CONFIGURED'});});
for(const change of [r=>r.card.frame.selected=false,r=>r.card.pendingDecision='pending',r=>r.card.metadata.type='VIDEO',r=>r.card.projection.sha256=B,r=>r.card.projection.size=0])test('unready card rejected before filesystem inspection '+change.toString(),async()=>{const f=fixture();change(f.row);await assert.rejects(f.run(),{code:'PHOTO_RELOCATION_CARD_NOT_READY'});assert.deepEqual(f.calls,['registry']);});
test('resolver cannot substitute content',async()=>{const f=fixture();f.pair.image.sha256=B;await assert.rejects(f.run(),{code:'PHOTO_RELOCATION_CONTENT_MISMATCH'});});
test('inspector cannot approve migration or substitute destination',async()=>{for(const change of [r=>({...r,migrationReady:true}),r=>({...r,image:{...r.image,destination:'/other'}})]){const f=fixture();f.deps.inspect=async r=>change({audience:'owner',migrationReady:false,image:r.image,xmp:r.xmp});await assert.rejects(f.run(),{code:'PHOTO_RELOCATION_INVENTORY_MISMATCH'});}});
test('registry drift refuses final plan',async()=>{const f=fixture();let n=0;f.deps.registry.exportSelection=async()=>({...f.snapshot,manifestSha256:n++?X:M});await assert.rejects(f.run(),{code:'PHOTO_RELOCATION_REGISTRY_CHANGED'});});

test('two selected images cannot propose one destination',async()=>{
 const f=fixture(),second=structuredClone(f.row);second.sha256=B;second.card._id=B;second.card.projection.sha256=B;
 f.snapshot.selection=[A,B];f.snapshot.entries.push(second);
 f.deps.resolve=async entry=>({...f.pair,image:{...f.pair.image,sha256:entry.sha256},xmp:{...f.pair.xmp}});
 await assert.rejects(createPhotoRelocationPreflight(f.deps).planSelection({audience:'owner',sha256s:[A,B]}),{code:'PHOTO_RELOCATION_TARGET_COLLISION'});
});
test('real synthetic file inventory and registry compose without any file changes',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
 const {createPhotoRelocationInventory}=require('../../src/services/photos/photoRelocationInventory');
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentx-pair-preflight-')));
 try {
  const source=path.join(root,'source'),dest=path.join(root,'frame');await fs.mkdir(source);await fs.mkdir(dest);
  const image=Buffer.from('fictional media bytes'),xmp=Buffer.from('<xmp>synthetic metadata</xmp>');
  const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),id=hash(image);
  const a=path.join(source,'fake.jpg'),b=path.join(dest,'fake.jpg');await fs.writeFile(a,image);await fs.writeFile(a+'.xmp',xmp);
  const f=fixture();f.row.sha256=id;f.row.card._id=id;f.row.card.projection={sha256:id,size:image.length};f.snapshot.selection=[id];
  f.deps.resolve=async()=>({sourceRoot:source,destinationRoot:dest,image:{source:a,destination:b,sha256:id,size:image.length},xmp:{source:a+'.xmp',destination:b+'.xmp',sha256:hash(xmp),size:xmp.length}});
  // Only this controlled test tree; not a native production reparse probe.
  f.deps.inspect=createPhotoRelocationInventory({inspectReparse:async()=>false}).inspectPair;
  const p=await createPhotoRelocationPreflight(f.deps).planSelection({audience:'owner',sha256s:[id]});
  assert.equal(p.migrationReady,false);assert.equal(p.items[0].inventory.image.sha256,id);
  assert.equal((await fs.readdir(dest)).length,0);assert((await fs.readFile(a)).equals(image));assert((await fs.readFile(a+'.xmp')).equals(xmp));
 } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('case and unicode variants conservatively collide across selected destinations',async()=>{
 for (const [one,two] of [['Photo.jpg','photo.jpg'],['café.jpg','cafe\u0301.jpg'],['photo.jpg','photo.jpg.']]) {
  const f=fixture(),second=structuredClone(f.row);second.sha256=B;second.card._id=B;second.card.projection.sha256=B;
  f.snapshot.selection=[A,B];f.snapshot.entries.push(second);
  f.deps.resolve=async e=>{const target='/synthetic/frame/'+(e.sha256===A?one:two);return {...f.pair,image:{...f.pair.image,sha256:e.sha256,destination:target},xmp:{...f.pair.xmp,destination:target+'.xmp'}};};
  await assert.rejects(createPhotoRelocationPreflight(f.deps).planSelection({audience:'owner',sha256s:[A,B]}),{code:'PHOTO_RELOCATION_TARGET_COLLISION'});
 }
});
