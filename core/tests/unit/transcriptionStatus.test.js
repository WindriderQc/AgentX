'use strict';
jest.mock('../../src/services/heavyWorkQueueService',()=>({list:jest.fn()}));
jest.mock('../../src/services/runtimeCoordinationService',()=>({listActive:jest.fn()}));
jest.mock('../../src/helpers/ollamaHostConfig',()=>({getConfiguredHosts:()=>[{name:'Fixture machine',url:'http://127.0.0.1:11434'}]}));
const queue=require('../../src/services/heavyWorkQueueService');
const coordination=require('../../src/services/runtimeCoordinationService');
const service=require('../../src/services/transcriptionStatusService');
const { planning }=require('../../src/services/transcriptionPresentation');
beforeEach(()=>{
 process.env.TRANSCRIPTIONS_ENABLED='true';process.env.VOIX_BASE_URL='http://127.0.0.1:18091';
 process.env.AGENTX_RUNTIME_RESOURCES_JSON=JSON.stringify([{id:'fixture-gpu',endpoints:[process.env.VOIX_BASE_URL,'http://127.0.0.1:11434']}]);
 coordination.listActive.mockResolvedValue({maintenance:null,workloads:[{kind:'benchmark',resourceIds:['different-gpu'],hosts:[]}],inferences:[]});
 queue.list.mockResolvedValue({jobs:[]});
 jest.spyOn(global,'fetch').mockImplementation(async(url,options)=>{
  expect(options.method).toBeUndefined();expect(options.redirect).toBe('error');
  const body=url.endsWith('/v1/models')?{default:'/private/models/fixture-whisper',data:[{id:'/private/models/fixture-whisper',configured_device:'cuda',configured_compute_type:'int8_float16'}]}
   :url.endsWith('/health')?{recognition:{available:true,degraded:false}}
   :{durable:true,maxSeconds:7200,maxDownloadBytes:2000000};
  return new Response(JSON.stringify(body));
 });
});
afterEach(()=>{jest.restoreAllMocks();delete process.env.TRANSCRIPTIONS_ENABLED;delete process.env.VOIX_BASE_URL;delete process.env.AGENTX_RUNTIME_RESOURCES_JSON;});
it('separates configuration from observed activity and tolerates an older native service',async()=>{
 const status=await service.snapshot();
 expect(status.configuration).toMatchObject({machine:{name:'Fixture machine'},model:'fixture-whisper',device:'cuda',modelSelectionSupported:false});
 expect(status.service).toMatchObject({ready:true,activity:null});
 expect(status.coordination.blockers).toEqual([]);
 expect(JSON.stringify(status)).not.toContain('/private/models');
});
it('shows only overlapping blockers and retains unknown release evidence',async()=>{
 coordination.listActive.mockResolvedValue({maintenance:null,workloads:[{kind:'profiler',resourceIds:['fixture-gpu'],hosts:[],recoveryRequired:true}],inferences:[]});
 const status=await service.snapshot();
 expect(status.coordination.blockers).toEqual([{type:'workload',kind:'profiler',uncertain:true}]);
});
it('does not call a model, infer free resources or fabricate limits when reads fail',async()=>{
 global.fetch.mockRejectedValue(Error('offline'));coordination.listActive.mockRejectedValue(Error('offline'));
 const status=await service.snapshot();
 expect(status.configuration.model).toBeNull();expect(status.service).toMatchObject({reachable:false,ready:false,activity:null});
 expect(status.coordination).toEqual({available:false,blockers:null});expect(status.limits).toBeNull();
});
it('uses the queue presentation for future and expired starts',()=>{
 const now=Date.parse('2030-01-01T12:00:00Z');
 const job={kind:'transcription',state:'reserved',executor:{transcriptionId:'fixture'},notBefore:'2030-01-01T13:00:00Z',
  reservation:{autoStart:true,start:'2030-01-01T13:30:00Z',end:'2030-01-01T16:30:00Z'}};
 expect(planning(job,now)).toMatchObject({earliestStartAt:'2030-01-01T13:30:00.000Z',nextAction:'wait_not_before',startMode:'automatic'});
 expect(planning(job,Date.parse('2030-01-02'))).toMatchObject({scheduleState:'expired'});
});
