'use strict';

// The launcher's runtime lease (#93) against a synthetic Core: granted with a
// heartbeat and an exact release, refused with the holder named, unreachable.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const script = path.join(__dirname, 'runtime-lease.sh').replace(/\\/g, '/');

function fakeCore(refuse) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, caller: req.headers['x-agentx-caller'], body: body ? JSON.parse(body) : null });
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.method === 'POST' && req.url === '/api/nerve-center/maintenance-leases') {
        return refuse ? send(409, { status: 'error', data: { acquired: false } })
          : send(200, { status: 'success', data: { acquired: true, leaseId: 'lease-1', generation: 'gen-1' } });
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

test('a refused lease names the active work and holds nothing', async () => {
  const core = await fakeCore(true);
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

test('Core needs the global lease; a Benchmark-only recreate checks only Benchmark workloads', async () => {
  const scopes = await run(`for args in "core" "benchmark" "benchmark benchmark-runner --no-deps" "core benchmark" "" "rag"; do
    echo "[$args]=$(runtime_guard_scope $args)"; done`);
  assert.equal(scopes.stdout.trim(), ['[core]=core', '[benchmark]=benchmark', '[benchmark benchmark-runner --no-deps]=benchmark',
    '[core benchmark]=core', '[]=core', '[rag]='].join('\n'));
  const core = await fakeCore(true);
  try {
    const busy = await run(`runtime_workloads_active '${core.url}'; echo "rc=$?"`);
    assert.match(busy.stdout, /rc=0/);
    assert.match(busy.stderr, /"workloadId":"batch-42"/);
  } finally { core.server.close(); }
});
