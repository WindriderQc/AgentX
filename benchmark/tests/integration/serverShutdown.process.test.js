'use strict';

// The real Benchmark entry point (server.js) in a child process against the
// suite MongoDB. SIGTERM and SIGINT must run one shutdown sequence and end the
// process by itself with exit 0, well before the 5 s deadline. Batch execution
// is the only fixture (tests/fixtures/activeBatch.preload.js).
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkTimelineEntry = require('../../models/BenchmarkTimelineEntry');

const ROOT = path.join(__dirname, '../..');
const PRELOAD = path.join(__dirname, '../fixtures/activeBatch.preload.js');
const EXIT_BOUND_MS = 4000;
let mongo;
let uri;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startBenchmark(activeBatchId) {
  const [port, unusedPort] = [await freePort(), await freePort()];
  const child = spawn(process.execPath, ['--require', PRELOAD, 'server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TEST_LOG_LEVEL: 'info',
      MONGODB_URI_TEST: uri,
      HOST: '127.0.0.1',
      PORT: String(port),
      CORE_URL: `http://127.0.0.1:${unusedPort}`,
      BENCHMARK_FIXTURE_ACTIVE_BATCH: activeBatchId || ''
    }
  });
  const run = { child, output: '' };
  const collect = data => { run.output += data; };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  run.exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Benchmark did not start:\n${run.output.slice(-2000)}`)), 15000);
    const check = () => { if (run.output.includes('agentx-benchmark listening')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    run.exited.then(() => { clearTimeout(timer); reject(new Error(`Benchmark exited during startup:\n${run.output.slice(-2000)}`)); });
  });
  return run;
}

async function signal(run, name) {
  const sentAt = Date.now();
  run.child.kill(name);
  // Only a test failure path: never let a hung child outlive the suite.
  const guard = setTimeout(() => run.child.kill('SIGKILL'), 10000);
  const exit = await run.exited;
  clearTimeout(guard);
  return { code: exit.code, signal: exit.signal, elapsedMs: exit.at - sentAt };
}

beforeAll(async () => {
  uri = process.env.TEST_USE_EXTERNAL_MONGO === 'true'
    ? process.env.MONGODB_URI_TEST
    : (mongo = await MongoMemoryServer.create()).getUri();
  await mongoose.connect(uri);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

test.each(['SIGTERM', 'SIGINT'])('%s ends an idle Benchmark by itself with exit 0', async (name) => {
  const run = await startBenchmark(null);
  const result = await signal(run, name);
  expect(run.output).toContain('Benchmark shutdown drained');
  expect(run.output).not.toContain('Benchmark shutdown exceeded its deadline');
  expect({ code: result.code, signal: result.signal }).toEqual({ code: 0, signal: null });
  expect(result.elapsedMs).toBeLessThan(EXIT_BOUND_MS);
}, 30000);

test('SIGINT marks the running batch interrupted before exit 0', async () => {
  const batchId = new mongoose.Types.ObjectId();
  const run = await startBenchmark(String(batchId));
  // Written after startup, so orphaned-batch recovery never claims it.
  await BenchmarkBatch.collection.insertOne({
    _id: batchId, run_name: 'shutdown-fixture', host: 'harness', models: ['fixture:1'],
    status: 'running', updated_at: new Date()
  });

  const result = await signal(run, 'SIGINT');
  expect({ code: result.code, signal: result.signal }).toEqual({ code: 0, signal: null });
  expect(result.elapsedMs).toBeLessThan(EXIT_BOUND_MS);
  expect(await BenchmarkBatch.collection.findOne({ _id: batchId })).toMatchObject({ status: 'interrupted', active_slot: null });
  expect(await BenchmarkTimelineEntry.collection.findOne({ batchId })).toMatchObject({ event: 'sigint_interrupted', success: false });
}, 30000);
