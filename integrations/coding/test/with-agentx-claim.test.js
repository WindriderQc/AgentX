'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const {
  parseArgs,
  claimPath,
  heartbeatPath,
  releasePath,
  buildClaimBody,
  buildHeartbeatBody,
  buildReleaseBody,
  buildRequestHeaders,
  writeReceipt,
  confirmedClaimResponse,
  confirmedReleaseResponse,
  createHeartbeatKeeper,
  releaseAcquiredClaims,
  terminateChild,
  CLAIM_FINALIZATION_TIMEOUT_MS,
  MAX_TERMINATION_GRACE_MS
} = require('../with-agentx-claim');

function exactRelease(host) {
  const identityDigest = 'a'.repeat(64);
  return {
    status: 'success',
    data: {
      released: true,
      releaseReceipt: {
        contract: 'agentx.benchmark-claim-release/v1',
        hostUrl: host,
        batchId: 'batch-a',
        claimGeneration: '123e4567-e89b-42d3-a456-426614174000',
        snapshot: {
          identityDigest,
          appliedIdentityDigest: identityDigest,
          exact: true,
          residentCount: 1,
          residents: [{
            model: 'normal:model',
            digest: 'sha256:ollama-runtime-digest',
            artifactSize: 1234,
            sizeVram: 1234,
            contextLength: 262144,
            keepAlive: -1,
            expiresAt: null
          }],
          excludedModels: []
        },
        verification: {
          status: 'ready',
          ready: true,
          verified: true,
          degraded: false,
          mode: 'exact_runtime_snapshot',
          snapshotIdentity: identityDigest
        },
        state: {
          restoredStatus: 'warming',
          claimCleared: true,
          finalizerCleared: true
        },
        releasedAt: '2026-09-04T05:00:00.000Z'
      }
    }
  };
}

function exactClaimProof() {
  return { prevStatus: 'warming', snapshotIdentity: 'a'.repeat(64) };
}

test('claim lifecycle carries one exact generation through acquire, heartbeat, and release', () => {
  const opts = parseArgs([
    '--core', 'http://core:3080/',
    '--host', 'http://192.0.2.199:11434/',
    '--batch', 'repo-coding-final-20260902',
    '--owner', 'codex',
    '--note', 'paired executable qualification',
    '--estimate-ms', '900000',
    '--heartbeat-ttl-ms', '60000',
    '--', 'node', 'qualification.js'
  ]);

  assert.match(
    opts.claimGeneration,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  assert.deepEqual(buildClaimBody(opts), {
    batchId: 'repo-coding-final-20260902',
    claimGeneration: opts.claimGeneration,
    estimatedDurationMs: 900000,
    source: 'manual',
    owner: 'codex',
    note: 'paired executable qualification',
    heartbeatTtlMs: 60000
  });
  assert.deepEqual(buildHeartbeatBody(opts), {
    claimGeneration: opts.claimGeneration,
    source: 'manual',
    owner: 'codex',
    note: 'paired executable qualification',
    heartbeatTtlMs: 60000,
    estimatedDurationMs: 900000
  });
  assert.deepEqual(buildReleaseBody(opts), {
    claimGeneration: opts.claimGeneration,
    excludedModels: []
  });
  assert.equal(
    claimPath(opts),
    'http://core:3080/api/nerve-center/host-preferences/http%3A%2F%2F192.0.2.199%3A11434/benchmark-claim'
  );
  assert.equal(heartbeatPath(opts), `${claimPath(opts)}/repo-coding-final-20260902/heartbeat`);
  assert.equal(releasePath(opts), `${claimPath(opts)}/repo-coding-final-20260902`);
  assert.deepEqual(opts.command, ['node', 'qualification.js']);
  assert.deepEqual(opts.hosts, ['http://192.0.2.199:11434']);
  assert.equal(opts.core, 'http://core:3080');
  assert.equal(opts.terminationGraceMs, 30000);
  assert.equal(MAX_TERMINATION_GRACE_MS, 900000);
  assert.equal(parseArgs([
    '--host', 'http://candidate:11434', '--termination-grace-ms', '900000'
  ]).terminationGraceMs, 900000);
  assert.throws(
    () => parseArgs(['--host', 'http://candidate:11434', '--termination-grace-ms', '900001']),
    /between 1000 and 900000/
  );
  assert.throws(
    () => parseArgs([
      '--host', 'http://candidate:11434', '--heartbeat-ttl-ms', '60000', '--heartbeat-ms', '60000'
    ]),
    /less than --heartbeat-ttl-ms/
  );
});

test('acquire acknowledgement proves the exact batch and generation', () => {
  const opts = parseArgs([
    '--host', 'http://candidate:11434', '--batch', 'batch-a',
    '--claim-generation', '123e4567-e89b-42d3-a456-426614174000'
  ]);
  const exact = { data: {
    claimed: true,
    batchId: opts.batch,
    claimGeneration: opts.claimGeneration,
    snapshotExact: true,
    snapshotIdentity: 'a'.repeat(64),
    prevStatus: 'warming',
    pref: {
    benchmarkClaim: {
      batchId: opts.batch,
      claimGeneration: opts.claimGeneration,
      prevStatus: 'warming',
      preClaimRuntime: {
        exact: true,
        source: 'ollama_ps',
        error: null,
        capturedAt: '2026-09-04T00:00:00.000Z',
        identityDigest: 'a'.repeat(64),
        residents: []
      }
    }
  } } };
  assert.equal(confirmedClaimResponse(exact, opts), true);
  assert.equal(confirmedClaimResponse({ data: { ...exact.data, pref: { benchmarkClaim: {
    ...exact.data.pref.benchmarkClaim, batchId: 'other'
  } } } }, opts), false);
  assert.equal(confirmedClaimResponse({ data: { ...exact.data, pref: { benchmarkClaim: {
    batchId: opts.batch, claimGeneration: opts.claimGeneration
  } } } }, opts), false, 'old Product claims without an exact runtime snapshot must not launch a child');
  const incompleteResident = structuredClone(exact);
  incompleteResident.data.pref.benchmarkClaim.preClaimRuntime.residents = [{
    model: 'model:a', digest: 'a'.repeat(64), sizeVram: 1, contextLength: 4096,
    keepAlive: -1, expiresAt: null
  }];
  assert.equal(confirmedClaimResponse(incompleteResident, opts), false, 'artifact size is part of exact identity');
  const snapshotError = structuredClone(exact);
  snapshotError.data.pref.benchmarkClaim.preClaimRuntime.error = 'ollama unavailable';
  assert.equal(confirmedClaimResponse(snapshotError, opts), false, 'an exact snapshot cannot carry a capture error');
  const duplicateResidents = structuredClone(exact);
  duplicateResidents.data.pref.benchmarkClaim.preClaimRuntime.residents = [
    { model: 'model:a', digest: 'a'.repeat(64), artifactSize: 1, sizeVram: 1, contextLength: 4096, keepAlive: -1, expiresAt: null },
    { model: 'MODEL:A', digest: 'a'.repeat(64), artifactSize: 1, sizeVram: 1, contextLength: 4096, keepAlive: -1, expiresAt: null }
  ];
  assert.equal(confirmedClaimResponse(duplicateResidents, opts), false, 'resident identity must be unambiguous');
  const crossedProjection = structuredClone(exact);
  crossedProjection.data.snapshotIdentity = 'b'.repeat(64);
  assert.equal(confirmedClaimResponse(crossedProjection, opts), false, 'top-level and nested snapshot identities must agree');
  const crossedStatus = structuredClone(exact);
  crossedStatus.data.prevStatus = 'idle';
  assert.equal(confirmedClaimResponse(crossedStatus, opts), false, 'top-level and nested prior status must agree');
});

test('child termination waits through TERM and escalates to KILL only after bounded grace', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
    }
    return true;
  };
  const result = await terminateChild(child, { graceMs: 10 });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.signal, 'SIGKILL');
});

test('shutdown heartbeats outlive a grace period longer than the claim TTL', async () => {
  const opts = parseArgs([
    '--host', 'http://candidate:11434', '--batch', 'batch-a',
    '--claim-generation', '123e4567-e89b-42d3-a456-426614174000',
    '--heartbeat-ttl-ms', '15', '--heartbeat-ms', '5'
  ]);
  let beats = 0;
  const keeper = createHeartbeatKeeper(opts, {
    request: async () => {
      beats += 1;
      return { data: { heartbeat: true, pref: { benchmarkClaim: {
        batchId: opts.batch,
        claimGeneration: opts.claimGeneration
      } } } };
    }
  });
  keeper.start(opts.hosts);
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    if (signal === 'SIGKILL') {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
    }
    return true;
  };
  await terminateChild(child, { graceMs: 40 });
  await keeper.stop();
  assert.ok(beats >= 3, `expected heartbeats during shutdown grace, got ${beats}`);
});

test('fake time proves single-flight renewal continues beyond one full TTL', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const opts = parseArgs([
    '--host', 'http://candidate:11434', '--batch', 'batch-a',
    '--claim-generation', '123e4567-e89b-42d3-a456-426614174000',
    '--heartbeat-ttl-ms', '60000', '--heartbeat-ms', '10000'
  ]);
  let beats = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const keeper = createHeartbeatKeeper(opts, {
    request: async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      beats += 1;
      await Promise.resolve();
      concurrent -= 1;
      return { data: { heartbeat: true, pref: { benchmarkClaim: {
        batchId: opts.batch,
        claimGeneration: opts.claimGeneration
      } } } };
    }
  });
  keeper.start(opts.hosts);
  for (let elapsed = 0; elapsed < 70000; elapsed += 10000) {
    t.mock.timers.tick(10000);
    await keeper.waitForIdle();
  }
  await keeper.stop();
  assert.equal(beats, 7);
  assert.equal(maxConcurrent, 1);
});

test('forced shutdown kills and waits for a stubborn descendant process group', {
  skip: process.platform === 'win32' ? 'POSIX process-group contract' : false
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-claim-tree-'));
  const pidPath = path.join(root, 'descendant.pid');
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdio: 'ignore', shell: false
    });
    fs.writeFileSync(${JSON.stringify(pidPath)}, String(descendant.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `], { stdio: 'ignore', shell: false, detached: true });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(pidPath), true, 'descendant did not start');
    const descendantPid = Number(fs.readFileSync(pidPath, 'utf8'));
    const result = await terminateChild(child, { graceMs: 50, treeWaitMs: 5000 });
    assert.equal(result.signal, 'SIGKILL');
    const reapDeadline = Date.now() + 5000;
    let descendantAlive = true;
    while (descendantAlive && Date.now() < reapDeadline) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
        descendantAlive = false;
      }
    }
    assert.equal(descendantAlive, false, 'stubborn descendant remained after process-group KILL');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release requires exact runtime restoration and fenced finalization receipts', () => {
  const opts = parseArgs([
    '--host', 'http://candidate:11434', '--batch', 'batch-a',
    '--claim-generation', '123e4567-e89b-42d3-a456-426614174000'
  ]);
  const proof = exactClaimProof();
  assert.equal(confirmedReleaseResponse(exactRelease(opts.host), opts, opts.host, proof), true);
  const legacyFalseGreen = exactRelease(opts.host);
  legacyFalseGreen.data.releaseReceipt.verification.verified = false;
  assert.equal(confirmedReleaseResponse(legacyFalseGreen, opts, opts.host, proof), false);
  const unclearedFence = exactRelease(opts.host);
  unclearedFence.data.releaseReceipt.state.finalizerCleared = false;
  assert.equal(confirmedReleaseResponse(unclearedFence, opts, opts.host, proof), false);
  const missingExactMode = exactRelease(opts.host);
  delete missingExactMode.data.releaseReceipt.verification.mode;
  assert.equal(confirmedReleaseResponse(missingExactMode, opts, opts.host, proof), false);
  const wrongGeneration = exactRelease(opts.host);
  wrongGeneration.data.releaseReceipt.claimGeneration = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal(confirmedReleaseResponse(wrongGeneration, opts, opts.host, proof), false);
  const wrongAppliedIdentity = exactRelease(opts.host);
  wrongAppliedIdentity.data.releaseReceipt.snapshot.appliedIdentityDigest = 'b'.repeat(64);
  wrongAppliedIdentity.data.releaseReceipt.verification.snapshotIdentity = 'b'.repeat(64);
  assert.equal(confirmedReleaseResponse(wrongAppliedIdentity, opts, opts.host, proof), false);
  const unexpectedExclusion = exactRelease(opts.host);
  unexpectedExclusion.data.releaseReceipt.snapshot.excludedModels = ['expired:model'];
  assert.equal(confirmedReleaseResponse(unexpectedExclusion, opts, opts.host, proof), false);
  const invalidInfiniteExpiry = exactRelease(opts.host);
  invalidInfiniteExpiry.data.releaseReceipt.snapshot.residents[0].expiresAt = '2026-09-04T05:03:00.000Z';
  assert.equal(confirmedReleaseResponse(invalidInfiniteExpiry, opts, opts.host, proof), false);
  const wrongRestoredStatus = exactRelease(opts.host);
  wrongRestoredStatus.data.releaseReceipt.state.restoredStatus = 'idle';
  assert.equal(confirmedReleaseResponse(wrongRestoredStatus, opts, opts.host, proof), false);
});

test('slow first release keeps later hosts alive until their own finalization', async () => {
  const opts = parseArgs([
    '--host', 'http://candidate:11434', '--host', 'http://judge:11434',
    '--batch', 'batch-a', '--claim-generation', '123e4567-e89b-42d3-a456-426614174000',
    '--heartbeat-ttl-ms', '20', '--heartbeat-ms', '5'
  ]);
  const calls = [];
  const request = async (url, requestOptions) => {
    calls.push({ url, requestOptions, at: Date.now() });
    const host = url.includes('judge') ? opts.hosts[1] : opts.hosts[0];
    if (requestOptions.method === 'DELETE') {
      if (host === opts.hosts[1]) await new Promise((resolve) => setTimeout(resolve, 45));
      assert.equal(requestOptions.timeoutMs, CLAIM_FINALIZATION_TIMEOUT_MS);
      return exactRelease(host);
    }
    return { data: { heartbeat: true, pref: { benchmarkClaim: {
      batchId: opts.batch,
      claimGeneration: opts.claimGeneration
    } } } };
  };
  const keeper = createHeartbeatKeeper(opts, { request });
  const acquired = [...opts.hosts];
  keeper.start(acquired);
  const claimProofs = new Map(opts.hosts.map((host) => [host, exactClaimProof()]));
  const failures = await releaseAcquiredClaims(opts, acquired, keeper, request, claimProofs);
  assert.deepEqual(failures, []);
  assert.deepEqual(acquired, []);
  const candidateHeartbeats = calls.filter((call) => call.requestOptions.method === 'POST'
    && call.url.includes('candidate'));
  assert.ok(candidateHeartbeats.length >= 3, 'remaining claim must renew during another host restore');
});

test('multi-host claims normalize, deduplicate, and generate host-specific paths', () => {
  const opts = parseArgs([
    '--host', 'http://candidate:11434/',
    '--host', 'http://judge:11434',
    '--host', 'http://candidate:11434'
  ]);
  assert.deepEqual(opts.hosts, ['http://candidate:11434', 'http://judge:11434']);
  assert.equal(
    claimPath(opts, opts.hosts[1]),
    'http://127.0.0.1:3180/api/nerve-center/host-preferences/http%3A%2F%2Fjudge%3A11434/benchmark-claim'
  );
});

test('claim receipts are owner-only and content-free', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-claim-receipt-'));
  try {
    const receiptPath = path.join(root, 'nested', 'receipt.json');
    writeReceipt(receiptPath, {
      kind: 'agentx-host-claim-lifecycle',
      command: { executable: 'node', argumentCount: 2 },
      status: 'completed'
    });
    const raw = fs.readFileSync(receiptPath, 'utf8');
    assert.doesNotMatch(raw, /secret|operator-token/i);
    assert.equal(JSON.parse(raw).status, 'completed');
    if (process.platform !== 'win32') assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('each wrapper invocation receives a distinct generation token', () => {
  const first = parseArgs(['--host', 'http://candidate:11434']);
  const second = parseArgs(['--host', 'http://candidate:11434']);
  assert.notEqual(first.claimGeneration, second.claimGeneration);
});

test('claim authority accepts only a credential-free HTTP origin', () => {
  assert.throws(
    () => parseArgs(['--core', 'https://token@example.test:3080/api', '--host', 'http://candidate:11434']),
    /--core must be an HTTP\(S\) origin/
  );
});

test('lifecycle requests carry only a JSON content type when they have a body', () => {
  assert.deepEqual(buildRequestHeaders({ body: { batchId: 'batch-1' } }), { 'Content-Type': 'application/json' });
  assert.deepEqual(buildRequestHeaders(), {});
});

test('heartbeat scheduling is single-flight and release follows child exit handling', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'with-agentx-claim.js'), 'utf8');
  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.match(source, /function createHeartbeatKeeper/);
  assert.match(source, /inFlight = \(async \(\) =>/);
  const exitWait = source.indexOf('const childResult = await childExitPromise');
  assert.ok(exitWait >= 0 && source.slice(exitWait).indexOf('await release();') > 0);
});
