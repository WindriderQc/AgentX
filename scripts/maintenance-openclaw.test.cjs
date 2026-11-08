'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reloadWithFence } = require('./maintenance-openclaw.cjs');
const { observeReload, reloadOpenclawStatus } = require('./maintenance-openclaw-observation.cjs');
const { ActionError, main } = require('./maintenance-actions.cjs');
const target = { pid: 100, ownerId: 'native-owner', port: 18000 };

function setup({ busy = 0, lost = false, health = true, invalidIdle = false, resumeFails = false } = {}) {
  let clock = 0, prepares = 0, dispatched = false;
  const calls = [], saves = [];
  const args = { requestId: 'synthetic-request', waitMs: 10000, healthMs: 4000, target, ActionError,
    now: () => clock, observationNow: () => clock, sleep: async ms => { clock += ms; },
    readTarget: async () => dispatched && health ? { ...target, pid: 101, ownerId: 'new-owner' } : target,
    ready: async () => health,
    save: async row => { saves.push(row); },
    rpc: async (method, params) => {
      calls.push({ method, params });
      if (method === 'gateway.suspend.prepare') return { status: prepares++ < busy ? 'draining' : 'ready',
        suspensionId: 'native-fence', activeCount: invalidIdle ? 1 : 0, blockers: [], expiresAtMs: clock + 120000 };
      if (method === 'gateway.suspend.resume') {
        if (resumeFails) throw new Error('Lost resume');
        return { ok: true, status: 'running' };
      }
      assert.equal(saves.at(-1).phase, 'dispatching');
      dispatched = true;
      if (lost) throw new Error('Lost acknowledgement');
      return { ok: true, status: 'emitted', pid: target.pid };
    } };
  return { args, calls, saves };
}

test('renews one native fence while busy, dispatches once only after idle, verifies successor readiness', async () => {
  const { args, calls, saves } = setup({ busy: 2 });
  const result = await reloadWithFence(args);
  assert.equal(result.runtimeReady, true);
  assert.equal(calls.filter(c => c.method === 'gateway.suspend.prepare').length, 3);
  assert.deepEqual(calls.at(-1).params, { reason: 'agentx.reload:synthetic-request', target, restartIntent: { waitMs: 0 } });
  assert.equal(saves.at(-1).phase, 'completed');
});

test('timeout and invalid idle evidence resume native scheduling without any restart', async () => {
  for (const opts of [{ busy: 99 }, { invalidIdle: true }]) {
    const { args, calls, saves } = setup(opts);
    await assert.rejects(reloadWithFence(args), e => e.outcome === 'refused');
    assert.equal(calls.at(-1).method, 'gateway.suspend.resume');
    assert.equal(calls.some(c => c.method === 'gateway.restart.request'), false);
    assert.equal(saves.at(-1).resumed, true);
  }
});

test('lost dispatch response and readiness timeout retain uncertainty without another mutation', async () => {
  for (const opts of [{ lost: true }, { health: false }]) {
    const { args, calls } = setup(opts);
    await assert.rejects(reloadWithFence(args), e => e.outcome === 'unknown');
    assert.equal(calls.filter(c => c.method === 'gateway.restart.request').length, 1);
    assert.equal(calls.some(c => c.method === 'gateway.suspend.resume'), false);
  }
});

test('changed native owner refuses and a failed resume never claims safe restoration', async () => {
  const changed = setup(); changed.args.readTarget = async () => ({ ...target, ownerId: 'other' });
  await assert.rejects(reloadWithFence(changed.args), e => e.outcome === 'refused');
  assert.deepEqual(changed.calls, []);
  const failed = setup({ busy: 99, resumeFails: true });
  await assert.rejects(reloadWithFence(failed.args), e => e.outcome === 'unknown');
});

test('native graceful shutdown and cold startup can outlast the first observation window', async () => {
  const { args, calls, saves } = setup({ health: false });
  await assert.rejects(reloadWithFence(args), e => e.outcome === 'unknown');
  assert.equal(saves.at(-1).phase, 'accepted');
  let clock = 0;
  const successor = { ...target, pid: 101, ownerId: 'successor' };
  const observed = await observeReload({ target, waitMs: 12000, now: () => clock,
    sleep: async ms => { clock += ms; },
    readTarget: async () => {
      if (clock < 2000) return target; // Native graceful shutdown still owns the lock.
      if (clock < 6000) throw new Error('Lock absent during handoff');
      return successor;
    }, ready: async () => clock >= 10000 }); // Cold startup is alive before ready.
  assert.deepEqual(observed, { runtimeReady: true, targetAfter: successor });
  assert.equal(clock, 10000);
  assert.equal(calls.filter(c => c.method === 'gateway.restart.request').length, 1);
  assert.equal(calls.some(c => c.method === 'gateway.suspend.resume'), false);
  assert.equal(saves.at(-1).phase, 'accepted');
});

test('readiness requires a fresh stable owner at the original port, even if HTTP is healthy', async () => {
  for (const after of [target, { ...target, pid: 101 },
    { ...target, ownerId: 'successor', port: 19000 }, { ...target, pid: 0, ownerId: 'successor' }]) {
    const result = await observeReload({ target, readTarget: async () => after, ready: async () => true, waitMs: 0 });
    assert.equal(result.runtimeReady, false);
  }
  let reads = 0;
  const changed = await observeReload({ target, waitMs: 0, ready: async () => true,
    readTarget: async () => ({ ...target, ownerId: `owner-${reads++}` }) });
  assert.equal(changed.runtimeReady, false, 'ownership changed while health endpoints were being read');
});

test('observation stops at its monotonic deadline while native ownership stays unchanged', async () => {
  let clock = 0, reads = 0;
  const sleeps = [];
  const observed = await observeReload({ target, waitMs: 4500, now: () => clock,
    readTarget: async () => { reads++; return target; }, ready: async () => assert.fail('old owner'),
    sleep: async ms => { sleeps.push(ms); clock += ms; } });
  assert.deepEqual(observed, { runtimeReady: false });
  assert.deepEqual(sleeps, [2000, 2000, 500]);
  assert.equal(clock, 4500);
  assert.equal(reads, 4);
});

async function withReceipt(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-reload-observation-'));
  const env = { ...process.env }, originalFetch = global.fetch;
  const lockFile = path.join(dir, 'gateway.lock');
  const file = path.join(dir, 'openclaw-reload-synthetic-request.json');
  const record = { contract: 'agentx.openclaw-reload/v1', requestId: 'synthetic-request', lockFile,
    phase: 'accepted', target, suspensionId: 'native-fence',
    acknowledgement: { ok: true, status: 'emitted', pid: target.pid } };
  fs.writeFileSync(lockFile, JSON.stringify({ ...target, pid: 101, ownerId: 'successor' }));
  fs.writeFileSync(file, JSON.stringify(record));
  Object.assign(process.env, { AGENTX_ENV_FILE: 'synthetic.env', AGENTX_PROJECT_NAME: 'synthetic',
    AGENTX_OPENCLAW_LOCK_FILE: lockFile, AGENTX_ACTION_RECEIPTS_DIR: dir,
    AGENTX_OPENCLAW_COMMAND: path.join(dir, 'never-dispatch') });
  delete process.env.AGENTX_LEAD_FILE;
  const urls = [];
  global.fetch = async url => { urls.push(url); return { status: 200 }; };
  try { await run({ dir, file, lockFile, record, urls, config: { receiptsDir: dir } }); }
  finally { process.env = env; global.fetch = originalFetch; fs.rmSync(dir, { recursive: true, force: true }); }
}

test('late status reconciles the same accepted request without actor, lease, dispatch or receipt changes', async () => {
  await withReceipt(async ({ dir, file, urls }) => {
    const { args, saves } = setup({ health: false });
    await assert.rejects(reloadWithFence(args), e => e.outcome === 'unknown');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(Object.assign(record, ...saves)));
    const lead = path.join(dir, 'LEAD.md');
    fs.writeFileSync(lead, 'held_by: another-operator\nnotes: original reload unknown; Released.\n');
    const originalFailure = path.join(dir, 'original-action.json');
    fs.writeFileSync(originalFailure, JSON.stringify({ outcome: 'unknown', leaseReleased: true }));
    const before = Object.fromEntries(fs.readdirSync(dir).map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
    for (let i = 0; i < 2; i += 1) {
      if (i === 0) delete process.env.AGENTX_LEAD_FILE;
      else process.env.AGENTX_LEAD_FILE = lead;
      const write = process.stdout.write;
      let output = '';
      process.stdout.write = chunk => { output += chunk; return true; };
      let code;
      try { code = await main(['reload-openclaw-status', '--request-id', 'synthetic-request']); }
      finally { process.stdout.write = write; }
      const receipt = JSON.parse(output);
      assert.equal(code, 3);
      assert.equal(receipt.outcome, 'unknown');
      assert.equal(receipt.result.requestId, 'synthetic-request');
      assert.equal(receipt.result.receiptRef, file);
      assert.equal(receipt.result.operationOutcome, 'unknown');
      assert.equal(receipt.result.observedReadiness.runtimeReady, true);
      assert.equal(receipt.result.phase, 'accepted');
      assert.equal(receipt.file, undefined);
    }
    assert.deepEqual(urls, Array(2).fill(['http://127.0.0.1:18000/healthz', 'http://127.0.0.1:18000/readyz']).flat());
    assert.deepEqual(Object.fromEntries(fs.readdirSync(dir).map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')])), before);
  });
});

test('ACK alone, missing handoff lock and partial readiness remain unknown and preserve the original', async () => {
  await withReceipt(async ({ file, lockFile, config }) => {
    const before = fs.readFileSync(file, 'utf8');
    const successor = fs.readFileSync(lockFile, 'utf8');
    for (const mode of ['predecessor', 'missing-lock', 'invalid-json', 'wrong-role', 'health-only', 'ready-only', 'http-unavailable']) {
      fs.writeFileSync(lockFile, mode === 'predecessor' ? JSON.stringify(target) : successor);
      if (mode === 'missing-lock') fs.unlinkSync(lockFile);
      if (mode === 'invalid-json') fs.writeFileSync(lockFile, '{');
      if (mode === 'wrong-role') fs.writeFileSync(lockFile, JSON.stringify({ ...JSON.parse(successor), role: 'worker' }));
      global.fetch = async url => {
        if (mode === 'http-unavailable') throw new Error('Cold startup');
        return { status: url.endsWith(mode === 'health-only' ? '/healthz' : '/readyz') ? 200 : 503 };
      };
      const result = await reloadOpenclawStatus(config, { 'request-id': 'synthetic-request' }, ActionError);
      assert.equal(result.operationOutcome, 'unknown');
      assert.equal(result.observedReadiness.runtimeReady, false);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
  });
});

test('PID reuse with a fresh owner is only readiness evidence and never proves the request completed', async () => {
  await withReceipt(async ({ lockFile, config, file, record }) => {
    fs.writeFileSync(lockFile, JSON.stringify({ ...target, ownerId: 'fresh-owner-same-pid' }));
    fs.writeFileSync(file, JSON.stringify({ ...record, privateExtra: 'synthetic-secret-marker',
      target: { ...target, privateExtra: 'synthetic-secret-marker' } }));
    const result = await reloadOpenclawStatus(config, { 'request-id': 'synthetic-request' }, ActionError);
    assert.equal(result.observedReadiness.runtimeReady, true);
    assert.equal(result.observedReadiness.targetAfter.pid, target.pid);
    assert.equal(result.operationOutcome, 'unknown');
    assert.equal(JSON.stringify(result).includes('synthetic-secret-marker'), false);
  });
});

test('original completion remains historical evidence when the current gateway is unavailable', async () => {
  await withReceipt(async ({ file, lockFile, config, record }) => {
    fs.writeFileSync(file, JSON.stringify({ ...record, phase: 'completed',
      targetAfter: { ...target, pid: 101, ownerId: 'successor' } }));
    fs.unlinkSync(lockFile);
    const before = fs.readFileSync(file, 'utf8');
    const result = await reloadOpenclawStatus(config, { 'request-id': 'synthetic-request' }, ActionError);
    assert.equal(result.operationOutcome, 'completed');
    assert.equal(result.observedReadiness.runtimeReady, false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});

test('lost ACK and invalid or missing original identities never become confirmed from a ready runtime', async () => {
  await withReceipt(async ({ file, record, config, urls }) => {
    for (const patch of [{ phase: 'dispatching', acknowledgement: undefined }, { phase: 'refused' },
      { acknowledgement: { ok: true, status: 'queued', pid: target.pid } },
      { acknowledgement: { ok: true, status: 'emitted', pid: 999 } },
      { requestId: 'another-request' }, { lockFile: '/another/gateway.lock' },
      { contract: 'unknown' }, { target: { ...target, port: 0 } }, { phase: 'completed' },
      { phase: 'completed', targetAfter: target }, { phase: { privateExtra: 'synthetic-secret-marker' } }]) {
      fs.writeFileSync(file, JSON.stringify({ ...record, ...patch }));
      const before = fs.readFileSync(file, 'utf8');
      await assert.rejects(reloadOpenclawStatus(config, { 'request-id': 'synthetic-request' }, ActionError),
        e => e.outcome === 'unknown' && e.exitCode === 3 && !JSON.stringify(e.details).includes('synthetic-secret-marker'));
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
    for (const content of ['{', 'null']) {
      fs.writeFileSync(file, content);
      await assert.rejects(reloadOpenclawStatus(config, { 'request-id': 'synthetic-request' }, ActionError),
        e => e.outcome === 'unknown' && e.exitCode === 3);
    }
    fs.unlinkSync(file);
    await assert.rejects(reloadOpenclawStatus(config, { 'request-id': 'synthetic-request' }, ActionError),
      e => e.outcome === 'unknown' && e.exitCode === 3);
    assert.deepEqual(urls, [], 'uncertain acceptance is not inferred from HTTP readiness');
  });
});

test('status refuses unsupported options and unbounded or unsafe request inputs', async () => {
  await withReceipt(async ({ config, urls }) => {
    for (const options of [{}, { 'request-id': '../other' }, { 'request-id': 'synthetic-request', actor: 'tester' },
      ...[-1, 16, 'NaN', 'Infinity'].map(value => ({ 'request-id': 'synthetic-request', 'wait-minutes': value }))]) {
      await assert.rejects(reloadOpenclawStatus(config, options, ActionError), e => e.exitCode === 2);
    }
    assert.deepEqual(urls, []);
  });
});
