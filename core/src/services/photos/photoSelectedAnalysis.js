'use strict';
const crypto = require('node:crypto');
const Cards = require('../../../models/PhotoProcessingCard');
const Batches = require('../../../models/PhotoProcessingBatch');
const { loadProcessingConfig, UUID } = require('./photoProcessingConfig');
const { createImmichClient } = require('./immichClient');
const { createPhotoProcessingBridge } = require('./photoProcessingBridge');
const { createPhotoProcessingImmich } = require('./photoProcessingImmich');
const { fail } = require('./importFiles');
const SHA = /^[a-f0-9]{64}$/, WC = { w: 1, j: true };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refuse = message => fail('PHOTO_SELECTED_REFUSED', message);
function validate(input) {
  const keys = ['operationId','queueId','dispatchId','configHash','targetHash','controlRevision','controlRequestId','receiptRef','confirmation','items'];
  if (!input || Object.keys(input).some(k=>!keys.includes(k))
    || !['operationId','queueId','dispatchId','controlRequestId'].every(k=>UUID.test(input[k]||''))
    || !['configHash','targetHash'].every(k=>SHA.test(input[k]||''))
    || !Number.isSafeInteger(input.controlRevision) || input.controlRevision<1
    || typeof input.receiptRef!=='string' || !input.receiptRef.length || input.receiptRef.length>500
    || input.confirmation!=='ANALYZE_ONLY_SELECTED_IMAGES_WHILE_PAUSED'
    || !Array.isArray(input.items) || input.items.length<1 || input.items.length>2) throw refuse('A bounded, explicit operator plan is required');
  for (const item of input.items) {
    if (!item || Object.keys(item).sort().join()!=='analysisId,previousAnalysisId,previousAnalysisSha256,sha256'
      || !SHA.test(item.sha256||'') || !SHA.test(item.previousAnalysisSha256||'') || !UUID.test(item.analysisId||'')
      || !(item.previousAnalysisId===null || UUID.test(item.previousAnalysisId||''))
      || item.analysisId===item.previousAnalysisId) throw refuse('Exact content and attempt identities are required');
  }
  for (const key of ['sha256','analysisId']) if (new Set(input.items.map(i=>i[key])).size!==input.items.length)
    throw refuse('Each selected content and new attempt must be distinct');
}
function eligible(card,item,libraryId) {
  if (!card || card.libraryId!==libraryId || card.metadata?.type!=='IMAGE' || card.pendingDecision
    || digest(card.analysis??null)!==item.previousAnalysisSha256) return false;
  if (!card.analysis) return item.previousAnalysisId===null;
  return card.analysis.state==='failed' && card.analysis.analysisId===item.previousAnalysisId
    && card.analysis.card?.vision==='failed' && card.analysis.card.error==='PHOTO_ANALYSIS_INVALID';
}
function createSelectedAnalysis(deps={}) {
  const cards=deps.cards||Cards,batches=deps.batches||Batches;
  const writer=deps.writer||require('./photoProcessingWriter'), control=deps.control||require('./photoProcessingControl');
  const queue=deps.queue||require('../heavyWorkQueueService'),now=deps.now||Date.now;
  return async function execute(input) {
    validate(input);const inputHash=digest(input);
    const config=(deps.config||loadProcessingConfig)();
    if (!config || digest([config.libraryId,config.originalPathPrefix,config.nasHost])!==input.configHash)
      throw refuse('The reviewed library configuration changed');
    const existing=await batches.findById(input.operationId).lean();
    if (existing) {
      if (existing.inputHash!==inputHash || existing.state!=='completed' || await writer.held(existing))
        throw refuse('Observe the original operator attempt and writer; never repeat a possibly dispatched analysis');
      for (const item of input.items) {
        const card=await cards.findById(item.sha256).lean();
        if (card?.analysis?.analysisId!==item.analysisId || card.analysis.retry?.inputHash!==inputHash
          || !card.analysis.retry.exported || !['completed','failed'].includes(card.analysis.state))
          throw refuse('The completed receipt no longer matches the selected attempt');
      }
      return {operationId:input.operationId,idempotent:true,inferenceReplayed:false,results:existing.operatorAttempt.results};
    }
    const target=await (deps.target||require('./photoProcessingQueue').target)();
    if (digest(target)!==input.targetHash) throw refuse('The reviewed analysis route changed');
    async function window(remaining=0) {
      const job=await queue.get(input.queueId),normal=require('../heavyWorkQueueContract').hosts;
      const state=await control.status();
      if (!state.paused || state.revision!==input.controlRevision || state.requestId!==input.controlRequestId
        || job.state!=='dispatching' || job.dispatchId!==input.dispatchId || job.kind!=='diagnostic'
        || job.key!=='photo-analysis-reconcile:'+input.operationId || job.executor?.mode!=='operator'
        || job.executor.receiptRef!==input.receiptRef
        || normal(job.hosts).join()!==normal([config.nasHost,target.host]).join()
        || !Number.isFinite(Date.parse(job.reservation?.start)) || !Number.isFinite(Date.parse(job.reservation?.end))
        || now()<Date.parse(job.reservation.start) || now()+remaining>=Date.parse(job.reservation.end))
        throw refuse('The exact operator window and unchanged durable pause are required');
    }
    await window(input.items.length*240000);
    const originals=[];
    for (const item of input.items) {
      const card=await cards.findById(item.sha256).lean();
      if (!eligible(card,item,config.libraryId)) throw refuse('Only an absent first analysis or a known completed invalid proposal is eligible');
      originals.push(card);
    }
    const row={_id:input.operationId,runId:originals[0].projection?.runId,
      items:originals.map(c=>c.projection?.requestId),queueId:input.queueId,dispatchId:input.dispatchId,
      processId:crypto.randomUUID(),target,configHash:input.configHash,inputHash,state:'claimed',
      operatorAttempt:{kind:'selected-images-while-paused',controlRevision:input.controlRevision,
        controlRequestId:input.controlRequestId,receiptRef:input.receiptRef,sha256:input.items.map(i=>i.sha256)}};
    if (row.items.some(id=>!UUID.test(id||''))) throw refuse('Every selected image must retain its original projection identity');
    const client=deps.client||createImmichClient(),bridge=deps.bridge||createPhotoProcessingBridge({config:()=>config});
    const immich=deps.immich||createPhotoProcessingImmich({client,bridge,config:()=>config});
    const idle=deps.indexingIdle||(async()=>require('./photoProcessingWork').queuesIdle(await client.json('/jobs')));
    await batches.create([row],{writeConcern:WC});
    let acquired=false,fenced=false;const results=[];
    try {
      fenced=true;
      if (!await writer.acquireSelected(row)) {fenced=false;throw refuse('The selected writer could not be admitted without changing the pause');}
      acquired=true;fenced=false;await immich.validateLibrary();
      if (!await idle()) throw refuse('Existing indexing must settle first');
      for (const item of input.items) {
        const card=await cards.findById(item.sha256).lean();
        if (!eligible(card,item,config.libraryId)) throw refuse('Selected content changed after admission');
        const projection=await bridge.call({op:'projection',sha256:item.sha256});
        if (!projection || projection.sha256!==item.sha256) throw refuse('A freshly verified original reference is required');
        const asset=await immich.asset(projection);
        if (!asset || asset.id!==card.assetId || asset.type!=='IMAGE') throw refuse('The selected Immich asset changed');
        const preview=await client.image('/assets/'+asset.id+'/thumbnail?size=preview');
        await window(240000);await writer.assert(row);
        const marker={operationId:input.operationId,inputHash,previousAnalysis:card.analysis??null,
          receiptRef:input.receiptRef,exported:false};
        const filter={_id:item.sha256,libraryId:config.libraryId,pendingDecision:{$exists:false},
          assetId:card.assetId,analysis:card.analysis??null};
        fenced=true;
        const claimed=await cards.findOneAndUpdate(filter,{$set:{analysis:{state:'running',analysisId:item.analysisId,
          batchId:row._id,queueId:row.queueId,startedAt:new Date(now()),retry:marker}}},{new:true,writeConcern:WC}).lean();
        if (!claimed) {fenced=false;throw refuse('Another attempt already owns this image');}
        await batches.updateOne({_id:row._id,processId:row.processId},{$push:{projections:projection},
          $set:{state:'running',progress:{phase:'analysis',selected:input.items.length,completed:results.length}}},{writeConcern:WC});
        const engine=require('./photoAnalysis'),inference=deps.inference||require('../../extensions/trustedRuntimeServices').createTrustedRuntimeServices().inference;
        let result,state='completed';
        try {result={...await engine.analyze({inference,...preview,sha256:item.sha256,analysisId:item.analysisId,queueId:input.queueId,target}),metadata:card.metadata};}
        catch(error) {
          if (!engine.completedAnalysisFailure(error)) throw error;
          state='failed';result={schema:'agentx.photo-metadata/v1',analysisId:item.analysisId,sourceSha256:item.sha256,
            metadata:card.metadata,reviewed:false,vision:'failed',error:error.code};
        }
        if (item.previousAnalysisId) result.retryOf=item.previousAnalysisId;
        const saved=await cards.findOneAndUpdate({_id:item.sha256,'analysis.analysisId':item.analysisId,'analysis.state':'running',
          'analysis.retry.operationId':input.operationId},{$set:{analysis:{state,analysisId:item.analysisId,card:result,retry:marker}}},
        {new:true,writeConcern:WC}).lean();
        if (!saved) throw refuse('Observe the original inference result before export');
        await window();await writer.assert(row);
        if (!saved.review?.revision && !saved.pendingDecision) await immich.pendingTag(asset.id,{sha256:item.sha256,
          baselineTags:card.metadata?.tags||[],baselineIncomplete:Boolean(card.metadata?.tagsTruncated||card.metadata?.truncatedFields?.includes('tags'))});
        const exported=await bridge.call({op:'exportCard',sha256:item.sha256,analysisId:item.analysisId,card:result});
        if (exported?.exported!==true || exported.sha256!==item.sha256 || exported.analysisId!==item.analysisId)
          throw refuse('Observe the original portable export receipt');
        if (!await idle()) throw refuse('Observe outstanding metadata work before releasing this attempt');
        await cards.updateOne({_id:item.sha256,'analysis.analysisId':item.analysisId,'analysis.retry.operationId':input.operationId},
          {$set:{'analysis.retry.exported':true}},{writeConcern:WC});
        results.push({sha256:item.sha256,analysisId:item.analysisId,previousAnalysisId:item.previousAnalysisId,state,exported:true});
        fenced=false;
      }
      fenced=true;
      await batches.updateOne({_id:row._id,processId:row.processId},{$set:{state:'completed',finishedAt:new Date(now()),
        progress:{phase:'completed',selected:input.items.length,completed:results.length,failedAnalyses:results.filter(r=>r.state==='failed').length},
        'operatorAttempt.results':results}},{writeConcern:WC});
      // A lost terminal acknowledgement cannot silently release the writer.
      await writer.release(row);fenced=false;
      return {operationId:input.operationId,results,idempotent:false,pausePreserved:true,ownerDecisionsCreated:0};
    } catch(error) {
      if (fenced) {
        await writer.unknown(row);
        await batches.updateOne({_id:row._id,processId:row.processId},{$set:{state:'uncertain',error:error.code||'PHOTO_SELECTED_UNKNOWN'}},{writeConcern:WC});
      } else {
        await batches.updateOne({_id:row._id,processId:row.processId},{$set:{state:'failed',error:error.code||'PHOTO_SELECTED_REFUSED',
          'operatorAttempt.results':results}},{writeConcern:WC});
        if (acquired) await writer.release(row);
      }
      throw error;
    }
  };
}
module.exports={createSelectedAnalysis,digest,validate};
