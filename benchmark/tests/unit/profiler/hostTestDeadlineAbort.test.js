'use strict';
// A streamed host-test probe (the throughput curve) gets the same run-owned
// deadline and /api/ps stop proof as a direct Ollama JSON request: a long fill
// that outlasts its deadline is a measured timeout, not an UNKNOWN that
// quarantines the host. The first UNKNOWN stops the run.
jest.mock('../../../src/clients/coreApiClient', () => ({
  getWorkloadRecoveryIdentity: () => ({ recoveryId: 'recovery-1', recoveryRequestId: 'request-1' })
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const HostProfile = require('../../../models/HostProfile');
const { createRunJournal } = require('../../../src/services/profiler/profilerRunJournal');
const { createProfileCancellation } = require('../../../src/services/profiler/profileCancellation');
const { observeJsonMutation } = require('../../../src/services/profiler/profilerMutationObservation');
const { createHostTestRequest, readOllamaGenerateStream } = require('../../../src/services/hostTestRuntimeTransport');

const MODEL = 'fixture:1';
const CTX = 262144;
const HOST_URL = 'http://fixture:11434';
const DEADLINE_MS = 200;
const fastProof = { budgetMs: 1_500, settleMs: 60, sampleGapMs: 25 };
let mongo;
let ollama;

function fakeOllama() {
  const state = { expiresAt: '2026-10-21T03:00:00.000000001Z', onAbort: 'release', aborted: 0, mode: 'prefill' };
  state.readPs = async () => [{ name: MODEL, model: MODEL, digest: 'sha256:fixture', size: 20e9, size_vram: 20e9,
    context_length: CTX, expires_at: state.expiresAt }];
  const callerAborted = () => Object.assign(new Error('The outbound request was cancelled.'), { code: 'OUTBOUND_CALLER_ABORTED' });
  const onAbort = (signal, reject) => signal.addEventListener('abort', () => {
    state.aborted += 1;
    if (state.onAbort === 'release') state.expiresAt = '2026-10-21T03:05:00.000000001Z';
    reject(callerAborted());
  }, { once: true });
  // 'prefill': no header before the abort; 'stream': headers, then a stalled body;
  // 'cut': the body ends without a terminal frame.
  state.executor = {
    admitTarget: async (_operation, href) => ({ href }),
    request: (_receipt, options) => new Promise((resolve, reject) => {
      if (state.mode === 'prefill') return onAbort(options.signal, reject);
      return resolve({ ok: true, status: 200, async *stream() {
        yield Buffer.from('{"done":false,"response":"x"}\n');
        if (state.mode === 'cut') return;
        await new Promise((_resolve, rejectStream) => onAbort(options.signal, rejectStream));
      } });
    })
  };
  return state;
}

const hostTestRequest = () => createHostTestRequest({ assertRegisteredOperation: () => {}, hostTestExecutor: ollama.executor });
async function probe() {
  const response = await hostTestRequest()('probe', `${HOST_URL}/api/generate`, {
    method: 'POST', body: '{}', runtimeRequest: { model: MODEL, numCtx: CTX, timeoutMs: DEADLINE_MS }
  });
  return readOllamaGenerateStream(response, Date.now());
}
const next = () => observeJsonMutation(async () => ({ done: true }), { model: MODEL, numCtx: CTX });

function lease() {
  return { operationId: 'profile-fixture', signal: new AbortController().signal,
    assertActive: jest.fn(), assertDispatchActive: jest.fn(async () => true), attachReconciliation: jest.fn(),
    abandon: jest.fn(async () => ({ abandoned: true })),
    authorityProof: () => ({ admissionId: 'admission-1', generation: 'generation-1', principal: 'benchmark-service' }) };
}
const read = async () => (await HostProfile.findOne({ hostId: 'fixture' }).lean()).reconciliation;

async function run(owner, operation) {
  const journal = await createRunJournal(owner, { hostId: 'fixture', hostUrl: HOST_URL, modelName: MODEL });
  const cancellation = createProfileCancellation({ hostUrl: HOST_URL, readPs: ollama.readPs, ...fastProof });
  return journal.run(operation, MODEL, { cancellation }).then(result => ({ result }), error => ({ error }));
}

beforeAll(async () => {
  const uri = process.env.TEST_USE_EXTERNAL_MONGO === 'true' ? process.env.MONGODB_URI_TEST : (mongo = await MongoMemoryServer.create()).getUri();
  await mongoose.connect(uri);
  await HostProfile.init();
}, 30000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
  ollama = fakeOllama();
  await HostProfile.deleteMany({});
  await HostProfile.create({ hostId: 'fixture', hostUrl: HOST_URL });
});

test.each(['prefill', 'stream'])('a %s that outlasts its deadline and is proven stopped is a measured timeout', async mode => {
  ollama.mode = mode;
  const owner = lease();
  const { result, error } = await run(owner, async () => {
    const timedOut = await probe().catch(failure => failure);
    return { timedOut, next: await next() };
  });

  expect(error).toBeUndefined();
  expect(ollama.aborted).toBe(1);
  expect(result.timedOut).toMatchObject({ code: 'ETIMEDOUT', deadlineAbort: true,
    stopProof: { trigger: 'deadline', outcome: 'expiry_refreshed', numCtx: CTX, timeoutMs: DEADLINE_MS } });
  expect(result.timedOut.retainAdmission).toBeUndefined();
  expect(result.next).toEqual({ done: true });
  expect(owner.abandon).not.toHaveBeenCalled();
  expect(await read()).toMatchObject({ state: 'pending_reconciliation', pendingRequests: 0,
    deadlineAbort: { proven: true } });
});

test('without stop proof the probe stays UNKNOWN and the run signal stops the profile', async () => {
  ollama.mode = 'stream';
  ollama.onAbort = 'ignore';
  const owner = lease();
  let runSignal;
  const { error } = await run(owner, async signal => {
    runSignal = signal;
    const failure = await probe().catch(caught => caught);
    expect(failure).toMatchObject({ deadlineAbort: true, deadlineStopUnproven: true, retainAdmission: true });
    throw signal.reason;
  });

  expect(runSignal.aborted).toBe(true);
  expect(error).toMatchObject({ code: 'PROFILER_MUTATION_OUTCOME_UNKNOWN', retainAdmission: true, deadlineStopUnproven: true });
  expect(owner.abandon).toHaveBeenCalled();
  expect(await read()).toMatchObject({ state: 'unknown', reason: 'PROFILE_DEADLINE_STOP_UNPROVEN' });
});

test('a stream cut without a terminal frame is UNKNOWN at once, not a silent pending request', async () => {
  ollama.mode = 'cut';
  const owner = lease();
  let runSignal;
  const { error } = await run(owner, async signal => {
    runSignal = signal;
    await expect(probe()).rejects.toMatchObject({ code: 'OLLAMA_STREAM_INCOMPLETE' });
    expect(signal.aborted).toBe(true);
    throw signal.reason;
  });

  expect(runSignal.reason).toMatchObject({ code: 'PROFILER_MUTATION_OUTCOME_UNKNOWN', retainAdmission: true,
    cause: { code: 'OLLAMA_STREAM_INCOMPLETE' } });
  expect(error).toMatchObject({ code: 'PROFILER_MUTATION_OUTCOME_UNKNOWN' });
  expect(owner.abandon).toHaveBeenCalled();
  expect(await read()).toMatchObject({ state: 'unknown', serverTerminalObserved: false });
});

test('a 4xx probe rejection settles its ticket so the run continues', async () => {
  const { failResponse } = require('../../../src/services/hostTestRuntimeTransport');
  ollama.executor.request = async () => ({ ok: false, status: 400 });
  const owner = lease();
  const { result, error } = await run(owner, async () => {
    const response = await hostTestRequest()('probe', `${HOST_URL}/api/generate`, {
      method: 'POST', body: '{}', runtimeRequest: { model: MODEL, numCtx: CTX, timeoutMs: 60_000 }
    });
    await failResponse(response, Object.assign(new Error('HTTP 400'), { status: 400 }));
    return next();
  });
  expect(error).toBeUndefined();
  expect(result).toEqual({ done: true });
  expect(await read()).toMatchObject({ state: 'pending_reconciliation', pendingRequests: 0 });
});

test('the full pipeline hands the profile a signal that stops at the first UNKNOWN', async () => {
  const { createProfilerPipelineDriver } = require('../../../src/services/profiler/profilerPipelineDriver');
  const claim = new AbortController();
  let seen;
  const profile = jest.fn(async (_model, _hostId, _hostUrl, _depth, options) => {
    await observeJsonMutation(async () => { throw new Error('socket hang up'); }, { model: MODEL, numCtx: CTX }).catch(() => {});
    seen = { aborted: options.signal.aborted, reason: options.signal.reason };
    throw options.signal.reason;
  });
  const driver = createProfilerPipelineDriver({ profile, hostTestService: {} });
  const owner = lease();
  await expect(driver.fullPipeline(MODEL, [{ hostId: 'fixture', hostUrl: HOST_URL }], { journalLease: owner, signal: claim.signal }))
    .rejects.toMatchObject({ code: 'PROFILER_MUTATION_OUTCOME_UNKNOWN', retainAdmission: true });
  expect(seen).toMatchObject({ aborted: true, reason: { code: 'PROFILER_MUTATION_OUTCOME_UNKNOWN' } });
  expect(claim.signal.aborted).toBe(false);
  expect(await read()).toMatchObject({ state: 'unknown' });
});
