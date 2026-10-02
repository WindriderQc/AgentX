'use strict';

// A real profiler writer process dies at a chosen journal boundary; this test
// process then acts as the restarted Benchmark and runs the real recovery sweep
// on the same MongoDB. Core recovery endpoints are a simulated API fixture
// (fakeCore); the Ollama and Core peers seen by the child are local HTTP
// fixtures that count every received effect.
const mockCore = { calls: [], released: false, owner: null, state: 'UNKNOWN', restoreResults: [] };
const mockListModels = jest.fn(async () => ({ models: [{ name: 'fixture:1' }] }));
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/helpers/ollamaHostConfig', () => ({ getConfiguredHosts: () => [] }));
jest.mock('../../src/helpers/ollamaTargetAdmission', () => ({ admitOllamaTargetResolved: async url => url }));
jest.mock('../../src/clients/ollamaClient', () => ({ listModels: (...args) => mockListModels(...args) }));
jest.mock('../../src/clients/coreApiClient', () => {
  const log = (name, value) => { mockCore.calls.push(name); return value; };
  return {
    adoptWorkloadRecovery: async ({ ownerId }) => { mockCore.owner = ownerId; return log('adopt', { adopted: true, recoveryOwnerId: ownerId }); },
    heartbeatWorkloadRecovery: async () => ({ heartbeat: true }),
    assertWorkloadRecovery: async () => ({ owned: true, recoveryOwnerId: mockCore.owner, recoveryState: mockCore.state }),
    transitionWorkloadRecovery: async (_id, state) => { mockCore.state = state; return log(state, { transitioned: true }); },
    restoreWorkloadRecoveryHosts: async () => log('restore', mockCore.restoreResults.shift() || { restored: true }),
    releaseWorkloadAdmission: async () => { mockCore.released = true; return log('release', { released: true }); },
    recoverWorkloadAdmissionRelease: async () => log('recover-release', mockCore.released
      ? { recovered: true, released: true } : { recovered: false, released: false }),
  };
});

const http = require('node:http');
const path = require('node:path');
const { fork } = require('node:child_process');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const HostProfile = require('../../models/HostProfile');
const recovery = require('../../src/services/profiler/profilerProjectionRecovery');

const fixture = path.join(__dirname, '../fixtures/profilerJournal.child.js');
const OLLAMA_PORT = Number(process.env.PROFILER_INTERRUPTION_OLLAMA_PORT || 3243);
const CORE_PORT = Number(process.env.PROFILER_INTERRUPTION_CORE_PORT || 3242);
const peers = { generate: 0, coreRelease: 0, answer: true, onGenerate: null };
let mongo;
let uri;
let servers = [];
const children = new Set();

function listen(handler, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(server));
  });
}

beforeAll(async () => {
  uri = process.env.TEST_USE_EXTERNAL_MONGO === 'true' ? process.env.MONGODB_URI_TEST : (mongo = await MongoMemoryServer.create()).getUri();
  await mongoose.connect(uri);
  await HostProfile.init();
  servers = await Promise.all([
    listen((req, res) => {
      req.resume();
      if (req.url !== '/api/generate') { res.statusCode = 404; return res.end(); }
      peers.generate += 1;
      peers.onGenerate?.();
      if (peers.answer) res.end(JSON.stringify({ done: true }));
    }, OLLAMA_PORT),
    listen((req, res) => {
      req.resume();
      peers.coreRelease += 1;
      mockCore.released = true;
      res.end(JSON.stringify({ released: true }));
    }, CORE_PORT),
  ]);
}, 60000);
afterAll(async () => {
  for (const child of [...children]) { child.kill('SIGKILL'); await child.exited; }
  for (const server of servers) { server.closeAllConnections?.(); await new Promise(done => server.close(done)); }
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  Object.assign(peers, { generate: 0, coreRelease: 0, answer: true, onGenerate: null });
  Object.assign(mockCore, { calls: [], released: false, owner: null, state: 'UNKNOWN', restoreResults: [] });
  mockListModels.mockClear();
  await HostProfile.deleteMany({});
  await HostProfile.create({ hostId: 'fixture', hostUrl: `http://127.0.0.1:${OLLAMA_PORT}` });
});

// Starts the writer and SIGKILLs it at its boundary (or on Ollama receipt).
function runWriterUntilKilled(phase) {
  return new Promise((resolve, reject) => {
    const child = fork(fixture, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env,
      PROFILER_CRASH_AT: phase, PROFILER_MONGO_URI: uri, PROFILER_OLLAMA_URL: `http://127.0.0.1:${OLLAMA_PORT}`,
      PROFILER_CORE_RELEASE_URL: `http://127.0.0.1:${CORE_PORT}/release` } });
    children.add(child);
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.exited = new Promise(done => child.once('exit', (code, signal) => { children.delete(child); done({ code, signal }); }));
    const kill = () => child.kill('SIGKILL');
    if (phase === 'after-dispatch') { peers.answer = false; peers.onGenerate = kill; }
    child.on('message', ({ event }) => {
      if (event === 'boundary') kill();
      if (event?.startsWith('error:')) reject(new Error(event));
    });
    const timer = setTimeout(() => { kill(); reject(new Error(`writer never reached ${phase}: ${stderr}`)); }, 20000);
    child.exited.then(exit => { clearTimeout(timer); resolve(exit); });
  });
}

const read = () => HostProfile.findOne({ hostId: 'fixture' }).lean();
// A failed pass waits for nextAttemptAt; tests make the retry due instead of sleeping.
const makeRetryDue = () => HostProfile.updateOne({ hostId: 'fixture' }, { $set: { 'reconciliation.nextAttemptAt': new Date(0) } });
// The dead writer's owner claim stays fresh for OWNER_STALE_MS; move it back
// instead of waiting a minute. Nothing else in the journal is edited.
const ageDeadOwner = () => HostProfile.updateOne({ hostId: 'fixture' },
  { $set: { 'reconciliation.ownerClaimedAt': new Date(Date.now() - 120000) } });
const sweep = () => recovery.recoverPendingHostProjections({ delayMs: 1, workerId: 'restarted-benchmark' });

test('death before the journal leaves nothing to recover and no runtime effect', async () => {
  expect((await runWriterUntilKilled('before-journal')).code).not.toBe(0);
  expect((await read()).reconciliation?.state).toBeUndefined();
  expect(await sweep()).toMatchObject({ inspected: 0 });
  expect(peers.generate).toBe(0);
  expect(mockCore.calls).toEqual([]);
}, 30000);

test('death after the journal but before dispatch restores once without inventing a runtime request', async () => {
  await runWriterUntilKilled('after-journal');
  expect((await read()).reconciliation).toMatchObject({ state: 'prepared', pendingRequests: 0, serverTerminalObserved: true });
  expect(await sweep()).toMatchObject({ inspected: 1, recovered: 0, pending: 1 });
  expect(mockCore.calls).toEqual([]);

  await ageDeadOwner();
  expect(await sweep()).toMatchObject({ recovered: 1 });
  expect(mockCore.calls).toEqual(['adopt', 'restore', 'VERIFIED', 'RESTORED', 'release']);
  expect((await read()).reconciliation).toMatchObject({ state: 'resolved', ownerId: null });
  expect(await sweep()).toMatchObject({ inspected: 0 });
  expect(peers.generate).toBe(0);
  expect(mockCore.calls.filter(call => call === 'release')).toHaveLength(1);
}, 30000);

test('death after dispatch with the response lost keeps the operator quarantine and never replays', async () => {
  await runWriterUntilKilled('after-dispatch');
  expect(peers.generate).toBe(1);
  expect((await read()).reconciliation).toMatchObject({ state: 'mutating', pendingRequests: 1, serverTerminalObserved: false });

  await ageDeadOwner();
  for (let pass = 0; pass < 2; pass += 1) {
    if (pass) {
      expect(await sweep()).toMatchObject({ inspected: 0 });
      await makeRetryDue();
    }
    const result = await sweep();
    expect(result).toMatchObject({ inspected: 1, recovered: 0, pending: 1 });
    expect(result.results[0]).toMatchObject({ operatorRequired: true });
  }
  const journal = (await read()).reconciliation;
  expect(journal).toMatchObject({ state: 'mutating', serverTerminalObserved: false, ownerId: null });
  expect(journal.reason).toMatch(/controlled runtime restart/);
  expect(mockCore.calls).toEqual([]);
  expect(peers.generate).toBe(1);
}, 30000);

test('death after a terminal receipt with a co-resident missing retries restoration before one release', async () => {
  await runWriterUntilKilled('after-terminal');
  expect(peers.generate).toBe(1);
  expect((await read()).reconciliation).toMatchObject({ state: 'pending_reconciliation', serverTerminalObserved: true });

  await ageDeadOwner();
  mockCore.restoreResults.push({ restored: false, reason: 'co-resident missing' });
  expect(await sweep()).toMatchObject({ recovered: 0, pending: 1 });
  expect(mockCore.calls).toEqual(['adopt', 'restore']);
  expect((await read()).reconciliation).toMatchObject({ state: 'pending_reconciliation', ownerId: null,
    reason: 'co-resident missing', failedAttempts: 1 });
  expect(await sweep()).toMatchObject({ inspected: 0 });
  await makeRetryDue();

  expect(await sweep()).toMatchObject({ recovered: 1 });
  expect(mockCore.calls).toEqual(['adopt', 'restore', 'adopt', 'restore', 'VERIFIED', 'RESTORED', 'release']);
  expect((await read()).reconciliation.state).toBe('resolved');
  expect(peers.generate).toBe(1);
}, 30000);

test('death after an acknowledged release reconciles the projection without restoring again', async () => {
  await runWriterUntilKilled('after-release');
  expect(peers).toMatchObject({ generate: 1, coreRelease: 1 });
  expect((await read()).reconciliation).toMatchObject({ state: 'verified' });

  await ageDeadOwner();
  expect(await sweep()).toMatchObject({ recovered: 1 });
  expect(mockCore.calls).toEqual(['recover-release']);
  expect((await read()).reconciliation).toMatchObject({ state: 'resolved', ownerId: null,
    releaseReceipt: { released: true } });
  expect(await sweep()).toMatchObject({ inspected: 0 });
  expect(peers).toMatchObject({ generate: 1, coreRelease: 1 });
}, 30000);
