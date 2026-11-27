'use strict';

const Task = require('../../models/PipelineTask');
const {readPipeline} = require('../../surfaces/work-cockpit/pipeline');

test('only native metadata of the configured engineering service reaches the cockpit', async () => {
  const service = 'technical-qa';
  const baseline = {title:'Recorded task', service, status:'review', updatedAt:new Date(), spec:'excluded text'};
  await Task.collection.insertMany([
    {...baseline, pipelineId:'9001', assignee:'excluded identity', transitions:[{to:'review',reason:'excluded reason',at:new Date()}]},
    {...baseline, pipelineId:'9002', source:'idea-drop'},
    {...baseline, pipelineId:'9003', source:'household-panel'},
    {...baseline, pipelineId:'9004', service:'other'},
    {...baseline, pipelineId:'9005', service:'personal'}
  ]);
  const result = await readPipeline({services:[service]});
  expect(result.records.map(row=>row.pipelineId)).toEqual(['9001']);
  expect(result.records[0]).toMatchObject({title:'Recorded task',status:'review',assigned:true,relationships:null,attempts:null});
  expect(result.records[0].transitions[0].to).toBe('review');
  expect(JSON.stringify(result)).not.toContain('excluded');
  const two=await readPipeline({services:[service,'other']});
  expect(two.records.map(row=>row.pipelineId).sort()).toEqual(['9001','9004']);
  expect((await readPipeline({services:['personal']})).records).toEqual([]);
});

test('a full window reports truncation using the additional real row', async () => {
  const service='window-qa';
  await Task.collection.insertMany(Array.from({length:251},(_,i)=>({
    pipelineId:String(9100+i), title:'QA', status:'queued',service,updatedAt:new Date(1000*i)
  })));
  const result=await readPipeline({services:[service]});
  expect(result.hasMore).toBe(true);
  expect(result.records).toHaveLength(250);
  expect(result.records[0].pipelineId).toBe('9350');
});
