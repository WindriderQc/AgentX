#!/usr/bin/env node
'use strict';
// Core-owned operator recovery for a *known rejected* attempt. This records a
// terminal not-attempted card; it never clears/retries a possibly sent model call.
const { createRequire } = require('node:module'), path = require('node:path');
const app = createRequire(path.join(process.cwd(),'package.json'));
const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function refusal(message) { return Object.assign(new Error(message),{code:'PHOTO_REFUSAL_RECONCILIATION_REQUIRED'}); }
async function reconcile(input,deps={}) {
  const {operationId,processingId,queueId,dispatchId,analysisId,sha256,receiptRef,proof}=input||{};
  if (![operationId,processingId,queueId,dispatchId,analysisId].every(v=>UUID.test(v||''))
    || !/^[a-f0-9]{64}$/.test(sha256||'') || typeof receiptRef!=='string' || !receiptRef.length || receiptRef.length>500
    || proof?.failureCode!=='RUNTIME_INFERENCE_ADMISSION_DENIED' || proof.providerDispatched!==false
    || proof.originalWorkerTerminated!==true || proof.sourceBoundaryVerified!==true
    || input.confirmation!=='ADMISSION_REFUSED_BEFORE_PROVIDER_DISPATCH') throw refusal('Exact native pre-dispatch refusal evidence is required');
  const cards=deps.cards||app('./models/PhotoProcessingCard'),batches=deps.batches||app('./models/PhotoProcessingBatch');
  const queue=deps.queue||app('./src/services/heavyWorkQueueService');
  const runtimeModel=deps.runtime||app('./models/RuntimeCoordination');
  const inputHash=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const card=await cards.findById(sha256).lean();
  if(card?.analysis?.reconciliation?.operationId===operationId){
    if(card.analysis.reconciliation.inputHash!==inputHash)throw refusal('Recovery identity has different evidence');
    return {sha256,analysisId,state:card.analysis.state,providerReplayed:false,idempotent:true};
  }
  const row=await batches.findById(processingId).lean(),job=await queue.get(queueId);
  if(row?.state!=='uncertain'||row.error!==proof.failureCode||row.progress?.phase!=='analysis'
    || row.queueId!==queueId||row.dispatchId!==dispatchId||job.state!=='uncertain'||job.dispatchId!==dispatchId
    || card?.analysis?.state!=='running'||card.analysis.analysisId!==analysisId
    || card.analysis.batchId!==processingId||card.analysis.queueId!==queueId)
    throw refusal('The original batch, dispatch and rejected analysis claim must match');
  const runtime=await runtimeModel.findById('runtime').lean();
  if(runtime?.maintenance||[...(runtime?.workloads||[]),...(runtime?.inferences||[])].some(i=>queue.runtimeOverlaps(job,i)))
    throw refusal('Native runtime authority remains held');
  const idle=deps.indexingIdle||(async()=>app('./src/services/photos/photoProcessingWork').queuesIdle(
    await app('./src/services/photos/immichClient').createImmichClient().json('/jobs')));
  if(!await idle())throw refusal('Indexing effects must have settled');
  const reconciliation={operationId,inputHash,receiptRef,code:proof.failureCode,providerDispatched:false,
    authority:'core.photo-processing.operator',observedAt:new Date().toISOString()};
  const analysis={...card.analysis,state:'failed',reconciliation,card:{schema:'agentx.photo-metadata/v1',
    analysisId,sourceSha256:sha256,metadata:card.metadata,reviewed:false,vision:'not-attempted',error:proof.failureCode}};
  const updated=await cards.findOneAndUpdate({_id:sha256,'analysis.state':'running','analysis.analysisId':analysisId,
    'analysis.queueId':queueId,'analysis.batchId':processingId},{$set:{analysis}},{new:true,writeConcern:{w:1,j:true}}).lean();
  if(!updated)throw refusal('The original analysis claim changed');
  return {sha256,analysisId,state:updated.analysis.state,providerReplayed:false,idempotent:false};
}
async function main(){
  const input=JSON.parse(Buffer.from(process.env.PHOTO_ADMISSION_RECOVERY||'','base64').toString('utf8'));
  const mongoose=app('mongoose');await mongoose.connect(process.env.MONGODB_URI);
  try{console.log(JSON.stringify(await reconcile(input)));}finally{await mongoose.disconnect();}
}
if(require.main===module||process.env.PHOTO_ADMISSION_RECOVERY_STDIN==='1')main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={reconcile};
