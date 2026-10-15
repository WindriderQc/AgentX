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
const { buildTransition } = require('../../src/services/pipelineTaskTransitions');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const KEY = '11111111-2222-4333-8444-555555555555';
const CALL = '22222222-2222-4333-8444-555555555555';
const NEXT = '33333333-2222-4333-8444-555555555555';
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
let harness, nativeDeps;
const { PassThrough } = require('stream');
const { executeRoutedInference } = require('../../src/extensions/trustedRuntimeServices');
const { registerHermesProtocol } = require('../../integrations/runtime-bridges/hermes/protocol');
beforeAll(async () => {
  await File.createCollection(); await File.createIndexes();
  const app = express().use(express.json({ limit: '5mb' })).use('/api/pipeline', require('../../routes/pipeline-deliverables'))
    .use('/api/pipeline', require('../../routes/pipeline-feedback'));
  app.use(registerHermesProtocol({ express, logger: {}, runtimeServices: {
    routing: { getEffectiveSnapshot: async () => ({ tasks: { code_generation: { model: 'synthetic-local-model' } } }) },
    inference: { execute: (input, options) => executeRoutedInference(nativeDeps, input, options) },
  } }));
  harness = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await harness?.close(); });
beforeEach(async () => {
  await Promise.all([Task.deleteMany({}), Run.deleteMany({}), File.deleteMany({})]);
  jest.spyOn(config, 'ensureTaskModelOverridesLoaded').mockResolvedValue();
  jest.spyOn(config, 'getModelForTask').mockReturnValue({ model: 'synthetic-local-model', url: 'http://ollama.invalid:11434' });
});
afterEach(() => jest.restoreAllMocks());

async function fixture(extra = {}) {
  const owner = await Task.create({ pipelineId: '0001', title: 'Report fixture', spec: 'Review every Markdown document.',
    service: 'agentx-coding', status: 'in_progress', assignee: 'coding-team', transitionSeq: 2,
    transitions: [buildTransition({ pipelineId: '0001', status: 'queued', transitionSeq: 1 },
      { to: 'in_progress', kind: 'claimed', channel: 'worker_api', declaredActor: 'coding-team' })], ...extra });
  const intent = { claimSeq: 2, specSha256: digest(owner.spec), sourceCommit: 'a'.repeat(40), reportName: 'review.md',
    model: 'synthetic-local-model', hardRemainingSeconds: 7200 };
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
  await start({ ...f.intent, sourceCommit: 'b'.repeat(40) }).expect(409);
  expect(await Run.countDocuments({})).toBe(1);
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
  expect(first.receipt).toMatchObject({ attempt: null, name: `review-${KEY}.md`, producer: { channel: 'operator_api', declared: 'coding-team' },
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
  return { beginInferenceAdmission: jest.fn(async ({ signal }) => ({ signal, markDispatched() {}, assertActive() {},
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
