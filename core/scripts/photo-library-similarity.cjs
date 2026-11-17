#!/usr/bin/env node
'use strict';
// Run in Core's installed environment, inside a recorded operator queue window.
// stdin: { operationId, queueId, dispatchId }. Never runs inference or an Immich scan.
const mongoose=require('mongoose');
const {loadProcessingConfig}=require('../src/services/photos/photoProcessingConfig');
const {createImmichClient}=require('../src/services/photos/immichClient');
const {createSimilarityIndex}=require('../src/services/photos/photoLibrarySimilarity');
const {id}=require('../src/services/photos/phoneLibrary');
(async()=>{
  try {
    let raw='';for await(const chunk of process.stdin) {raw+=chunk;if(raw.length>2048)throw Error('Input too large');}
    const input=JSON.parse(raw);
    if(Object.keys(input).some(k=>!['operationId','queueId','dispatchId'].includes(k)))throw Error('Unknown input');
    for(const k of ['operationId','queueId','dispatchId'])id(input[k]);
    await mongoose.connect(process.env.MONGODB_URI);
    const assertAdmitted=async()=>{
      const job=await require('../src/services/heavyWorkQueueService').get(input.queueId);
      const now=Date.now();
      if(job.state!=='dispatching'||job.dispatchId!==input.dispatchId||job.executor?.mode!=='operator'
        ||!Number.isFinite(Date.parse(job.reservation?.start))||!Number.isFinite(Date.parse(job.reservation?.end))
        ||now<Date.parse(job.reservation.start)||now>=Date.parse(job.reservation.end))
        throw Error('Operator queue admission is not current');
    };
    const result=await createSimilarityIndex({config:loadProcessingConfig,client:createImmichClient()})({
      operationId:input.operationId,assertAdmitted,progress:value=>console.log(JSON.stringify({progress:value})),
    });
    const sizes=new Map();for(const e of result.entries)sizes.set(e.groupId,(sizes.get(e.groupId)||0)+1);
    console.log(JSON.stringify({operationId:input.operationId,sourceCount:result.sourceCount,indexed:result.entries.length,
      failedCount:result.failedCount,groups:sizes.size,similarGroups:[...sizes.values()].filter(n=>n>1).length,
      groupedImages:[...sizes.values()].filter(n=>n>1).reduce((a,b)=>a+b,0)}));
  }finally{await mongoose.disconnect();}
})().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
