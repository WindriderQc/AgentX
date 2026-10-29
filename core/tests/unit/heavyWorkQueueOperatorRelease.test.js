'use strict';
jest.mock('../../models/HeavyWorkQueue', () => ({ findById: jest.fn() }));
jest.mock('../../models/HeavyWorkQueueArchive', () => ({ findById: jest.fn() }));
jest.mock('../../models/RuntimeCoordination', () => ({ findById: jest.fn() }));
const Queue = require('../../models/HeavyWorkQueue');
const Runtime = require('../../models/RuntimeCoordination');
const queue = require('../../src/services/heavyWorkQueueService');
const A = 'http://127.0.0.1:11434', ALIAS = 'http://127.0.0.1:8188', B = 'http://127.0.0.1:11435';
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');
const job = () => ({ id:'synthetic', state:'dispatching', dispatchId:'dispatch', hosts:[hostUrlKey(A)], resourceIds:['synthetic-gpu'], executor:{ mode:'operator' } });
let current, runtime;
beforeEach(() => {
  process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id:'synthetic-gpu', endpoints:[A,ALIAS] }]);
  current=job(); runtime={ workloads:[],inferences:[] };
  Queue.findById.mockImplementation(() => ({ lean:async () => ({ jobs:[current] }) }));
  Runtime.findById.mockImplementation(() => ({ lean:async () => runtime }));
});
afterEach(() => { delete process.env.AGENTX_RUNTIME_RESOURCES_JSON; });
test('reads native release for this active operator dispatch without mutating a queue or runtime', async () => {
  await expect(queue.operatorRelease('synthetic','dispatch')).resolves.toMatchObject({
    contract:'agentx.operator-release/v1', authority:'core.runtime-coordination',
    queueRequestId:'synthetic', dispatchId:'dispatch',runtimeReleased:true,
  });
});
test.each(['workloads','inferences'])('held %s, including quarantine and physical aliases, refuse release', async field => {
  for (const holder of [{ host:A },{ host:ALIAS,resourceIds:['synthetic-gpu'],status:'quarantined' },{}]) {
    runtime[field]=[holder];
    expect((await queue.operatorRelease('synthetic','dispatch')).runtimeReleased).toBe(false);
  }
});
test('unrelated host admissions remain separate', async () => {
  runtime.inferences=[{ host:B,resourceIds:['other'] }];
  expect((await queue.operatorRelease('synthetic','dispatch')).runtimeReleased).toBe(true);
});
test('missing or malformed runtime never proves release', async () => {
  for (const value of [null,{}, {workloads:[],inferences:null}]) {
    runtime=value;
    await expect(queue.operatorRelease('synthetic','dispatch')).rejects.toMatchObject({code:'HEAVY_QUEUE_RELEASE_UNAVAILABLE'});
  }
});
test('lost runtime database read remains an error', async () => {
  Runtime.findById.mockImplementation(() => ({ lean:async () => { throw new Error('synthetic lost read'); } }));
  await expect(queue.operatorRelease('synthetic','dispatch')).rejects.toThrow('synthetic lost read');
});
test('wrong dispatch, terminal request and non-operator job refuse', async () => {
  await expect(queue.operatorRelease('synthetic','other')).rejects.toMatchObject({statusCode:409});
  current.state='completed';
  await expect(queue.operatorRelease('synthetic','dispatch')).rejects.toMatchObject({statusCode:409});
  current.state='running'; current.kind='other'; current.executor={mode:'island'};
  await expect(queue.operatorRelease('synthetic','dispatch')).resolves.toMatchObject({runtimeReleased:true});
  current.executor={};
  await expect(queue.operatorRelease('synthetic','dispatch')).rejects.toMatchObject({statusCode:409});
});
