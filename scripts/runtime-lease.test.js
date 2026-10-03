'use strict';

// The launcher's runtime lease (#93) against a synthetic Core: granted with a
// heartbeat and an exact release, refused with the holder named, unreachable.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const script = path.join(__dirname, 'runtime-lease.sh').replace(/\\/g, '/');

const BLOCKER = { type: 'workload', kind: 'benchmark', id: 'batch-42',
  summary: 'workload benchmark batch-42 on http://host-a:11434 (owner benchmark-service, started 2026-10-02T10:00:00.000Z): '
    + 'benchmark work goes through Core inference; a Core recreate cuts it. Cancel: Benchmark POST /api/benchmark/batch/batch-42/stop' };

// refuse: false, true (refusal with blockers) or 'legacy' (a Core without blockers or verdict endpoint).
function fakeCore(refuse) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, caller: req.headers['x-agentx-caller'], body: body ? JSON.parse(body) : null });
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.method === 'POST' && req.url === '/api/nerve-center/maintenance-leases') {
        return refuse ? send(409, { status: 'error', data: { acquired: false, ...(refuse === true && { blockers: [BLOCKER] }) } })
          : send(200, { status: 'success', data: { acquired: true, leaseId: 'lease-1', generation: 'gen-1' } });
      }
      if (refuse !== 'legacy' && req.url.startsWith('/api/nerve-center/runtime-coordination/deploy-blockers?service=')) {
        return send(200, { status: 'success', data: refuse ? { service: 'benchmark', allowed: false, blockers: [BLOCKER] }
          : { service: 'benchmark', allowed: true, blockers: [] } });
      }
      if (req.url === '/api/nerve-center/runtime-coordination/active') {
        return send(200, { ok: true, data: { maintenance: null, inferences: [],
          workloads: [{ workloadId: 'batch-42', kind: 'benchmark', hosts: ['http://host-a:11434'] }] } });
      }
      if (req.method === 'POST' && req.url === '/api/nerve-center/maintenance-leases/lease-1/heartbeat') return send(200, { data: { heartbeat: true } });
      if (req.method === 'DELETE' && req.url === '/api/nerve-center/maintenance-leases/lease-1') return send(200, { data: { released: true } });
      return send(404, {});
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

function run(body, env = {}) {
  return new Promise(resolve => {
    const child = spawn('bash', ['-c', `source '${script}'\n${body}`],
      { env: { ...process.env, AGENTX_RUNTIME_LEASE_HEARTBEAT_SECONDS: '1', ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('a granted lease heartbeats while held and is released with its exact generation', async () => {
  const core = await fakeCore(false);
  try {
    const result = await run(`runtime_lease_acquire '${core.url}' runtime-deploy; echo "rc=$? id=$RUNTIME_LEASE_ID"; sleep 1.6; runtime_lease_release; echo "released=$? id=[$RUNTIME_LEASE_ID]"`);
    assert.match(result.stdout, /rc=0 id=lease-1/);
    assert.match(result.stdout, /released=0 id=\[\]/);
    const [acquire] = core.seen;
    assert.equal(acquire.caller, 'operator');
    assert.equal(acquire.body.scope, 'runtime-deploy');
    assert.equal(acquire.body.ttlMs, 900000);
    assert.ok(core.seen.some(call => call.url.endsWith('/lease-1/heartbeat') && call.body.generation === 'gen-1'));
    const release = core.seen.find(call => call.method === 'DELETE');
    assert.deepEqual(release.body, { generation: 'gen-1' });
  } finally { core.server.close(); }
});

test('a refused lease prints the blockers Core names, with their cancel route, and holds nothing', async () => {
  const core = await fakeCore(true);
  try {
    const result = await run(`runtime_lease_acquire '${core.url}' core-recreate; echo "rc=$? id=[$RUNTIME_LEASE_ID]"`);
    assert.match(result.stdout, /rc=10 id=\[\]/);
    assert.match(result.stderr, /- workload benchmark batch-42 on http:\/\/host-a:11434 \(owner benchmark-service, started 2026-10-02T10:00:00.000Z\)/);
    assert.match(result.stderr, /Cancel: Benchmark POST \/api\/benchmark\/batch\/batch-42\/stop/);
    assert.equal(core.seen[0].body.scope, 'core-recreate');
    assert.equal(core.seen.some(call => call.method === 'DELETE'), false);
  } finally { core.server.close(); }
});

// A Core held only by background inference, which stops once a drain is requested (#253).
function drainingCore(blocker) {
  const seen = [];
  let draining = false;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url === '/api/nerve-center/runtime-coordination/drain') { draining = req.method === 'POST'; return send(200, { data: {} }); }
      if (req.method === 'POST' && req.url === '/api/nerve-center/maintenance-leases') {
        return draining ? send(200, { data: { acquired: true, leaseId: 'lease-1', generation: 'gen-1' } })
          : send(409, { status: 'error', data: { acquired: false, blockers: [blocker] } });
      }
      return send(200, { data: { released: true, heartbeat: true } });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test('held only by background inference, the launcher asks it to pause, takes the lease and withdraws the request', async () => {
  const core = await drainingCore({ type: 'inference', kind: 'inference-automated', id: 'synthetic-model',
    summary: 'inference inference-automated synthetic-model on http://host-a:11434 (owner core-inference, started unknown): Core serves it. Cancel: none' });
  try {
    const result = await run(`runtime_lease_acquire '${core.url}' core-recreate; echo "rc=$? id=$RUNTIME_LEASE_ID"; runtime_lease_release`,
      { AGENTX_RUNTIME_LEASE_DRAIN_SECONDS: '6', AGENTX_RUNTIME_LEASE_DRAIN_POLL_SECONDS: '1' });
    assert.match(result.stdout, /rc=0 id=lease-1/);
    assert.match(result.stderr, /asking it to pause/);
    const drain = core.seen.filter(call => call.endsWith('/runtime-coordination/drain'));
    assert.deepEqual(drain.map(call => call.split(' ')[0]), ['POST', 'DELETE']);
  } finally { core.server.close(); }
});

test('interactive or benchmark work is never asked to drain: the refusal is immediate', async () => {
  const core = await drainingCore({ type: 'inference', kind: 'trusted-runtime-stream', id: 'synthetic-model',
    summary: 'inference trusted-runtime-stream synthetic-model on http://host-a:11434 (owner core-trusted-runtime, started unknown): Core serves it. Cancel: none' });
  try {
    const result = await run(`runtime_lease_acquire '${core.url}' core-recreate; echo "rc=$? id=[$RUNTIME_LEASE_ID]"`,
      { AGENTX_RUNTIME_LEASE_DRAIN_SECONDS: '6', AGENTX_RUNTIME_LEASE_DRAIN_POLL_SECONDS: '1' });
    assert.match(result.stdout, /rc=10 id=\[\]/);
    assert.match(result.stderr, /inference trusted-runtime-stream synthetic-model/);
    assert.equal(core.seen.some(call => call.includes('/drain')), false);
  } finally { core.server.close(); }
});

test('a refusal from a Core without blockers falls back to its workload list', async () => {
  const core = await fakeCore('legacy');
  try {
    const result = await run(`runtime_lease_acquire '${core.url}' runtime-deploy; echo "rc=$? id=[$RUNTIME_LEASE_ID]"`);
    assert.match(result.stdout, /rc=10 id=\[\]/);
    assert.match(result.stderr, /"workloadId":"batch-42"/);
    assert.match(result.stderr, /"kind":"benchmark"/);
    assert.equal(core.seen.some(call => call.method === 'DELETE'), false);
  } finally { core.server.close(); }
});

test('an unreachable Core is reported distinctly so the launcher can decide', async () => {
  const core = await fakeCore(false);
  const { url } = core;
  await new Promise(resolve => core.server.close(resolve));
  const result = await run(`runtime_lease_acquire '${url}' runtime-deploy; echo "rc=$?"`);
  assert.match(result.stdout, /rc=11/);
});

test('only a recreate of Core or Benchmark, or of every service, needs the lease', async () => {
  const result = await run(`for args in "core" "benchmark-runner" "" "--no-deps --build" "rag" "rag data --no-deps"; do
    if runtime_guard_needed $args; then echo "[$args]=lease"; else echo "[$args]=none"; fi
  done`);
  assert.equal(result.stdout.trim(), ['[core]=lease', '[benchmark-runner]=lease', '[]=lease',
    '[--no-deps --build]=lease', '[rag]=none', '[rag data --no-deps]=none'].join('\n'));
});

test('Core alone takes the core-recreate lease, both or all services the global one, Benchmark only a verdict', async () => {
  const scopes = await run(`for args in "core" "core rag --no-deps" "benchmark" "benchmark benchmark-runner --no-deps" "core benchmark" "" "rag"; do
    scope=$(runtime_guard_scope $args); echo "[$args]=$scope/$( [[ -n $scope ]] && runtime_lease_scope $scope)"; done`);
  assert.equal(scopes.stdout.trim(), ['[core]=core/core-recreate', '[core rag --no-deps]=core/core-recreate',
    '[benchmark]=benchmark/runtime-deploy', '[benchmark benchmark-runner --no-deps]=benchmark/runtime-deploy',
    '[core benchmark]=all/runtime-deploy', '[]=all/runtime-deploy', '[rag]=/'].join('\n'));
});

test('a Benchmark recreate follows the Core verdict and names what it would cut', async () => {
  for (const [refuse, rc] of [[true, 0], [false, 1], ['legacy', 0]]) {
    const core = await fakeCore(refuse);
    try {
      const result = await run(`runtime_deploy_blocked '${core.url}' benchmark; echo "rc=$?"`);
      assert.match(result.stdout, new RegExp(`rc=${rc}`));
      if (refuse === true) assert.match(result.stderr, /Cancel: Benchmark POST \/api\/benchmark\/batch\/batch-42\/stop/);
      if (refuse === 'legacy') assert.match(result.stderr, /"workloadId":"batch-42"/);
    } finally { core.server.close(); }
  }
});
