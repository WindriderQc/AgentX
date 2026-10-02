'use strict';
// A profile cancel aborts the in-flight Ollama request and records a terminal
// receipt only when /api/ps proves the runtime released it (fake Ollama).
const http = require('node:http');
jest.mock('../../../src/helpers/ollamaHostConfig', () => ({ getConfiguredHosts: () => [] }));
jest.mock('../../../src/helpers/ollamaTargetAdmission', () => ({ admitOllamaTargetResolved: async url => url }));
jest.mock('../../../src/clients/coreApiClient', () => ({
  getWorkloadRecoveryIdentity: () => ({ recoveryId: 'recovery-1', recoveryRequestId: 'request-1' })
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const HostProfile = require('../../../models/HostProfile');
const { createRunJournal } = require('../../../src/services/profiler/profilerRunJournal');
const { createProfileCancellation } = require('../../../src/services/profiler/profileCancellation');
const { sendProbeRequest } = require('../../../src/services/contextProbeRequest');
const { observeJsonMutation } = require('../../../src/services/profiler/profilerMutationObservation');
const { listenLoopback } = require('../../../../shared/testing/listenLoopback');

const MODEL = 'fixture:1';
const CTX = 32768;
let mongo;
let server;
let hostUrl;
let ollama;

function fakeOllama() {
  // `onAbort` decides what /api/ps shows once the client closed the request.
  const state = { expiresAt: '2026-10-02T10:00:00.000000001Z', resident: true, requests: 0, closed: 0, onAbort: 'release' };
  state.received = new Promise(resolve => { state.markReceived = resolve; });
  server = http.createServer((req, res) => {
    if (req.url === '/api/ps') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ models: state.resident ? [{ name: MODEL, model: MODEL, digest: 'sha256:fixture',
        size_vram: 0, context_length: CTX, expires_at: state.expiresAt }] : [] }));
    }
    if (req.url === '/api/generate') {
      state.requests += 1;
      req.resume();
      state.markReceived();
      // Never answers: a long CPU prefill. Closing the connection cancels it.
      res.on('close', () => {
        state.closed += 1;
        if (state.onAbort === 'release') state.expiresAt = '2026-10-02T10:05:42.123456789Z';
        if (state.onAbort === 'unload') state.resident = false;
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

async function runCancelledProbe(owner, cancellation) {
  const journal = await createRunJournal(owner, { hostId: 'fixture', hostUrl, modelName: MODEL });
  const run = journal.run(() => sendProbeRequest(hostUrl, MODEL, 'long prompt', CTX, 60_000, cancellation.signal, 1),
    MODEL, { cancellation });
  await ollama.received;
  expect((await read())).toMatchObject({ state: 'mutating', pendingRequests: 1, serverTerminalObserved: false });
  const cancel = await cancellation.cancel();
  return { cancel, outcome: await run.then(() => null, error => error) };
}

test('an aborted request with a refreshed runner expiry ends terminal, without UNKNOWN or quarantine', async () => {
  const owner = lease();
  const cancellation = createProfileCancellation({ hostUrl, parentSignal: owner.signal, ...fastProof });
  const started = Date.now();
  const { cancel, outcome } = await runCancelledProbe(owner, cancellation);

  expect(cancel).toMatchObject({ phase: 'awaiting_stop_proof', budgetMs: fastProof.budgetMs });
  expect(outcome).toMatchObject({ code: 'PROFILE_CANCELLED' });
  expect(outcome.retainAdmission).toBeUndefined();
  expect(outcome.cancelAbortReceipt).toMatchObject({ outcome: 'expiry_refreshed', model: MODEL, numCtx: CTX });
  expect(ollama.closed).toBe(1);
  expect(owner.abandon).not.toHaveBeenCalled();
  expect(Date.now() - started).toBeLessThan(fastProof.budgetMs + 1_000);
  expect(cancellation.status().phase).toBe('stopped');
  // The journal now takes the normal exact restore and workload release path.
  expect(await read()).toMatchObject({ state: 'pending_reconciliation', pendingRequests: 0, serverTerminalObserved: true,
    cancelAbort: { proven: true, receipt: { contract: 'agentx.profile-cancel-abort/v1', outcome: 'expiry_refreshed',
      baseline: { expiresAt: '2026-10-02T10:00:00.000000001Z' }, after: { expiresAt: '2026-10-02T10:05:42.123456789Z' } } } });
});

test('an aborted request whose runner was unloaded is also proven stopped', async () => {
  ollama.onAbort = 'unload';
  const owner = lease();
  const cancellation = createProfileCancellation({ hostUrl, parentSignal: owner.signal, ...fastProof });
  const { outcome } = await runCancelledProbe(owner, cancellation);
  expect(outcome.cancelAbortReceipt).toMatchObject({ outcome: 'runner_unloaded' });
  expect(owner.abandon).not.toHaveBeenCalled();
  expect((await read()).state).toBe('pending_reconciliation');
});

test('without stop proof within the budget the request stays UNKNOWN and the host quarantined', async () => {
  ollama.onAbort = 'ignore';
  const owner = lease();
  const cancellation = createProfileCancellation({ hostUrl, parentSignal: owner.signal, ...fastProof });
  const started = Date.now();
  const { outcome } = await runCancelledProbe(owner, cancellation);

  expect(outcome).toMatchObject({ code: 'PROFILE_CANCELLED', retainAdmission: true, cancelStopUnproven: true });
  expect(outcome.message).toMatch(/did not show the aborted request ending/);
  expect(Date.now() - started).toBeGreaterThanOrEqual(fastProof.budgetMs - 100);
  expect(owner.abandon).toHaveBeenCalled();
  expect(cancellation.status().phase).toBe('stop_unproven');
  expect(await read()).toMatchObject({ state: 'unknown', serverTerminalObserved: false, pendingRequests: 1,
    reason: 'PROFILE_CANCEL_STOP_UNPROVEN', cancelAbort: { proven: false } });
});

test('a model not yet resident at the request context is never assumed stopped', async () => {
  ollama.resident = false;
  const owner = lease();
  const cancellation = createProfileCancellation({ hostUrl, parentSignal: owner.signal, ...fastProof });
  const { outcome } = await runCancelledProbe(owner, cancellation);
  expect(outcome).toMatchObject({ retainAdmission: true, cancelStopUnproven: true });
  expect(outcome.message).toMatch(/not resident at the request context/);
  expect((await read()).state).toBe('unknown');
});

test('a cancel between requests aborts nothing and refuses the next dispatch', async () => {
  const owner = lease();
  const cancellation = createProfileCancellation({ hostUrl, parentSignal: owner.signal, ...fastProof });
  const journal = await createRunJournal(owner, { hostId: 'fixture', hostUrl, modelName: MODEL });
  const later = jest.fn(async () => ({ done: true }));
  const outcome = await journal.run(async () => {
    await observeJsonMutation(async () => ({ done: true }), { model: MODEL, numCtx: CTX });
    expect(await cancellation.cancel()).toMatchObject({ phase: 'checkpoint', abortedAt: null });
    return observeJsonMutation(later, { model: MODEL, numCtx: CTX });
  }, MODEL, { cancellation }).then(() => null, error => error);
  expect(outcome).toMatchObject({ code: 'PROFILE_CANCELLED' });
  expect(later).not.toHaveBeenCalled();
  expect(cancellation.signal.aborted).toBe(false);
  expect(owner.abandon).not.toHaveBeenCalled();
  expect(await read()).toMatchObject({ state: 'pending_reconciliation', pendingRequests: 0, serverTerminalObserved: true });
});
