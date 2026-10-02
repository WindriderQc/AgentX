'use strict';

// The real Core entry point (server.js) in a child process against the suite
// MongoDB and a synthetic Ollama peer. SIGTERM must end it on its own: exit 0
// after "Core shutdown drained", before the post-drain linger would name a
// leaked handle and exit nonzero (#17). Nothing here forces the exit.
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const CORE_ROOT = path.join(__dirname, '../..');
const EXIT_BOUND_MS = 5000; // well under the 15 s post-drain linger

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Answers like an idle Ollama until hung; then accepts requests and never
// answers, like a jammed host.
function syntheticOllama() {
  const state = { hung: false, held: [] };
  const replies = {
    '/api/tags': { models: [{ name: 'fixture-model:latest', model: 'fixture-model:latest', size: 1 }] },
    '/api/ps': { models: [] },
    '/api/version': { version: '0.0.0-fixture' }
  };
  const server = http.createServer((req, res) => {
    req.resume();
    if (state.hung) { state.held.push(req.url); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(replies[req.url.split('?')[0]] || {}));
  });
  return { server, state };
}

function startCore({ profile, port, ollamaUrl }) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: CORE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      AGENTX_PROFILE: profile,
      HOST: '127.0.0.1',
      PORT: String(port),
      OLLAMA_HOST: ollamaUrl,
      OLLAMA_HOST_SECONDARY: '',
      OLLAMA_HOST_2: '',
      MONGODB_URI: process.env.MONGODB_URI
    }
  });
  const run = { child, output: '', exit: null };
  child.stdout.on('data', data => { run.output += data; });
  child.stderr.on('data', data => { run.output += data; });
  run.exited = new Promise(resolve => child.on('exit', (code, signal) => {
    run.exit = { code, signal, at: Date.now() };
    resolve(run.exit);
  }));
  run.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Core did not start:\n${run.output.slice(-2000)}`)), 15000);
    const check = () => {
      if (run.output.includes('AgentX Core server started')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    run.exited.then(() => { clearTimeout(timer); reject(new Error(`Core exited during startup:\n${run.output.slice(-2000)}`)); });
  });
  return run;
}

async function terminate(run) {
  const sentAt = Date.now();
  run.child.kill('SIGTERM');
  // Only a test failure path: never let a hung child outlive the suite.
  const guard = setTimeout(() => run.child.kill('SIGKILL'), 20000);
  const exit = await run.exited;
  clearTimeout(guard);
  return { ...exit, elapsedMs: exit.at - sentAt };
}

function expectNaturalExit(result, output) {
  expect(output).toContain('Core shutdown drained');
  expect(output).not.toContain('Core shutdown left live handles after drain');
  expect(output).not.toContain('Core shutdown exceeded its deadline');
  expect({ code: result.code, signal: result.signal }).toEqual({ code: 0, signal: null });
  expect(result.elapsedMs).toBeLessThan(EXIT_BOUND_MS);
}

let ollama;
let ollamaUrl;
beforeAll(async () => {
  ollama = syntheticOllama();
  await new Promise(resolve => ollama.server.listen(0, '127.0.0.1', resolve));
  ollamaUrl = `http://127.0.0.1:${ollama.server.address().port}`;
});
afterAll(async () => {
  ollama.server.closeAllConnections();
  await new Promise(resolve => ollama.server.close(resolve));
});
beforeEach(() => { ollama.state.hung = false; ollama.state.held = []; });

test('full Core exits by itself after SIGTERM while a departed caller waits on a jammed host (#17)', async () => {
  const port = await freePort();
  const run = startCore({ profile: 'full', port, ollamaUrl });
  await run.ready;

  // A caller asks for the catalog of a host that stops answering, then leaves.
  ollama.state.hung = true;
  const caller = http.get({ host: '127.0.0.1', port, path: '/api/ollama/models', agent: false });
  caller.on('error', () => {});
  // Background pollers may also be held; wait for the caller's own read.
  const heldTags = () => ollama.state.held.filter(url => url === '/api/tags').length;
  const before = heldTags();
  while (heldTags() <= before) await new Promise(resolve => setTimeout(resolve, 20));
  caller.destroy();

  const result = await terminate(run);
  expectNaturalExit(result, run.output);
}, 30000);

test('demo Core exits by itself after SIGTERM', async () => {
  const port = await freePort();
  const run = startCore({ profile: 'demo', port, ollamaUrl });
  await run.ready;
  const result = await terminate(run);
  expectNaturalExit(result, run.output);
}, 30000);
