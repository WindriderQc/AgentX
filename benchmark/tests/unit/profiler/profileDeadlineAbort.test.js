'use strict';
// A probe request whose deadline expires is aborted and becomes a terminal,
// measured timeout only when /api/ps proves Ollama stopped it (fake Ollama, #187).
const http = require('node:http');
jest.mock('../../../src/helpers/ollamaHostConfig', () => ({ getConfiguredHosts: () => [], getHostResidency: () => 'cpu' }));
jest.mock('../../../src/helpers/ollamaTargetAdmission', () => ({ admitOllamaTargetResolved: async url => url }));
jest.mock('../../../src/services/ollamaVramService', () => ({ getHostVram: async () => ({ ok: false }) }));
jest.mock('../../../src/clients/coreApiClient', () => ({
  getWorkloadRecoveryIdentity: () => ({ recoveryId: 'recovery-1', recoveryRequestId: 'request-1' })
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const HostProfile = require('../../../models/HostProfile');
const { createRunJournal } = require('../../../src/services/profiler/profilerRunJournal');
const { createProfileCancellation } = require('../../../src/services/profiler/profileCancellation');
const { runStep } = require('../../../src/services/contextProbeStep');
const { assessProbeStep } = require('../../../src/services/contextProbeService')._internal;
const { observeJsonMutation } = require('../../../src/services/profiler/profilerMutationObservation');
const { listenLoopback } = require('../../../../shared/testing/listenLoopback');

const MODEL = 'fixture:1';
const CTX = 32768;
const DEADLINE_MS = 300;
let mongo;
let server;
let hostUrl;
let ollama;

function fakeOllama() {
  // A CPU runner already resident at the probe context; `onAbort` decides what
  // /api/ps shows once the client closed the request.
  const state = { expiresAt: '2026-10-02T10:00:00.000000001Z', resident: true, generates: [], closed: 0, onAbort: 'release' };
  server = http.createServer((req, res) => {
    if (req.url === '/api/ps') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ models: state.resident ? [{ name: MODEL, model: MODEL, digest: 'sha256:fixture',
        size: 18_000_000_000, size_vram: 0, context_length: CTX, expires_at: state.expiresAt }] : [] }));
    }
    if (req.url === '/api/generate') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const numCtx = JSON.parse(body).options?.num_ctx;
        state.generates.push(numCtx);
        if (numCtx < CTX) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ done: true, eval_count: 64, eval_duration: 8e9, prompt_eval_count: 13_000 }));
          return;
        }
        // A slow CPU prefill that outlasts the deadline. Closing the connection cancels it.
        res.on('close', () => {
          state.closed += 1;
          if (state.onAbort === 'release') state.expiresAt = '2026-10-02T10:25:42.123456789Z';
          if (state.onAbort === 'unload') state.resident = false;
        });
      });
      return undefined;
    }
    res.statusCode = 404;
    return res.end();
  });
  return state;
}

function lease() {
  return { operationId: 'profile-fixture', signal: new AbortController().signal,
    assertActive: jest.fn(), assertDispatchActive: jest.fn(async () => true), attachReconciliation: jest.fn(),
    abandon: jest.fn(async () => ({ abandoned: true })),
    authorityProof: () => ({ admissionId: 'admission-1', generation: 'generation-1', principal: 'benchmark-service' }) };
}
const read = async () => (await HostProfile.findOne({ hostId: 'fixture' }).lean()).reconciliation;
const fastProof = { budgetMs: 1_500, settleMs: 60, sampleGapMs: 25 };

beforeAll(async () => {
  const uri = process.env.TEST_USE_EXTERNAL_MONGO === 'true' ? process.env.MONGODB_URI_TEST : (mongo = await MongoMemoryServer.create()).getUri();
  await mongoose.connect(uri);
  await HostProfile.init();
}, 30000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
  ollama = fakeOllama();
  const address = await listenLoopback(server);
  hostUrl = `http://127.0.0.1:${address.port}`;
  await HostProfile.deleteMany({});
  await HostProfile.create({ hostId: 'fixture', hostUrl });
});
afterEach(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });

// A verified 16K sample, then a 32K sample that outlasts its deadline, then
// whatever the profile sends next.
async function runProfile(owner, cancellation, after = async () => null) {
  const journal = await createRunJournal(owner, { hostId: 'fixture', hostUrl, modelName: MODEL });
  return journal.run(async () => {
    const verified = await runStep(hostUrl, MODEL, 16384, 60_000, 80);
    const timedOut = await runStep(hostUrl, MODEL, CTX, DEADLINE_MS, 80);
    return { verified, timedOut, next: await after() };
  }, MODEL, cancellation ? { cancellation } : {}).then(result => ({ result }), error => ({ error }));
}

test('a timed-out request proven stopped is a terminal timeout: earlier samples kept, no UNKNOWN', async () => {
  const owner = lease();
  const cancellation = createProfileCancellation({ hostUrl, ...fastProof });
  const next = () => observeJsonMutation(async () => ({ done: true }), { model: MODEL, numCtx: 16384 });
  const started = Date.now();
  const { result, error } = await runProfile(owner, cancellation, next);

  expect(error).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(DEADLINE_MS + fastProof.budgetMs + 1_000);
  expect(ollama.closed).toBe(1);
  expect(assessProbeStep(result.verified, result.verified.tokensPerSec)).toMatchObject({ passed: true });
  expect(assessProbeStep(result.timedOut, result.verified.tokensPerSec)).toMatchObject({
    numCtx: CTX, passed: false, requestSucceeded: false, failureCode: 'ETIMEDOUT', failureKind: 'transport',
    requestStopProven: true, gpuPercent: 0, ollamaContextLength: CTX, degradationPct: null
  });
  expect(result.timedOut.reason).toMatch(/timed out after 300ms; Ollama confirmed the request stopped \(expiry_refreshed\)/);
  // The journal accepted the next request and takes the normal exact restore/release path.
  expect(result.next).toEqual({ done: true });
  expect(owner.abandon).not.toHaveBeenCalled();
  expect(await read()).toMatchObject({ state: 'pending_reconciliation', pendingRequests: 0, serverTerminalObserved: true,
    deadlineAbort: { proven: true, receipt: { trigger: 'deadline', outcome: 'expiry_refreshed', numCtx: CTX,
      timeoutMs: DEADLINE_MS, baseline: { expiresAt: '2026-10-02T10:00:00.000000001Z', sizeVram: 0 } } } });
  expect(cancellation.status()).toMatchObject({ phase: null, abortedAt: null });
});

test('a timed-out request whose runner was unloaded keeps the in-flight placement as evidence', async () => {
  ollama.onAbort = 'unload';
  const owner = lease();
  const { result } = await runProfile(owner, createProfileCancellation({ hostUrl, ...fastProof }));
  expect(assessProbeStep(result.timedOut, 8)).toMatchObject({ failureKind: 'transport', requestStopProven: true,
    gpuSizeTotal: 18_000_000_000, gpuSizeVram: 0, ollamaContextLength: CTX });
  expect((await read()).state).toBe('pending_reconciliation');
});

test('without stop proof within the budget the timed-out request stays UNKNOWN and the host quarantined', async () => {
  ollama.onAbort = 'ignore';
  const owner = lease();
  const next = () => observeJsonMutation(async () => ({ done: true }), { model: MODEL, numCtx: 16384 });
  const { error } = await runProfile(owner, createProfileCancellation({ hostUrl, ...fastProof }), next);

  expect(error).toMatchObject({ code: 'PROFILER_MUTATION_OUTCOME_UNKNOWN', retainAdmission: true, deadlineStopUnproven: true });
  expect(error.message).toMatch(/deadline expired and Ollama did not confirm the aborted request stopped \(Ollama did not show the aborted request ending/);
  expect(owner.abandon).toHaveBeenCalled();
  expect(await read()).toMatchObject({ state: 'unknown', serverTerminalObserved: false, pendingRequests: 1,
    reason: 'PROFILE_DEADLINE_STOP_UNPROVEN', deadlineAbort: { proven: false } });
});

test('a run without an operator cancel still owns its deadlines; a model not resident is never assumed stopped', async () => {
  ollama.resident = false;
  const owner = lease();
  const { error } = await runProfile(owner, null);
  expect(error).toMatchObject({ code: 'PROFILER_MUTATION_OUTCOME_UNKNOWN', deadlineStopUnproven: true });
  expect(error.message).toMatch(/not resident at the request context when the request deadline expired/);
  expect(owner.abandon).toHaveBeenCalled();
  expect(await read()).toMatchObject({ state: 'unknown', reason: 'PROFILE_DEADLINE_STOP_UNPROVEN' });
});

test('a request answered before its deadline is untouched', async () => {
  const owner = lease();
  const cancellation = createProfileCancellation({ hostUrl, ...fastProof });
  const journal = await createRunJournal(owner, { hostId: 'fixture', hostUrl, modelName: MODEL });
  const step = await journal.run(() => runStep(hostUrl, MODEL, 16384, 5_000, 80), MODEL, { cancellation });
  expect(step).toMatchObject({ requestSucceeded: true, requestStopProven: false });
  expect(await read()).toMatchObject({ state: 'pending_reconciliation', pendingRequests: 0 });
  expect((await read()).deadlineAbort).toBeUndefined();
});
