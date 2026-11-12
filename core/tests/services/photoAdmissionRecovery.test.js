'use strict';
const crypto=require('node:crypto'),uuid=()=>crypto.randomUUID();
const {reconcile}=require('../../scripts/reconcile-photo-admission.cjs');
const Cards=require('../../models/PhotoProcessingCard'),Batches=require('../../models/PhotoProcessingBatch'),Runtime=require('../../models/RuntimeCoordination');
let input,deps;
beforeEach(async()=>{
 await Promise.all([Cards,Batches,Runtime].map(m=>m.deleteMany({})));
 input={operationId:uuid(),processingId:uuid(),queueId:uuid(),dispatchId:uuid(),analysisId:uuid(),sha256:'a'.repeat(64),receiptRef:'synthetic-proof',
  proof:{failureCode:'RUNTIME_INFERENCE_ADMISSION_DENIED',providerDispatched:false,originalWorkerTerminated:true,sourceBoundaryVerified:true},confirmation:'ADMISSION_REFUSED_BEFORE_PROVIDER_DISPATCH'};
 await Cards.create({_id:input.sha256,metadata:{type:'IMAGE'},review:{revision:0,approved:false},frame:{revision:0,selected:false},
  analysis:{state:'running',analysisId:input.analysisId,batchId:input.processingId,queueId:input.queueId}});
 await Batches.create({_id:input.processingId,state:'uncertain',queueId:input.queueId,dispatchId:input.dispatchId,error:input.proof.failureCode,progress:{phase:'analysis'}});
 deps={queue:{get:async()=>({id:input.queueId,state:'uncertain',dispatchId:input.dispatchId}),runtimeOverlaps:()=>true},indexingIdle:async()=>true};
});
test('known refused claims become terminal not-attempted cards with immutable recovery identity, without model or human effects',async()=>{
 expect(await reconcile(input,deps)).toMatchObject({state:'failed',providerReplayed:false});
 const c=await Cards.findById(input.sha256).lean();expect(c.analysis.analysisId).toBe(input.analysisId);
 expect(c.analysis.card).toMatchObject({vision:'not-attempted',error:input.proof.failureCode,reviewed:false});
 expect(c.review).toEqual({revision:0,approved:false});expect(c.frame).toEqual({revision:0,selected:false});
 expect(await reconcile(input,deps)).toMatchObject({idempotent:true});
 await expect(reconcile({...input,receiptRef:'changed'},deps)).rejects.toMatchObject({code:'PHOTO_REFUSAL_RECONCILIATION_REQUIRED'});
});
test.each([{providerDispatched:true},{originalWorkerTerminated:false},{sourceBoundaryVerified:false},{failureCode:'INFERENCE_TIMEOUT'}])('unknown outcomes refuse: %j',async patch=>{
 await expect(reconcile({...input,proof:{...input.proof,...patch}},deps)).rejects.toMatchObject({code:'PHOTO_REFUSAL_RECONCILIATION_REQUIRED'});
 expect((await Cards.findById(input.sha256)).analysis.state).toBe('running');
});
test('mismatched claims, held runtime and unsettled indexing retain the original fence',async()=>{
 await expect(reconcile({...input,analysisId:uuid()},deps)).rejects.toMatchObject({code:'PHOTO_REFUSAL_RECONCILIATION_REQUIRED'});
 await Runtime.create({_id:'runtime',inferences:[{admissionId:uuid(),generation:'test',principal:'test',requestId:uuid(),host:'http://test:11434',model:'synthetic',kind:'test',mode:'shared',residencyKey:'test',residencySpec:{},acquiredAt:new Date(),heartbeatAt:new Date(),expiresAt:new Date(Date.now()+60000)}]});
 await expect(reconcile(input,deps)).rejects.toMatchObject({code:'PHOTO_REFUSAL_RECONCILIATION_REQUIRED'});
 await Runtime.deleteMany({});await expect(reconcile(input,{...deps,indexingIdle:async()=>false})).rejects.toMatchObject({code:'PHOTO_REFUSAL_RECONCILIATION_REQUIRED'});
 expect((await Cards.findById(input.sha256)).analysis.state).toBe('running');
});
