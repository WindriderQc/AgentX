'use strict';
const crypto=require('node:crypto');
const Cards=require('../../models/PhotoProcessingCard'),Batches=require('../../models/PhotoProcessingBatch');
const Runtime=require('../../models/RuntimeCoordination');
const queue=require('../../src/services/heavyWorkQueueService');
const control=require('../../src/services/photos/photoProcessingControl');
const writer=require('../../src/services/photos/photoProcessingWriter');
const drain=require('../../src/services/runtimeDrainIntent');
const {createSelectedAnalysis,digest}=require('../../src/services/photos/photoSelectedAnalysis');
const uuid=()=>crypto.randomUUID(),sha=n=>n.toString(16).padStart(64,'0');
const proposal={description:'Synthetic landscape',tags:['nature'],quality:'bonne',frameSuitability:'oui',reasons:[],privacyReview:false};
let input,deps,job,config,target,before,pause;
beforeEach(async()=>{
  drain.clear();await Promise.all([Cards,Batches,Runtime].map(m=>m.deleteMany({})));
  config={libraryId:uuid(),originalPathPrefix:'/external/fixture',nasHost:'http://127.0.0.1:3180'};
  target={host:'http://127.0.0.1:11434',model:'synthetic-vision'};
  pause=await control.pause({requestId:uuid(),expectedRevision:0},'synthetic-owner');
  const failedId=uuid(),failed={state:'failed',analysisId:failedId,card:{vision:'failed',error:'PHOTO_ANALYSIS_INVALID'}};
  await Cards.create([1,2].map(n=>({_id:sha(n),assetId:uuid(),libraryId:config.libraryId,
    metadata:{type:'IMAGE',exif:{description:'Extracted fact'}},projection:{runId:uuid(),requestId:uuid(),sha256:sha(n)},
    ...(n===2?{analysis:failed}:{}),review:{revision:3,approved:true,description:'Human description'},frame:{revision:2,selected:true}})));
  before=await Cards.find({}).sort({_id:1}).lean();
  input={operationId:uuid(),queueId:uuid(),dispatchId:uuid(),configHash:digest([config.libraryId,config.originalPathPrefix,config.nasHost]),
    targetHash:digest(target),controlRevision:pause.revision,controlRequestId:pause.requestId,receiptRef:'/private/synthetic-result.json',
    confirmation:'ANALYZE_ONLY_SELECTED_IMAGES_WHILE_PAUSED',items:before.map(c=>({sha256:c._id,analysisId:uuid(),
      previousAnalysisId:c.analysis?.analysisId||null,previousAnalysisSha256:digest(c.analysis??null)}))};
  job={id:input.queueId,key:'photo-analysis-reconcile:'+input.operationId,kind:'diagnostic',dispatchId:input.dispatchId,state:'dispatching',
    hosts:[config.nasHost,target.host],executor:{mode:'operator',receiptRef:input.receiptRef},
    reservation:{start:new Date(Date.now()-1000).toISOString(),end:new Date(Date.now()+600000).toISOString()}};
  jest.spyOn(queue,'get').mockImplementation(async()=>job);
  deps={config:()=>config,target:async()=>target,indexingIdle:async()=>true,
    client:{image:jest.fn(async()=>({bytes:Buffer.from('synthetic'),contentType:'image/jpeg'}))},
    immich:{validateLibrary:jest.fn(),asset:jest.fn(async p=>({id:before.find(c=>c._id===p.sha256).assetId,type:'IMAGE'})),pendingTag:jest.fn()},
    bridge:{call:jest.fn(async x=>x.op==='projection'?before.find(c=>c._id===x.sha256).projection:{exported:true,sha256:x.sha256,analysisId:x.analysisId})},
    inference:{execute:jest.fn(async()=>({ok:true,body:{message:{content:JSON.stringify(proposal)}}}))}};
});
afterEach(()=>{jest.restoreAllMocks();drain.clear();});
test('two selected attempts preserve pause, history, metadata and choices, while normal FIFO stays closed',async()=>{
  const waiting={_id:uuid(),runId:uuid(),items:[uuid()],state:'queued',queueId:uuid()};await Batches.create(waiting);
  const normal=jest.fn();deps.inference.execute.mockImplementation(async()=>{
    expect((await control.status()).paused).toBe(true);
    await require('../../src/services/photos/photoProcessingQueue').sweep({work:{run:normal}});
    return {ok:true,body:{message:{content:JSON.stringify(proposal)}}};
  });
  const result=await createSelectedAnalysis(deps)(input);expect(result.results).toHaveLength(2);
  const after=await Cards.find({}).sort({_id:1}).lean();
  for(let i=0;i<after.length;i++){
    expect(after[i].metadata).toEqual(before[i].metadata);expect(after[i].review).toEqual(before[i].review);expect(after[i].frame).toEqual(before[i].frame);
    expect(after[i].analysis.retry.previousAnalysis).toEqual(before[i].analysis??null);expect(after[i].analysis.state).toBe('completed');
  }
  const {idempotent,...pauseReceipt}=pause;
  expect(await control.status()).toEqual(pauseReceipt);expect(normal).not.toHaveBeenCalled();
  expect((await Batches.findById(waiting._id)).state).toBe('queued');
  expect(await createSelectedAnalysis(deps)(input)).toMatchObject({idempotent:true,inferenceReplayed:false});
  expect(deps.inference.execute).toHaveBeenCalledTimes(2);
});
test.each(['completed','running','unknown','wrong-hash','foreign-library','pending-review'])('refuses ineligible content: %s',async kind=>{
  const update=kind==='wrong-hash'?{'metadata.exif.description':'still a fact'}:kind==='foreign-library'?{libraryId:uuid()}
    :kind==='pending-review'?{pendingDecision:uuid()}:{analysis:{state:kind,analysisId:uuid()}};
  await Cards.updateOne({_id:sha(1)},{$set:update});if(kind==='wrong-hash')input.items[0].previousAnalysisSha256=sha(99);
  await expect(createSelectedAnalysis(deps)(input)).rejects.toMatchObject({code:'PHOTO_SELECTED_REFUSED'});
  expect(deps.inference.execute).not.toHaveBeenCalled();expect((await control.status()).paused).toBe(true);
});
test.each(['three','duplicate','changed-pause','wrong-queue','wrong-host','wrong-receipt','expired','changed-route'])('refuses a broadened or stale plan: %s',async kind=>{
  if(kind==='three')input.items.push({...input.items[0],sha256:sha(3),analysisId:uuid()});
  if(kind==='duplicate')input.items[1].sha256=input.items[0].sha256;
  if(kind==='changed-pause')input.controlRevision++;
  if(kind==='wrong-queue')job.key='photo-analysis-reconcile:'+uuid();
  if(kind==='wrong-host')job.hosts=['http://127.0.0.2:11434'];
  if(kind==='wrong-receipt')job.executor.receiptRef='different';
  if(kind==='expired')job.reservation.end=new Date(Date.now()-1).toISOString();
  if(kind==='changed-route')input.targetHash=sha(44);
  await expect(createSelectedAnalysis(deps)(input)).rejects.toMatchObject({code:'PHOTO_SELECTED_REFUSED'});
  expect(deps.inference.execute).not.toHaveBeenCalled();expect((await control.status()).paused).toBe(true);
});
test('a pause change racing the selected writer CAS admits no inference',async()=>{
  const change=Runtime.findOneAndUpdate.bind(Runtime);let changed=false;
  jest.spyOn(Runtime,'findOneAndUpdate').mockImplementation((filter,...rest)=>filter['photoProcessingControl.paused']!==true?change(filter,...rest):({lean:async()=>{
    if(!changed&&filter['photoProcessingControl.paused']===true){changed=true;await control.pause({requestId:uuid(),expectedRevision:pause.revision},'new-owner-pause');}
    return change(filter,...rest).lean();
  }}));
  await expect(createSelectedAnalysis(deps)(input)).rejects.toMatchObject({code:'PHOTO_SELECTED_REFUSED'});
  expect(deps.inference.execute).not.toHaveBeenCalled();expect((await control.status()).revision).toBe(pause.revision+1);
});
test.each(['provider','export','claim','writer-claim'])('an unknown %s outcome is fenced and never replayed',async kind=>{
  if(kind==='provider')deps.inference.execute.mockRejectedValue(Error('Unknown provider result'));
  if(kind==='export')deps.bridge.call.mockImplementation(async x=>{if(x.op==='projection')return before.find(c=>c._id===x.sha256).projection;throw Error('Lost export reply');});
  if(kind==='claim'){
    const write=Cards.findOneAndUpdate.bind(Cards);jest.spyOn(Cards,'findOneAndUpdate').mockImplementation((...args)=>({lean:async()=>{await write(...args).lean();throw Error('Lost claim reply');}}));
  }
  if(kind==='writer-claim'){
    const acquire=writer.acquireSelected;jest.spyOn(writer,'acquireSelected').mockImplementation(async row=>{await acquire(row);throw Error('Lost writer claim');});
  }
  await expect(createSelectedAnalysis(deps)(input)).rejects.toThrow();
  const state=await control.status();expect(state.paused).toBe(true);expect(state.inFlight[0].state).toBe('UNKNOWN');
  await expect(createSelectedAnalysis(deps)(input)).rejects.toMatchObject({code:'PHOTO_SELECTED_REFUSED'});
  expect(deps.inference.execute).toHaveBeenCalledTimes(['claim','writer-claim'].includes(kind)?0:1);
});
test('known invalid responses finish as failed proposals with their prior history retained',async()=>{
  deps.inference.execute.mockResolvedValue({ok:true,body:{message:{content:'invalid JSON'}}});
  const result=await createSelectedAnalysis(deps)(input);expect(result.results.every(r=>r.state==='failed')).toBe(true);
  expect((await control.status()).inFlight).toEqual([]);expect((await Cards.findById(sha(2))).analysis.retry.previousAnalysis).toEqual(before[1].analysis);
});
