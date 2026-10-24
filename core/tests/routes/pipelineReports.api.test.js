'use strict';
const crypto = require('crypto');
const express = require('express');
const Task = require('../../models/PipelineTask');
const Run = require('../../models/PipelineReportRun');
const File = require('../../models/PipelineTaskDeliverable');
const reports = require('../../src/services/pipelineReportService');
const inference = require('../../src/services/pipelineReportInference');
const files = require('../../src/services/pipelineTaskDeliverableService');
const config = require('../../src/services/modelRouterConfig');
const authority = require('../../src/services/pipelineReportAuthority');
const queue = require('../../src/services/heavyWorkQueueService');
const { buildTransition } = require('../../src/services/pipelineTaskTransitions');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const KEY = '11111111-2222-4333-8444-555555555555';
const CALL = '22222222-2222-4333-8444-555555555555';
const NEXT = '33333333-2222-4333-8444-555555555555';
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
let harness, nativeDeps;
const { PassThrough } = require('stream');
const { executeRoutedInference } = require('../../src/extensions/trustedRuntimeServices');
const { parseGatewayClients } = require('../../integrations/runtime-bridges/llm-gateway/clients');
const { registerLlmGateway } = require('../../integrations/runtime-bridges/llm-gateway/router');
// The Coding Team reaches Core's OpenAI gateway as token client `coding-team`.
const GATEWAY_TOKEN = 'coding-team-test-token-01';
const registerCodingGateway = options => registerLlmGateway({ ...options,
  clients: parseGatewayClients(JSON.stringify({ 'coding-team': GATEWAY_TOKEN })) });
const withGatewayToken = (req, _res, next) => { req.headers.authorization = `Bearer ${GATEWAY_TOKEN}`; next(); };
beforeAll(async () => {
  await File.createCollection(); await File.createIndexes();
  await Run.createCollection(); await Run.createIndexes();
  const app = express().use(express.json({ limit: '5mb' })).use('/api/pipeline', require('../../routes/pipeline-deliverables'))
    .use('/api/pipeline', require('../../routes/pipeline-feedback'))
    .use('/api/pipeline', require('../../routes/pipeline'));
  app.use(withGatewayToken, registerCodingGateway({ express, logger: {}, runtimeServices: {
    routing: { getEffectiveSnapshot: async () => ({ tasks: { code_generation: { model: 'synthetic-local-model' } } }) },
    inference: { execute: (input, options) => executeRoutedInference(nativeDeps, input, options) },
  } }));
  harness = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await harness?.close(); });
beforeEach(async () => {
  await Promise.all([Task.deleteMany({}), Run.deleteMany({}), File.deleteMany({}), require('../../models/PipelineReportAdmission').deleteMany({})]);
  authority.configureControl({status: async () => ({busy:false})});
  jest.spyOn(queue, 'get').mockResolvedValue({id:NEXT,dispatchId:CALL,dispatchedAt:new Date(Date.now()-30000).toISOString(),startBefore:new Date(Date.now()-1000).toISOString(),state:'running',executor:{mode:'operator'},source:{type:'coding',ref:'synthetic-session',taskId:'0001'},hosts:['http://ollama.invalid:11434'],reservation:{start:new Date(Date.now()-60000).toISOString(),end:new Date(Date.now()+14400000).toISOString()}});
  jest.spyOn(config, 'ensureTaskModelOverridesLoaded').mockResolvedValue();
  jest.spyOn(config, 'getModelForTask').mockReturnValue({ model: 'synthetic-local-model', url: 'http://ollama.invalid:11434' });
});
afterEach(() => jest.restoreAllMocks());

async function fixture(extra = {}, limit = 128) {
  const owner = await Task.create({ pipelineId: '0001', title: 'Report fixture', spec: 'Review every Markdown document.',
    service: 'agentx-coding', status: 'in_progress', assignee: 'coding-team', transitionSeq: 2,
    transitions: [buildTransition({ pipelineId: '0001', status: 'queued', transitionSeq: 1 },
      { to: 'in_progress', kind: 'claimed', channel: 'worker_api', declaredActor: 'coding-team' })], ...extra });
  const intent = { claimSeq: 2, specSha256: digest(owner.spec), sourceCommit: 'a'.repeat(40), reportName: 'review.md',
    model: 'synthetic-local-model', hardRemainingSeconds: 7200,
    inventory:{sourceCommit:'a'.repeat(40),documents:[{path:'README.md',sha256:digest('fixture document')}]}};
  const profile={reportName:'review.md',modelCallLimit:limit};
  const state=await authority.prepare(owner.toObject(),profile,{key:KEY,queueRequestId:NEXT,confirm:true,additionalRuns:1,budget:{modelCalls:256,workSeconds:14400}});
  await Task.updateOne({_id:owner._id},{$set:{codingResult:{profile:'report',...profile},codingReportAuthority:state}});
  return { owner, intent };
}
const start = body => harness.request.post(`/api/pipeline/tasks/0001/reports/${KEY}/start`).send(body);
const result = body => harness.request.post(`/api/pipeline/tasks/0001/reports/${KEY}/result`).send(body);
const bytes = (text = '# Partial review\n\nREADME checked; other documents pending.\n') => ({
  dataUrl: 'data:text/markdown;base64,' + Buffer.from(text).toString('base64'), sha256: digest(text),
});
async function call(id = CALL) {
  return inference.prepare({ 'x-agentx-report-request': KEY, 'x-agentx-report-task': '0001', 'x-agentx-coding-call': id }, 'synthetic-local-model');
}
async function finished() { const f = await fixture(); await start(f.intent).expect(200); await (await call()).finish('completed'); return f; }

test('report start is bound to owner, scope, model and source without resetting its deadline', async () => {
  const f = await fixture(); await start(f.intent).expect(200);
  const first = await Run.findById(KEY).lean();
  await start({ ...f.intent, hardRemainingSeconds: 14400 }).expect(200);
  expect((await Run.findById(KEY).lean()).deadlineAt).toEqual(first.deadlineAt);
  await start({ ...f.intent, sourceCommit: 'b'.repeat(40),inventory:{...f.intent.inventory,sourceCommit:'b'.repeat(40)} }).expect(409);
  expect(await Run.countDocuments({})).toBe(1);
});
test.each([128,256])('a report admits its last call and refuses the next at its frozen %i-call budget', async limit => {
  const f=await fixture({},limit);const accepted=(await start({...f.intent,modelCallLimit:limit}).expect(200)).body.data;
  expect(accepted).toMatchObject({modelCallLimit:limit,modelCallsRemaining:limit});
  const receipts=Array.from({length:limit-1},()=>({callId:crypto.randomUUID(),state:'completed'}));
  await Run.updateOne({_id:KEY},{$set:{modelReceipts:receipts}});
  await (await call()).finish('completed');
  const owner=await Task.findById(f.owner._id).lean();
  await expect(call(NEXT)).rejects.toMatchObject({code:'REPORT_MODEL_CALL_LIMIT'});
  expect(await Task.findById(f.owner._id).lean()).toEqual(owner);
  const saved=await Run.findById(KEY).lean();expect(saved.modelReceipts).toHaveLength(limit);
  expect((await reports.status('0001',KEY)).modelCallsRemaining).toBe(0);
});
test('the default and legacy report budget remain 128 and cannot be increased on replay', async () => {
  const f=await fixture();expect((await start(f.intent).expect(200)).body.data.modelCallLimit).toBe(128);
  await Run.collection.updateOne({_id:KEY},{$unset:{modelCallLimit:''}});
  const before=await Run.findById(KEY).lean();
  await start({...f.intent,modelCallLimit:256}).expect(409);
  expect(await Run.findById(KEY).lean()).toEqual(before);
  expect((await start(f.intent).expect(200)).body.data.modelCallLimit).toBe(128);
});
test('a report budget is immutable on replay and conflicting concurrent starts retain one budget', async () => {
  const f=await fixture();const replies=await Promise.all([start({...f.intent,modelCallLimit:128}),start({...f.intent,modelCallLimit:256})]);
  expect(replies.map(row=>row.status).sort()).toEqual([200,409]);
  const saved=await Run.findById(KEY).lean();
  await start({...f.intent,modelCallLimit:saved.modelCallLimit,hardRemainingSeconds:14400}).expect(200);
  await start({...f.intent,modelCallLimit:saved.modelCallLimit===128?256:128}).expect(409);
  expect(await Run.findById(KEY).lean()).toEqual(saved);
});
test.each([0,127,257,512,128.5,'256',null,true])('invalid report budget %p refuses before any permit or journal write', async limit => {
  const f=await fixture(),before=await Task.findById(f.owner._id).lean();
  await start({...f.intent,modelCallLimit:limit}).expect(400);
  expect(await Run.countDocuments({})).toBe(0);expect(await Task.findById(f.owner._id).lean()).toEqual(before);
});
test.each([{ service: 'personal' }, { source: 'household-task' }, { assignee: 'other-worker' },
  { automationAttemptCount: 1 }, { codingAutonomy: { state: 'active' } }])('report cannot replace private scope or another owner: %p', async extra => {
  const f = await fixture(extra); const old = await Task.findById(f.owner._id).lean();
  await start(f.intent).expect(409);
  expect(await Run.countDocuments({})).toBe(0); expect(await Task.findById(f.owner._id).lean()).toEqual(old);
});
test('pending/unknown native model calls fence new calls and report delivery', async () => {
  const f = await fixture(); await start(f.intent).expect(200); const receipt = await call();
  await expect(call(NEXT)).rejects.toMatchObject({ code: 'REPORT_INFERENCE_PENDING' });
  await result(bytes()).expect(409); await receipt.finish('unknown');
  expect((await reports.status('0001', KEY)).terminationVerified).toBe(false);
  await reports.reconcileModels('0001', KEY);
  expect((await Run.findById(KEY).lean()).pendingInferences).toEqual([CALL]);
  expect(await File.countDocuments({})).toBe(0);
});
test('a lost native settlement acknowledgement stays fenced until its owner verifies that exact stored settlement', async () => {
  const f = await fixture(); await start(f.intent).expect(200); const receipt = await call();
  const original = Run.updateOne.bind(Run);
  const spy = jest.spyOn(Run, 'updateOne').mockImplementation(async (query, update, options) => {
    const value = await original(query, update, options);
    if (update.$set?.['modelReceipts.$[call].state'] === 'unknown') throw new Error('Synthetic lost acknowledgement');
    return value;
  });
  await expect(receipt.finish('completed')).rejects.toThrow('acknowledgement'); spy.mockRestore();
  expect((await reports.status('0001', KEY)).terminationVerified).toBe(false);
  const restored = await reports.reconcileModels('0001', KEY);
  expect(restored.terminationVerified).toBe(true); expect(restored.modelReceipts[0].state).toBe('completed');
  await expect(call(CALL)).rejects.toMatchObject({ code: 'REPORT_INFERENCE_PENDING' });
});
test('a stored report is a review candidate, never automatic acceptance; bytes and retry identity are verified', async () => {
  await finished();
  const body = bytes(), first = (await result(body).expect(200)).body.data;
  expect(first.reportReadyForReview).toBe(true);
  expect(first.receipt).toMatchObject({ attempt: null, name: `review-${KEY}.md`, producer: { channel: 'report_worker', declared: 'coding-team' },
    availability: { status: 'available', hashVerified: true }, externalDelivery: { status: 'none' } });
  expect((await Task.findOne({ pipelineId: '0001' }).lean()).status).toBe('review');
  const retry = (await result(body).expect(200)).body.data;
  expect(retry.alreadyRecorded).toBe(true); expect(retry.receipt.id).toBe(first.receipt.id);
  await result(bytes('# Different bytes')).expect(409);
  expect(await File.countDocuments({})).toBe(1);
});
test('a new claim after the last owner read cannot receive an old report verdict', async () => {
  await finished(); const original = files.register.bind(files);
  jest.spyOn(files, 'register').mockImplementation(async (...args) => {
    const stored = await original(...args);
    await Task.updateOne({ pipelineId: '0001' }, { $set: { assignee: 'next-worker', status: 'in_progress', transitionSeq: 9, spec: 'New instructions' },
      $push: { transitions: buildTransition({ pipelineId: '0001', status: 'queued', transitionSeq: 8 },
        { to: 'in_progress', kind: 'claimed', channel: 'worker_api', declaredActor: 'next-worker' }) } });
    return stored;
  });
  const response = (await result(bytes()).expect(200)).body.data;
  expect(response.superseded).toBe(true);
  const task = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(task).toMatchObject({ assignee: 'next-worker', status: 'in_progress', transitionSeq: 9, spec: 'New instructions' });
  expect(task.feedback).toHaveLength(0);
});
test('a specification edit prevents publication even if the worker label and claim number stay the same', async () => {
  await finished(); await Task.updateOne({ pipelineId: '0001' }, { $set: { spec: 'Changed request' } });
  expect((await result(bytes()).expect(200)).body.data.superseded).toBe(true);
  expect(await File.countDocuments({})).toBe(0);
  expect((await Task.findOne({ pipelineId: '0001' }).lean()).status).toBe('in_progress');
});
test('a final report intent prevents subsequent model calls and an incompatible stop result', async () => {
  await finished(); await result(bytes()).expect(200);
  await Task.updateOne({ pipelineId: '0001' }, { $set: { status: 'in_progress' } });
  await expect(call(NEXT)).rejects.toMatchObject({ code: 'REPORT_INFERENCE_CONFLICT' });
  await Task.updateOne({ pipelineId: '0001' }, { $set: { status: 'review' } });
  const body = { workerOutcome: { schema: 'agentx.pipeline-worker-outcome/v1', requestId: KEY, pipelineId: '0001', claimSeq: 2,
    result: 'blocked', reason: 'operator_stop', source: 'worker_report', startedAt: new Date(Date.now()-1000).toISOString(),
    finishedAt: new Date().toISOString(), usage: { workSeconds: 1, modelCalls: 1 } } };
  await harness.request.post(`/api/pipeline/tasks/0001/reports/${KEY}/stop-result`).send(body).expect(409);
  expect((await Task.findOne({ pipelineId: '0001' }).lean()).status).toBe('review');
});
test('invalid or mismatching report bytes grant no finalization or storage', async () => {
  await finished(); await result({ ...bytes(), sha256: 'f'.repeat(64) }).expect(400);
  expect((await Run.findById(KEY).lean()).finalKind).toBeUndefined();expect(await File.countDocuments({})).toBe(0);
});

const stopped = () => ({ workerOutcome: { schema: 'agentx.pipeline-worker-outcome/v1', requestId: KEY, pipelineId: '0001', claimSeq: 2,
  result: 'blocked', reason: 'operator_stop', source: 'worker_report', startedAt: '2025-01-01T00:00:00.000Z',
  finishedAt: '2025-01-01T00:00:01.000Z', usage: { workSeconds: 1, modelCalls: 1 } } });
test('concurrent identical stops return the same stored result with one task transition', async () => {
  await finished(); const body = stopped();
  const responses = await Promise.all([reports.stop('0001', KEY, body), reports.stop('0001', KEY, body)]);
  const ledger = await Run.findById(KEY).lean(), task = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(responses.map(row => row.outcome)).toEqual([ledger.result, ledger.result]);
  expect(ledger).toMatchObject({ state: 'blocked', result: { kind: 'blocked' } });
  expect(task.feedback).toHaveLength(1);
});
test.each(['review', 'blocked'])('lost %s ledger write acknowledgement is repaired from exact native task feedback', async kind => {
  await finished(); const original = Run.updateOne.bind(Run); let lose = true;
  const spy = jest.spyOn(Run, 'updateOne').mockImplementation(async (query, update, options) => {
    if (update.$set?.result && lose) { lose = false; throw new Error('Synthetic lost ledger write'); }
    return original(query, update, options);
  });
  const invoke = () => kind === 'review' ? reports.submit('0001', KEY, bytes()) : reports.stop('0001', KEY, stopped());
  await expect(invoke()).rejects.toThrow('lost ledger'); spy.mockRestore();
  expect((await Run.findById(KEY).lean()).result).toBeUndefined();
  const response = await invoke(), stored = await Run.findById(KEY).lean();
  expect(stored.state).toBe(kind); expect(response.outcome).toEqual(stored.result);
  expect((await Task.findOne({ pipelineId: '0001' }).lean()).feedback).toHaveLength(1);
  expect(await File.countDocuments({})).toBe(kind === 'review' ? 1 : 0);
});
test.each(['review', 'blocked'])('deletion preserves %s execution custody and closes only the original ledger', async kind => {
  await finished(); await Task.deleteMany({});
  const response = kind === 'review' ? await reports.submit('0001', KEY, bytes()) : await reports.stop('0001', KEY, stopped());
  expect(response.superseded).toBe(true); expect(response.outcome).toEqual((await Run.findById(KEY).lean()).result);
  expect((await reports.status('0001', KEY)).terminationVerified).toBe(true);
  expect(await Task.countDocuments({})).toBe(0); expect(await File.countDocuments({})).toBe(0);
});
test('an unacknowledged terminal write never certifies a constructed result', async () => {
  await finished(); const original = Run.updateOne.bind(Run);
  const spy = jest.spyOn(Run, 'updateOne').mockImplementation(async (query, update, options) => {
    const saved = await original(query, update, options);
    return update.$set?.result ? { ...saved, acknowledged: false } : saved;
  });
  await expect(reports.stop('0001', KEY, stopped())).rejects.toMatchObject({ code: 'REPORT_PERSISTENCE_UNVERIFIED' });
  spy.mockRestore(); const response = await reports.stop('0001', KEY, stopped());
  expect(response.outcome).toEqual((await Run.findById(KEY).lean()).result);
  expect((await Task.findOne({ pipelineId: '0001' }).lean()).feedback).toHaveLength(1);
});
test('a concurrent change to review_only vetoes report inference at the task CAS', async () => {
  const f = await fixture(); await start(f.intent).expect(200); const original = Task.updateOne.bind(Task);
  jest.spyOn(Task, 'updateOne').mockImplementation(async (query, update, options) => {
    await original({ pipelineId: '0001' }, { $set: { 'automation.mode': 'review_only' } });
    return original(query, update, options);
  });
  await expect(call()).rejects.toMatchObject({ code: 'REPORT_CLAIM_CHANGED' });
  expect((await Run.findById(KEY).lean()).modelReceipts).toHaveLength(0);
});

function runtimeDeps(upstream) {
  return { beginInferenceAdmission: jest.fn(async ({ signal }) => ({ signal, admissionId: require('crypto').randomUUID(),
    generation: require('crypto').randomUUID(), principal: 'core-trusted-runtime', markDispatched() {}, assertActive() {},
    complete: jest.fn(async () => ({ released: true })), abandon: jest.fn(async () => ({ released: true })) })),
  getAdvisoryModelForTask: jest.fn(), getTargetForModel: () => 'http://ollama.invalid:11434', resolveHostKey: () => 'synthetic',
  validateHostUrl: host => ({ valid: true, host }), assertHostAvailableForConsumer: async () => null,
  hostPreferenceService: { getByHost: async () => ({ pinnedModels: [{ model: 'synthetic-local-model', contextSize: 32768, keepAlive: -1 }] }) },
  modelsMatch: (a, b) => a === b, resolveInferenceContract: async () => ({ version: 1, contextBudget: { windowTokens: 32768 } }),
  applyContractOutputLimit() {}, hostGate: { acquire: async () => () => {} }, recordInference: jest.fn(async () => null),
  fetch: jest.fn(async () => ({ ok: true, status: 200, headers: new Map(), body: upstream })) };
}
test.each([true, false])('the real Hermes report path preserves native stream settlement (clean=%s)', async clean => {
  const f = await fixture(); await start(f.intent).expect(200);
  const upstream = new PassThrough(); nativeDeps = runtimeDeps(upstream);
  const response = harness.request.post('/v1/chat/completions').set({ 'x-agentx-report-request': KEY,
    'x-agentx-report-task': '0001', 'x-agentx-coding-call': CALL }).send({ model: 'synthetic-local-model',
    stream: true, messages: [{ role: 'user', content: 'Synthetic CPU report fixture' }] });
  setImmediate(() => upstream.end(JSON.stringify({ model: 'synthetic-local-model', done: clean, message: { content: 'Synthetic reply' } })+'\n'));
  const http = await response.catch(error => {
    if (clean) throw error;
    expect(error.message).toMatch(/aborted|closed|reset/i); return { text: '' };
  });
  expect(nativeDeps.fetch).toHaveBeenCalledTimes(1);
  expect(await require('../../models/PipelineReportAdmission').countDocuments({ requestId: KEY, callId: CALL })).toBeGreaterThan(0);
  const stored = await Run.findById(KEY).lean();
  expect(stored.modelReceipts[0].state).toBe(clean ? 'completed' : 'unknown');
  expect((await reports.status('0001', KEY)).terminationVerified).toBe(clean);
  expect(http.text.includes('[DONE]')).toBe(clean);
  if (clean) { await result(bytes()).expect(200); }
  else {
    await result(bytes()).expect(409); await expect(call(NEXT)).rejects.toMatchObject({ code: 'REPORT_INFERENCE_PENDING' });
    expect(await File.countDocuments({})).toBe(0);
  }
});
test('a lost native binding acknowledgement prevents provider dispatch', async () => {
  const f = await fixture(); await start(f.intent).expect(200);
  nativeDeps = runtimeDeps(new PassThrough());
  const original = Run.updateOne.bind(Run); let lost = false;
  jest.spyOn(Run, 'updateOne').mockImplementation(async (...args) => {
    const saved = await original(...args);
    if (!lost && args[0].modelReceipts && args[1].$inc?.revision === 1 && Object.keys(args[1]).length === 1) {
      lost = true; throw new Error('Synthetic lost native binding acknowledgement');
    }
    return saved;
  });
  await harness.request.post('/v1/chat/completions').set({ 'x-agentx-report-request': KEY,
    'x-agentx-report-task': '0001', 'x-agentx-coding-call': CALL }).send({ model: 'synthetic-local-model',
    stream: true, messages: [{ role: 'user', content: 'Synthetic binding acknowledgement fixture' }] });
  expect(lost).toBe(true); expect(nativeDeps.fetch).not.toHaveBeenCalled();
  expect(await require('../../models/PipelineReportAdmission').countDocuments({ requestId: KEY, callId: CALL })).toBeGreaterThan(0);
});
test('revoking the campaign during native admission refuses before any model dispatch', async () => {
  const f = await fixture(); await start(f.intent).expect(200);
  nativeDeps = runtimeDeps(new PassThrough());
  const admission = nativeDeps.beginInferenceAdmission;
  nativeDeps.beginInferenceAdmission = jest.fn(async input => {
    const value = await admission(input);
    queue.get.mockResolvedValue({ id: NEXT, state: 'uncertain' });
    return value;
  });
  await harness.request.post('/v1/chat/completions').set({ 'x-agentx-report-request': KEY,
    'x-agentx-report-task': '0001', 'x-agentx-coding-call': CALL }).send({ model: 'synthetic-local-model',
    stream: true, messages: [{ role: 'user', content: 'Synthetic admission race fixture' }] });
  expect(nativeDeps.beginInferenceAdmission).toHaveBeenCalledTimes(1);
  expect(nativeDeps.fetch).not.toHaveBeenCalled();
  expect((await Run.findById(KEY).lean()).modelReceipts).toHaveLength(1);
});

test('report heartbeat cannot touch a replacement owner or a changed lane after its last read', async () => {
  const f = await fixture(); await start(f.intent).expect(200);
  await reports.heartbeat('0001',KEY);
  const original = Task.updateOne.bind(Task);
  jest.spyOn(Task,'updateOne').mockImplementation(async (query,update,options) => {
    await original({pipelineId:'0001'},{$set:{source:'household-task',assignee:'next-owner',transitionSeq:9}});
    return original(query,update,options);
  });
  const before = await Task.findOne({pipelineId:'0001'}).lean();
  await expect(reports.heartbeat('0001',KEY)).rejects.toMatchObject({code:'REPORT_CLAIM_CHANGED'});
  const after = await Task.findOne({pipelineId:'0001'}).lean();
  expect(after.heartbeatAt).toEqual(before.heartbeatAt);expect(after.assignee).toBe('next-owner');
});

test.each(['lost_ack', 'unacknowledged'])('prepare %s attests only its own refusal before returning dispatch authority', async fault => {
  const f=await fixture();await start(f.intent).expect(200);const original=Run.updateOne.bind(Run);
  jest.spyOn(Run,'updateOne').mockImplementation(async (query,update,options)=>{
    const saved=await original(query,update,options);
    if(update.$push?.modelReceipts){
      if(fault==='lost_ack')throw new Error('Synthetic prepare acknowledgement lost');
      return {...saved,acknowledged:false};
    }
    return saved;
  });
  await expect(call()).rejects.toThrow();
  const stored=await Run.findById(KEY).lean();
  expect(stored.modelReceipts[0].state).toBe('refused');expect(stored.pendingInferences).toEqual([]);
  expect((await reports.status('0001',KEY)).terminationVerified).toBe(true);
  await reports.stop('0001',KEY,stopped());expect((await Run.findById(KEY).lean()).state).toBe('blocked');
});
test('a losing prepare cannot settle a concurrently winning preparation with the same caller UUID', async () => {
  const f=await fixture();await start(f.intent).expect(200);
  const results=await Promise.allSettled([call(),call()]);
  expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);
  const stored=await Run.findById(KEY).lean();expect(stored.modelReceipts).toHaveLength(1);
  expect(stored.modelReceipts[0].state).toBe('pending');expect(stored.pendingInferences).toEqual([CALL]);
  await results.find(row=>row.status==='fulfilled').value.finish('completed');
  expect((await reports.status('0001',KEY)).terminationVerified).toBe(true);
});

test('preflight feedback cannot overwrite instructions changed after the last task read', async () => {
  const f=await fixture(), original=Task.findOneAndUpdate.bind(Task);
  jest.spyOn(Task,'findOneAndUpdate').mockImplementation(async (query,update,options)=>{
    await Task.updateOne({pipelineId:'0001'},{$set:{spec:'New owner instructions'}});
    return original(query,update,options);
  });
  await harness.request.post('/api/pipeline/tasks/0001/feedback').send({by:'coding-team',status:'blocked',text:'Synthetic preflight stop',
    manualReportClaim:{claimSeq:2,specSha256:f.intent.specSha256}}).expect(409);
  const stored=await Task.findOne({pipelineId:'0001'}).lean();
  expect(stored).toMatchObject({status:'in_progress',spec:'New owner instructions'});expect(stored.feedback).toHaveLength(0);
});

test('a stopped report archives exact private bytes once and remains blocked, including a lost terminal acknowledgement', async () => {
  await finished(); const body = { ...stopped(), partial: bytes('# Saved draft\n\nRemaining documents are pending.\n') };
  const update = Run.updateOne.bind(Run); let lost = false;
  const spy = jest.spyOn(Run, 'updateOne').mockImplementation(async (...args) => {
    const result = await update(...args);
    if (args[1].$set?.result && !lost) { lost = true; throw new Error('Lost acknowledgement after terminal persistence'); }
    return result;
  });
  await expect(reports.stop('0001', KEY, body)).rejects.toThrow('Lost acknowledgement'); spy.mockRestore();
  const response = await reports.stop('0001', KEY, body);
  expect(response.blocked).toBe(true); expect(response.outcome.partial.sha256).toBe(body.partial.sha256);
  const owner = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(owner.status).toBe('blocked'); expect(owner.feedback).toHaveLength(1);
  expect(await File.countDocuments({})).toBe(1);
  const file = await files.verify('0001', response.outcome.partial.deliverableId);
  expect(file).toMatchObject({ producer: { channel: 'report_worker' }, reportOrigin: { requestId: KEY, claimSeq: 2, state: 'partial' },
    availability: { hashVerified: true, status: 'available' } });
  await expect(reports.stop('0001', KEY, { ...body, partial: bytes('# Changed draft') })).rejects.toMatchObject({ code: 'REPORT_RESULT_CONFLICT' });
  expect((await Run.findById(KEY).lean()).result).toEqual(response.outcome);
});

test('a pending model call fences partial storage as well as the stop verdict', async () => {
  const f = await fixture(); await start(f.intent); const pending = await call();
  await expect(reports.stop('0001', KEY, { ...stopped(), partial: bytes() })).rejects.toMatchObject({ code: 'REPORT_MODEL_TERMINATION_UNVERIFIED' });
  expect(await File.countDocuments({})).toBe(0); expect((await Task.findById(f.owner._id).lean()).status).toBe('in_progress');
  await pending.finish('completed');
});

async function continuedFixture() {
  const f = await finished(); const body = { ...stopped(), partial: bytes('# Saved checkpoint\n\nREADME reviewed; operations pending.\n') };
  await reports.stop('0001', KEY, body);
  await Task.updateOne({ _id: f.owner._id }, { $set: { status: 'in_progress', transitionSeq: 4 }, $push: { transitions:
    buildTransition({ pipelineId: '0001', status: 'queued', transitionSeq: 3 }, { to: 'in_progress', kind: 'claimed', channel: 'worker_api', declaredActor: 'coding-team' }) } });
  const intent = { ...f.intent, claimSeq: 4, parentRequestId: KEY, parentSha256: body.partial.sha256 };
  const task=await Task.findById(f.owner._id).lean();
  authority.configureControl({status:async()=>({busy:false,run:{requestId:KEY,pipelineId:'0001',phase:'finished',progress:{phase:'finished'}}})});
  const profile={reportName:'review.md',modelCallLimit:128,parentRequestId:KEY,parentSha256:body.partial.sha256};
  const state=await authority.prepare(task,profile,{key:NEXT,queueRequestId:NEXT,confirm:true,additionalRuns:1,budget:{modelCalls:128,workSeconds:7200}});
  await Task.updateOne({_id:task._id},{$set:{codingResult:{profile:'report',...profile},codingReportAuthority:state}});
  return { f, body, intent };
}
test('an explicit new run resumes the exact previous checkpoint without resetting prior usage or granting another call budget', async () => {
  const f = await continuedFixture();
  await harness.request.post(`/api/pipeline/tasks/0001/reports/${NEXT}/start`).send(f.intent).expect(200);
  const response = (await harness.request.get(`/api/pipeline/tasks/0001/reports/${NEXT}/checkpoint`).expect(200)).body.data;
  expect(response).toMatchObject({ requestId: NEXT, parentRequestId: KEY, sourceCommit: f.intent.sourceCommit, sha256: f.body.partial.sha256, dataUrl: f.body.partial.dataUrl });
  const observed = await reports.status('0001', NEXT);
  expect(observed).toMatchObject({ modelCallsRemaining: 128, cumulativeUsage: {budgetScope:'whole_task',spent:{executions:2,modelCalls:1},limits:{modelCalls:384,executions:2}} });
  expect((await Run.findById(KEY).lean()).state).toBe('blocked');
  expect((await Run.findById(NEXT).lean()).modelReceipts).toHaveLength(0);
});
test.each(['digest', 'source', 'scope', 'task', 'pending', 'bytes'])('a continuation refuses a changed or uncertain prior %s before a new run is created', async change => {
  const { f, intent } = await continuedFixture();
  if (change === 'digest') intent.parentSha256 = 'b'.repeat(64);
  if (change === 'source') {intent.sourceCommit = 'b'.repeat(40);intent.inventory={...intent.inventory,sourceCommit:intent.sourceCommit};}
  if (change === 'scope') { await Task.updateOne({ _id: f.owner._id }, { $set: { spec: 'Different requested scope' } }); intent.specSha256 = digest('Different requested scope'); }
  if (change === 'task') await Run.updateOne({ _id: KEY }, { $set: { taskId: 'different-task-record' } });
  if (change === 'pending') await Run.updateOne({ _id: KEY }, { $set: { pendingInferences: [CALL] } });
  if (change === 'bytes') await File.collection.updateOne({}, { $set: { data: Buffer.from('Altered bytes') } });
  const before = await Task.findById(f.owner._id).lean();
  await harness.request.post(`/api/pipeline/tasks/0001/reports/${NEXT}/start`).send(intent).expect(409);
  expect(await Run.countDocuments({})).toBe(1); expect(await Task.findById(f.owner._id).lean()).toEqual(before);
});
test('the continuation limit refuses before creating an execution whose status could not be read', async () => {
  const { f, intent } = await continuedFixture(), base = await Run.findById(KEY).lean();
  await Run.updateOne({ _id: KEY }, { $set: { claimSeq: 64 } });
  let previous = null;
  for (let i = 1; i <= 31; i++) {
    const key = crypto.randomUUID();
    await Run.create({ ...base, _id: key, claimSeq: i * 2, parentRequestId: previous });
    previous = key;
  }
  await Run.collection.updateOne({ _id: KEY }, { $set: { claimSeq: 64, parentRequestId: previous } });
  await Task.updateOne({ _id: f.owner._id }, { $set: { transitionSeq: 66, transitions: [
    buildTransition({ pipelineId: '0001', status: 'queued', transitionSeq: 65 },
      { to: 'in_progress', kind: 'claimed', channel: 'worker_api', declaredActor: 'coding-team' })] } });
  const before = await Task.findById(f.owner._id).lean();
  const response = await harness.request.post(`/api/pipeline/tasks/0001/reports/${NEXT}/start`).send({ ...intent, claimSeq: 66 }).expect(409);
  expect(response.body.code).toBe('REPORT_LINEAGE_LIMIT');
  expect(await Run.countDocuments({})).toBe(32); expect(await Task.findById(f.owner._id).lean()).toEqual(before);
});
test('report acceptance binds the exact current candidate, verified bytes and an explicit independent coverage decision', async () => {
  await finished(); const run=await Run.findById(KEY).lean();
  const coverage={inventorySha256:run.inventory.sha256,documents:[{...run.inventory.documents[0],state:'reviewed',evidence:[{path:'core/server.js',sha256:digest('fixture source'),line:1,check:'Checked entry point against source.'}]}]};
  const delivered = (await result({...bytes(),coverage}).expect(200)).body.data;
  const status = body => harness.request.post('/api/pipeline/tasks/0001/status').send({ status: 'done', by: 'reviewer', ...body });
  await status({}).expect(409);
  const acceptance = { requestId: KEY, sha256: delivered.receipt.sha256, scopeComplete: true,evidenceRef:'private-review-receipt',evidenceSha256:digest('independent review') };
  await status({ reportAcceptance: { ...acceptance, scopeComplete: false } }).expect(409);
  await status({ reportAcceptance: { ...acceptance, requestId: NEXT } }).expect(409);
  await status({ by: 'coding-team', reportAcceptance: acceptance }).expect(409);
  await status({ reportAcceptance: acceptance }).expect(200);
  const task = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(task.status).toBe('done'); expect(task.feedback.at(-1).reportAcceptance).toEqual(acceptance);
});
test('late manual code feedback cannot overwrite a newer claim or edited specification', async () => {
  const f = await fixture();
  const body = { by: 'coding-team', status: 'done', text: 'Old worker result', manualWorkerClaim: { claimSeq: 2, specSha256: f.intent.specSha256 } };
  await Task.updateOne({ _id: f.owner._id }, { $set: { spec: 'Changed task instructions' } });
  await harness.request.post('/api/pipeline/tasks/0001/feedback').send(body).expect(409);
  expect((await Task.findById(f.owner._id).lean()).feedback).toHaveLength(0);
});
test('a specification edit during report acceptance cannot close the changed task', async () => {
  await finished(); const value=await Run.findById(KEY).lean();
  const checked={inventorySha256:value.inventory.sha256,documents:[{...value.inventory.documents[0],state:'reviewed',evidence:[{path:'core/server.js',sha256:digest('source'),line:1,check:'Checked implementation.'}]}]};
  const delivered = (await result({...bytes(),coverage:checked}).expect(200)).body.data;
  const original = Task.findOneAndUpdate.bind(Task);
  jest.spyOn(Task, 'findOneAndUpdate').mockImplementation(async (...args) => {
    await Task.updateOne({ pipelineId: '0001' }, { $set: { spec: 'New requested scope' } });
    return original(...args);
  });
  await harness.request.post('/api/pipeline/tasks/0001/status').send({ status: 'done', by: 'reviewer',
    reportAcceptance: { requestId: KEY, sha256: delivered.receipt.sha256, scopeComplete: true,evidenceRef:'review-receipt',evidenceSha256:digest('review') } }).expect(409);
  const task = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(task).toMatchObject({ status: 'review', spec: 'New requested scope' });
  expect(task.feedback.some(row => row.reportAcceptance)).toBe(false);
});
test('a specification edit racing manual code feedback refuses the old result', async () => {
  const { intent } = await fixture(), original = Task.findOneAndUpdate.bind(Task);
  jest.spyOn(Task, 'findOneAndUpdate').mockImplementation(async (...args) => {
    await Task.updateOne({ pipelineId: '0001' }, { $set: { spec: 'New requested scope' } });
    return original(...args);
  });
  await harness.request.post('/api/pipeline/tasks/0001/feedback').send({ by: 'coding-team', status: 'done', text: 'Old result',
    manualWorkerClaim: { claimSeq: 2, specSha256: intent.specSha256 } }).expect(409);
  const task = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(task.status).toBe('in_progress'); expect(task.feedback).toHaveLength(0);
});

test('concurrent report starts cannot assign two request identities to one task claim', async () => {
  const { intent } = await fixture();
  const replies = await Promise.all([start(intent), harness.request.post(`/api/pipeline/tasks/0001/reports/${NEXT}/start`).send(intent)]);
  expect(replies.map(row => row.status).sort()).toEqual([200, 409]);
  expect(await Run.countDocuments({})).toBe(1);
  const original = await Run.findOne({}).lean();
  expect(original.executionVersion).toBe(1);
  expect((await reports.status('0001', original._id)).modelCallsRemaining).toBe(128);
});

test('a valid maximum-length report name still permits immutable partial storage', async () => {
  const { intent,owner } = await fixture(); intent.reportName = 'a'.repeat(117) + '.md';
  await Task.updateOne({_id:owner._id},{$set:{'codingResult.reportName':intent.reportName,'codingReportAuthority.reportName':intent.reportName}});
  await start(intent).expect(200); await (await call()).finish('completed');
  const response = await reports.stop('0001', KEY, { ...stopped(), partial: bytes() });
  const receipt = await files.verify('0001', response.outcome.partial.deliverableId);
  expect(receipt.name.length).toBeLessThanOrEqual(160); expect(receipt.availability.status).toBe('available');
});
