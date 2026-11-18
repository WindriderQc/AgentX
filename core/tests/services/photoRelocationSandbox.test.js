'use strict';
const {createHash}=require('node:crypto');
const {createPhotoRelocationSandbox}=require('../fixtures/photoRelocationSandbox.cjs');
const sha=text=>createHash('sha256').update(text).digest('hex');
const plan=()=>({operationId:'synthetic-operation',items:[
 {id:'image',source:'original',destination:'frame',sha256:sha('image'),size:5},
 {id:'xmp',source:'projection-xmp',destination:'frame-xmp',sha256:sha('xmp'),size:3}]});
const setup=()=>createPhotoRelocationSandbox({original:'image','projection-xmp':'xmp'});
test('simulation finishes exact pair, repeats idempotently and returns detached journal',()=>{
 const model=setup(),out=model.run(plan());expect(out).toMatchObject({simulation:true,migrationReady:false,state:'completed'});
 expect(model.observe('original')).toBeNull();expect(model.observe('frame').sha256).toBe(sha('image'));
 expect(model.run(plan())).toEqual(out);out.items[0].state='unknown';expect(model.journal(out.operationId).items[0].state).toBe('verified');
});
test('same operation with different intent refuses',()=>{
 const model=setup();model.run(plan());const changed=plan();changed.items[0].destination='other';
 expect(()=>model.run(changed)).toThrow('OPERATION_IDENTITY_CONFLICT');
});
test.each(['before-effect','after-effect'])('unknown %s cannot replay, reconciles exact identities',fault=>{
 const model=setup();const unknown=model.run(plan(),{fault});expect(unknown.state).toBe('unknown');
 expect(()=>model.run(plan())).toThrow('UNKNOWN_DISPATCH');expect(()=>model.rollback(plan().operationId)).toThrow('UNKNOWN_DISPATCH');
 model.reconcile(plan().operationId);expect(model.run(plan()).state).toBe('completed');
});
test('unknown conflicting source/destination remains fenced',()=>{
 const model=setup();model.run(plan(),{fault:'after-effect'});model.edit('original','image');
 expect(()=>model.reconcile(plan().operationId)).toThrow('RECONCILIATION_AMBIGUOUS');
 expect(model.journal(plan().operationId).state).toBe('unknown');
});
test('changed source, existing destination and aliases refuse before effects',()=>{
 const model=setup();model.edit('original','edit');expect(()=>model.run(plan())).toThrow('SOURCE_CHANGED');
 const collision=setup();collision.edit('frame','image');expect(()=>collision.run(plan())).toThrow('DESTINATION_COLLISION');
 const alias=plan();alias.items[1].source='frame';expect(()=>setup().run(alias)).toThrow('PLAN_COLLISION');
});
test('rollback keeps original identity and repeats idempotently',()=>{
 const model=setup(),before=model.observe('original');model.run(plan());const result=model.rollback(plan().operationId);
 expect(result.state).toBe('rolled-back');expect(model.observe('original')).toEqual(before);expect(model.observe('frame')).toBeNull();
 expect(model.rollback(plan().operationId)).toEqual(result);expect(model.run(plan()).state).toBe('rolled-back');
});
test.each(['rollback-before-effect','rollback-after-effect'])('rollback %s must reconcile before retry',fault=>{
 const model=setup();model.run(plan());expect(model.rollback(plan().operationId,{fault}).state).toBe('rollback-unknown');
 expect(()=>model.rollback(plan().operationId)).toThrow('UNKNOWN_DISPATCH');model.reconcile(plan().operationId);
 expect(model.rollback(plan().operationId).state).toBe('rolled-back');
});
test('rollback refuses changed bytes, replacement identity even identical bytes and occupied source',()=>{
 for(const text of ['edited','xmp']){const model=setup();model.run(plan());model.edit('frame-xmp',text);
 expect(()=>model.rollback(plan().operationId)).toThrow('ROLLBACK_CHANGED');}
 const model=setup();model.run(plan());model.edit('projection-xmp','xmp');
 expect(()=>model.rollback(plan().operationId)).toThrow('ROLLBACK_COLLISION');
});
test('journal expected revision rejects stale caller',()=>{
 const model=setup();const state=model.run(plan(),{fault:'before-effect'});model.reconcile(plan().operationId);
 expect(()=>model.run(plan(),{expectedRevision:state.revision})).toThrow('JOURNAL_REVISION_CONFLICT');
});
test('partial successful pair can roll back without dispatching untouched item',()=>{
 const model=setup();model.run(plan(),{fault:'after-effect'});model.reconcile(plan().operationId);
 expect(model.rollback(plan().operationId).state).toBe('rolled-back');expect(model.observe('original')).not.toBeNull();
 expect(model.observe('projection-xmp')).not.toBeNull();
});
test('unknown fault enum cannot inject arbitrary code',()=>{
 expect(()=>setup().run(plan(),{fault:()=>{throw Error('never called');}})).toThrow('INVALID_FAULT');
});
test.each(['before-effect','after-effect'])('second member %s exposes non-atomic pair and resumes only after reconciliation',fault=>{
 const model=setup();const out=model.run(plan(),{fault,faultItemId:'xmp'});
 expect(out.state).toBe('unknown');expect(out.items.map(item=>item.state)).toEqual(['verified','unknown']);
 expect(model.observe('original')).toBeNull();expect(model.observe('frame')).not.toBeNull();
 expect(model.observe('projection-xmp')!==null).toBe(fault==='before-effect');
 expect(model.observe('frame-xmp')!==null).toBe(fault==='after-effect');
 expect(()=>model.run(plan())).toThrow('UNKNOWN_DISPATCH');model.reconcile(plan().operationId);
 expect(model.run(plan()).state).toBe('completed');expect(model.observe('projection-xmp')).toBeNull();
});
test.each(['before-effect','after-effect'])('second member %s can reconcile and roll back rather than finish forward',fault=>{
 const model=setup();model.run(plan(),{fault,faultItemId:'xmp'});model.reconcile(plan().operationId);
 expect(model.rollback(plan().operationId).state).toBe('rolled-back');
 expect(model.observe('original')).not.toBeNull();expect(model.observe('projection-xmp')).not.toBeNull();
 expect(model.observe('frame')).toBeNull();expect(model.observe('frame-xmp')).toBeNull();
});
test('reverse rollback restores XMP before image; later unknown remains fenced',()=>{
 const model=setup();model.run(plan());
 const out=model.rollback(plan().operationId,{fault:'rollback-before-effect',faultItemId:'image'});
 expect(out.state).toBe('rollback-unknown');expect(out.items.map(item=>item.state)).toEqual(['rollback-unknown','rolled-back']);
 expect(model.observe('projection-xmp')).not.toBeNull();expect(model.observe('frame-xmp')).toBeNull();
 expect(model.observe('frame')).not.toBeNull();expect(model.observe('original')).toBeNull();
 model.reconcile(plan().operationId);expect(model.rollback(plan().operationId).state).toBe('rolled-back');
});
test('fault item must identify an exact member, including rollback',()=>{
 const model=setup();for(const faultItemId of ['missing',null,1,{}])
 expect(()=>model.run(plan(),{faultItemId})).toThrow('INVALID_FAULT_ITEM');
 model.run(plan());expect(()=>model.rollback(plan().operationId,{faultItemId:'missing'})).toThrow('INVALID_FAULT_ITEM');
});
