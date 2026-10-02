#!/usr/bin/env node
'use strict';

/**
 * Run an arbitrary command while holding an AgentX benchmark claim.
 *
 * Example:
 *   node integrations/coding/with-agentx-claim.js \
 *     --core http://127.0.0.1:3180 \
 *     --host http://192.0.2.99:11434 \
 *     --batch manual-contract-scout-$(date +%Y%m%d%H%M%S) \
 *     --owner contract-scout \
 *     --estimate-ms 1800000 \
 *     --heartbeat-ttl-ms 60000 \
 *     -- node scout.js
 */

const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('child_process');
const { claimEnvironment, normalizeOrigin, UUID_V4 } = require('../../shared/agentxClaimAttestation');

const REQUEST_TIMEOUT_MS = 10_000;
const CLAIM_FINALIZATION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TERMINATION_GRACE_MS = 15 * 60 * 1000;

function usage() {
  console.error(`Usage:
  node integrations/coding/with-agentx-claim.js --host <ollama-url> [--host <ollama-url> ...] [options] -- <command> [args...]

Options:
  --core <url>              AgentX Core URL (default: AGENTX_CORE_URL or http://127.0.0.1:3180)
  --host <url>              Ollama host URL to claim; repeat for multi-host work
  --batch <id>              Claim id (default: manual-claim-<timestamp>)
  --claim-generation <uuid> Claim generation (default: a new UUID v4)
  --owner <name>            Owner label (default: manual-operator)
  --note <text>             Optional note stored on the claim
  --estimate-ms <ms>        Estimated duration (default: 1800000)
  --heartbeat-ttl-ms <ms>   Reaper TTL after missed heartbeat (default: 60000)
  --heartbeat-ms <ms>       Heartbeat interval (default: ttl / 3, min 5000)
  --termination-grace-ms <ms> Grace after TERM before KILL (default: 30000, max: 900000)
  --receipt <absolute-path> Write an owner-only, content-free lifecycle receipt
`);
}

function parseArgs(argv) {
  const opts = {
    core: process.env.AGENTX_CORE_URL || 'http://127.0.0.1:3180',
    host: null,
    hosts: [],
    batch: `manual-claim-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
    owner: 'manual-operator',
    note: null,
    claimGeneration: crypto.randomUUID(),
    estimateMs: 30 * 60 * 1000,
    heartbeatTtlMs: 60 * 1000,
    heartbeatMs: null,
    terminationGraceMs: 30 * 1000,
    receipt: null,
    command: []
  };

  const dashDash = argv.indexOf('--');
  const flagArgs = dashDash >= 0 ? argv.slice(0, dashDash) : argv;
  opts.command = dashDash >= 0 ? argv.slice(dashDash + 1) : [];

  for (let i = 0; i < flagArgs.length; i += 1) {
    const arg = flagArgs[i];
    const next = () => flagArgs[++i];
    if (arg === '--core') opts.core = next();
    else if (arg === '--host') opts.hosts.push(next());
    else if (arg === '--batch') opts.batch = next();
    else if (arg === '--claim-generation') opts.claimGeneration = next();
    else if (arg === '--owner') opts.owner = next();
    else if (arg === '--note') opts.note = next();
    else if (arg === '--estimate-ms') opts.estimateMs = Number(next());
    else if (arg === '--heartbeat-ttl-ms') opts.heartbeatTtlMs = Number(next());
    else if (arg === '--heartbeat-ms') opts.heartbeatMs = Number(next());
    else if (arg === '--termination-grace-ms') opts.terminationGraceMs = Number(next());
    else if (arg === '--receipt') opts.receipt = next();
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  opts.hosts = [...new Set(opts.hosts.map((host) => normalizeOrigin(host, '--host')))];
  opts.core = normalizeOrigin(opts.core, '--core');
  opts.host = opts.hosts[0] || null;
  if (!opts.host) throw new Error('--host is required');
  if (!UUID_V4.test(String(opts.claimGeneration || ''))) {
    throw new Error('--claim-generation must be a UUID v4');
  }
  if (!Number.isFinite(opts.estimateMs) || opts.estimateMs <= 0) throw new Error('--estimate-ms must be positive');
  if (!Number.isFinite(opts.heartbeatTtlMs) || opts.heartbeatTtlMs <= 0) throw new Error('--heartbeat-ttl-ms must be positive');
  if (!opts.heartbeatMs) opts.heartbeatMs = Math.max(5000, Math.floor(opts.heartbeatTtlMs / 3));
  if (!Number.isFinite(opts.heartbeatMs) || opts.heartbeatMs <= 0 || opts.heartbeatMs >= opts.heartbeatTtlMs) {
    throw new Error('--heartbeat-ms must be positive and less than --heartbeat-ttl-ms');
  }
  if (!Number.isFinite(opts.terminationGraceMs)
      || opts.terminationGraceMs < 1000
      || opts.terminationGraceMs > MAX_TERMINATION_GRACE_MS) {
    throw new Error('--termination-grace-ms must be between 1000 and 900000');
  }
  if (opts.receipt && !path.isAbsolute(opts.receipt)) throw new Error('--receipt must be an absolute path');
  return opts;
}

function claimPath(opts, host = opts.host) {
  return `${opts.core.replace(/\/+$/, '')}/api/nerve-center/host-preferences/${encodeURIComponent(host)}/benchmark-claim`;
}

function heartbeatPath(opts, host = opts.host) {
  return `${claimPath(opts, host)}/${encodeURIComponent(opts.batch)}/heartbeat`;
}

function releasePath(opts, host = opts.host) {
  return `${claimPath(opts, host)}/${encodeURIComponent(opts.batch)}`;
}

function buildClaimBody(opts) {
  return {
    batchId: opts.batch,
    claimGeneration: opts.claimGeneration,
    estimatedDurationMs: opts.estimateMs,
    source: 'manual',
    owner: opts.owner,
    note: opts.note,
    heartbeatTtlMs: opts.heartbeatTtlMs
  };
}

function buildHeartbeatBody(opts) {
  return {
    claimGeneration: opts.claimGeneration,
    source: 'manual',
    owner: opts.owner,
    note: opts.note,
    heartbeatTtlMs: opts.heartbeatTtlMs,
    estimatedDurationMs: opts.estimateMs
  };
}

function buildReleaseBody(opts) {
  // This wrapper always restores the full acquisition snapshot. Supplying an
  // explicit empty exclusion set makes that invariant part of the request as
  // well as the validated Product v1 receipt.
  return { claimGeneration: opts.claimGeneration, excludedModels: [] };
}

function exactClaimRuntimeSnapshot(snapshot) {
  return snapshot?.exact === true
    && snapshot?.source === 'ollama_ps'
    && snapshot?.error === null
    && Number.isFinite(new Date(snapshot?.capturedAt).getTime())
    && /^[0-9a-f]{64}$/.test(String(snapshot?.identityDigest || ''))
    && Array.isArray(snapshot?.residents)
    && snapshot.residents.every((entry) => typeof entry?.model === 'string' && entry.model.trim()
      && typeof entry?.digest === 'string' && entry.digest.trim()
      && Number.isFinite(Number(entry?.artifactSize)) && Number(entry.artifactSize) > 0
      && Number.isFinite(Number(entry?.sizeVram)) && Number(entry.sizeVram) >= 0
      && Number.isInteger(Number(entry?.contextLength)) && Number(entry.contextLength) > 0
      && (Number(entry?.keepAlive) === -1 && entry?.expiresAt === null
        || (Number(entry?.keepAlive) > 0 && Number.isFinite(new Date(entry?.expiresAt).getTime()))))
    && new Set(snapshot.residents.map((entry) => entry.model.toLowerCase())).size === snapshot.residents.length;
}

function confirmedClaimResponse(claim, opts) {
  const data = claim?.data;
  const activeClaim = data?.pref?.benchmarkClaim;
  return data?.claimed === true
    && data?.batchId === opts.batch
    && data?.claimGeneration === opts.claimGeneration
    && data?.snapshotExact === true
    && /^[0-9a-f]{64}$/.test(String(data?.snapshotIdentity || ''))
    && typeof data?.prevStatus === 'string' && data.prevStatus.trim()
    && activeClaim?.batchId === opts.batch
    && activeClaim?.claimGeneration === opts.claimGeneration
    && activeClaim?.prevStatus === data.prevStatus
    && exactClaimRuntimeSnapshot(activeClaim?.preClaimRuntime)
    && activeClaim.preClaimRuntime.identityDigest === data.snapshotIdentity;
}

function exactReleaseResident(entry) {
  const keepAlive = Number(entry?.keepAlive);
  return typeof entry?.model === 'string' && entry.model.trim()
    && typeof entry?.digest === 'string' && entry.digest.trim()
    && Number.isFinite(Number(entry?.artifactSize)) && Number(entry.artifactSize) > 0
    && Number.isFinite(Number(entry?.sizeVram)) && Number(entry.sizeVram) >= 0
    && Number.isInteger(Number(entry?.contextLength)) && Number(entry.contextLength) > 0
    && (keepAlive === -1
      ? entry?.expiresAt === null
      : (keepAlive > 0 && Number.isFinite(new Date(entry?.expiresAt).getTime())));
}

function confirmedReleaseResponse(result, opts, host, claimProof) {
  const data = result?.data;
  const receipt = data?.releaseReceipt;
  const snapshot = receipt?.snapshot;
  const verification = receipt?.verification;
  const state = receipt?.state;
  const digest = /^[0-9a-f]{64}$/;
  return result?.status === 'success'
    && data?.released === true
    && receipt?.contract === 'agentx.benchmark-claim-release/v1'
    && receipt?.hostUrl === host
    && receipt?.batchId === opts.batch
    && receipt?.claimGeneration === opts.claimGeneration
    && typeof claimProof?.prevStatus === 'string' && claimProof.prevStatus.trim()
    && /^[0-9a-f]{64}$/.test(String(claimProof?.snapshotIdentity || ''))
    && digest.test(String(snapshot?.identityDigest || ''))
    && snapshot.identityDigest === claimProof.snapshotIdentity
    && digest.test(String(snapshot?.appliedIdentityDigest || ''))
    && snapshot.appliedIdentityDigest === snapshot.identityDigest
    && snapshot?.exact === true
    && Number.isInteger(snapshot?.residentCount)
    && snapshot.residentCount >= 0
    && Array.isArray(snapshot?.residents)
    && snapshot.residentCount === snapshot.residents.length
    && snapshot.residents.every(exactReleaseResident)
    && new Set(snapshot.residents.map((entry) => entry.model.toLowerCase())).size === snapshot.residents.length
    && Array.isArray(snapshot?.excludedModels)
    && snapshot.excludedModels.length === 0
    && snapshot.excludedModels.every((model) => typeof model === 'string' && model.trim())
    && new Set(snapshot.excludedModels.map((model) => model.toLowerCase())).size === snapshot.excludedModels.length
    && verification?.status === 'ready'
    && verification?.ready === true
    && verification?.verified === true
    && verification?.degraded === false
    && verification?.mode === 'exact_runtime_snapshot'
    && verification?.snapshotIdentity === snapshot.identityDigest
    // restoredStatus is the exact pre-claim Product state. Its vocabulary is
    // Product-owned, so AIOps binds presence without inventing an allow-list.
    && state?.restoredStatus === claimProof.prevStatus
    && state?.claimCleared === true
    && state?.finalizerCleared === true
    && Number.isFinite(new Date(receipt?.releasedAt).getTime());
}

function buildRequestHeaders({ body = null } = {}) {
  return body ? { 'Content-Type': 'application/json' } : {};
}

async function requestJson(url, { method = 'GET', body = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const res = await fetch(url, {
    method,
    headers: buildRequestHeaders({ body }),
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${data?.message || data?.error || text}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function createHeartbeatKeeper(opts, {
  request = requestJson,
  onLost = async () => {}
} = {}) {
  const hosts = new Set();
  let timer = null;
  let inFlight = null;
  let stopped = false;

  const schedule = () => {
    if (stopped || timer || hosts.size === 0) return;
    timer = setTimeout(() => { void heartbeat(); }, opts.heartbeatMs);
    timer.unref?.();
  };

  const heartbeat = async () => {
    if (stopped || inFlight) return inFlight;
    if (timer) clearTimeout(timer);
    timer = null;
    const selectedHosts = [...hosts];
    inFlight = (async () => {
      const failures = [];
      for (const host of selectedHosts) {
        if (!hosts.has(host)) continue;
        try {
          const result = await request(heartbeatPath(opts, host), {
            method: 'POST',
            body: buildHeartbeatBody(opts)
          });
          if (result?.data?.heartbeat !== true
              || result?.data?.pref?.benchmarkClaim?.batchId !== opts.batch
              || result?.data?.pref?.benchmarkClaim?.claimGeneration !== opts.claimGeneration) {
            throw new Error(result?.data?.reason || 'heartbeat was not confirmed for this generation');
          }
        } catch (error) {
          hosts.delete(host);
          failures.push(`${host}: ${error.message}`);
        }
      }
      if (failures.length) {
        Promise.resolve(onLost(new Error(failures.join('; ')))).catch((error) => {
          console.error(`[agentx-claim] shutdown after heartbeat loss failed: ${error.message}`);
        });
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
      schedule();
    }
  };

  return {
    add(host) {
      if (stopped) throw new Error('heartbeat keeper is stopped');
      hosts.add(host);
      schedule();
    },
    remove(host) {
      hosts.delete(host);
      if (hosts.size === 0 && timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    start(initialHosts = []) {
      for (const host of initialHosts) hosts.add(host);
      schedule();
    },
    heartbeatNow: heartbeat,
    async waitForIdle() {
      if (inFlight) await inFlight;
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (inFlight) await inFlight;
      hosts.clear();
    },
    activeHosts() {
      return [...hosts];
    }
  };
}

async function releaseAcquiredClaims(opts, acquired, heartbeatKeeper, request = requestJson, claimProofs = new Map()) {
  const failures = [];
  for (const host of [...acquired].reverse()) {
    await heartbeatKeeper.waitForIdle();
    // Product's DELETE atomically transfers this generation to a 30-minute
    // fenced finalizer; claim heartbeats are then intentionally rejected.
    // Other hosts remain in the keeper until their own handoff begins.
    heartbeatKeeper.remove(host);
    try {
      const result = await request(releasePath(opts, host), {
        method: 'DELETE',
        body: buildReleaseBody(opts),
        timeoutMs: CLAIM_FINALIZATION_TIMEOUT_MS
      });
      if (!confirmedReleaseResponse(result, opts, host, claimProofs.get(host))) {
        throw new Error(result?.data?.reason
          || 'claim release did not prove exact runtime restoration and fenced finalization');
      }
      console.log(`[agentx-claim] released=true host=${host} batch=${opts.batch}`);
    } catch (error) {
      failures.push({ host, error: error.message });
      console.error(`[agentx-claim] release failed host=${host}: ${error.message}`);
    }
  }
  acquired.length = 0;
  await heartbeatKeeper.stop();
  return failures;
}

function writeReceipt(receiptPath, receipt) {
  if (!receiptPath) return;
  const parent = path.dirname(receiptPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${receiptPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, receiptPath);
  try { fs.chmodSync(receiptPath, 0o600); } catch { /* Windows has no POSIX mode contract. */ }
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: 1, signal: null, error }));
  });
}

function processGroupAlive(pid, {
  platform = process.platform,
  kill = process.kill
} = {}) {
  if (platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function signalChildTree(child, signal, {
  platform = process.platform,
  kill = process.kill,
  spawnProcess = spawn
} = {}) {
  if (platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === 'ESRCH') return false;
      if (error?.code !== 'EPERM') throw error;
    }
  }
  if (platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    const args = ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])];
    const taskkill = spawnProcess('taskkill.exe', args, {
      stdio: 'ignore',
      shell: false,
      windowsHide: true
    });
    const result = await waitForChildExit(taskkill);
    if (result.code === 0) return true;
  }
  return child.kill(signal);
}

async function waitForProcessTreeExit(child, {
  timeoutMs,
  exitPromise = waitForChildExit(child),
  platform = process.platform,
  kill = process.kill,
  pollMs = 10
} = {}) {
  const deadline = Date.now() + timeoutMs;
  if (platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    while (processGroupAlive(child.pid, { platform, kill })) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    }
    return true;
  }
  if (child.exitCode !== null || child.signalCode) return true;
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const exited = await Promise.race([exitPromise.then(() => true), timedOut]);
  clearTimeout(timer);
  return exited;
}

async function terminateChild(child, {
  graceMs,
  exitPromise = waitForChildExit(child),
  treeWaitMs = 5000,
  platform = process.platform,
  kill = process.kill,
  spawnProcess = spawn
} = {}) {
  const groupState = processGroupAlive(child.pid, { platform, kill });
  if ((child.exitCode === null && !child.signalCode) || groupState === true) {
    await signalChildTree(child, 'SIGTERM', { platform, kill, spawnProcess });
  }
  const exitedDuringGrace = await waitForProcessTreeExit(child, {
    timeoutMs: graceMs,
    exitPromise,
    platform,
    kill
  });
  if (!exitedDuringGrace) {
    await signalChildTree(child, 'SIGKILL', { platform, kill, spawnProcess });
    await exitPromise;
    const treeExited = await waitForProcessTreeExit(child, {
      timeoutMs: treeWaitMs,
      exitPromise,
      platform,
      kill
    });
    if (!treeExited) throw new Error('child process tree remained alive after forced termination');
  }
  return exitPromise;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const claimBody = buildClaimBody(opts);
  const acquired = [];
  const claimProofs = new Map();
  let child = null;
  let childExitPromise = null;
  let exiting = false;
  let exitCode = 0;
  let heartbeatError = null;
  let requestedSignal = null;
  let releaseStarted = false;
  let beginShutdown = null;
  let shutdownPromise = null;
  let resolveNoCommand;
  const noCommandExit = new Promise((resolve) => { resolveNoCommand = resolve; });
  const onSignal = (signal) => {
    requestedSignal = requestedSignal || signal;
    if (beginShutdown) void beginShutdown({ signal: requestedSignal }).catch(() => {});
  };
  // Install handlers before the first acquire request so partial multi-host
  // acquisition is always compensated after a bounded in-flight HTTP call.
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  const startedAt = new Date().toISOString();
  const receipt = {
    schemaVersion: 1,
    kind: 'agentx-host-claim-lifecycle',
    batchId: opts.batch,
    claimGeneration: opts.claimGeneration,
    owner: opts.owner,
    hosts: opts.hosts,
    startedAt,
    acquiredAt: null,
    endedAt: null,
    command: opts.command.length ? { executable: path.basename(opts.command[0]), argumentCount: opts.command.length - 1 } : null,
    heartbeat: 'not_started',
    release: 'not_started',
    exitCode: null,
    status: 'acquiring'
  };
  const heartbeatKeeper = createHeartbeatKeeper(opts, {
    onLost: async (error) => {
      console.error(`[agentx-claim] heartbeat lost: ${error.message}`);
      heartbeatError = heartbeatError || error;
      if (beginShutdown) await beginShutdown({ claimError: error });
    }
  });

  const release = async () => {
    if (releaseStarted) return;
    releaseStarted = true;
    const failures = await releaseAcquiredClaims(opts, acquired, heartbeatKeeper, requestJson, claimProofs);
    receipt.release = failures.length ? 'failed' : 'released';
    if (failures.length) {
      receipt.releaseFailures = failures;
      exitCode = exitCode || 1;
    }
  };

  try {
    for (const host of opts.hosts) {
      const claim = await requestJson(claimPath(opts, host), { method: 'POST', body: claimBody });
      if (claim?.data?.claimed === false) {
        throw new Error(`claim rejected for ${host}: ${claim?.data?.reason || 'unknown reason'}`);
      }
      // A successful POST whose body is malformed may still have committed the
      // generation. Include it in compensation before trusting any ACK field;
      // the fenced DELETE is harmless if Core did not acquire it.
      acquired.push(host);
      if (!confirmedClaimResponse(claim, opts)) {
        throw new Error(`claim response for ${host} did not prove the requested batch and generation`);
      }
      claimProofs.set(host, {
        prevStatus: claim.data.prevStatus,
        snapshotIdentity: claim.data.snapshotIdentity
      });
      heartbeatKeeper.add(host);
      if (requestedSignal) throw new Error(`claim wrapper interrupted by ${requestedSignal} during acquisition`);
      if (heartbeatError) {
        throw new Error(`claim heartbeat was lost during acquisition: ${heartbeatError.message}`);
      }
      console.log(`[agentx-claim] acquired host=${host} batch=${opts.batch}`);
    }
    await heartbeatKeeper.waitForIdle();
    if (requestedSignal) throw new Error(`claim wrapper interrupted by ${requestedSignal} during acquisition`);
    if (heartbeatError) {
      throw new Error(`claim heartbeat was lost during acquisition: ${heartbeatError.message}`);
    }
  } catch (error) {
    receipt.status = 'acquire_failed';
    receipt.error = error.message;
    await release();
    receipt.endedAt = new Date().toISOString();
    receipt.exitCode = 1;
    writeReceipt(opts.receipt, receipt);
    throw error;
  }
  receipt.acquiredAt = new Date().toISOString();
  receipt.heartbeat = 'active';
  receipt.status = 'running';
  try {
    writeReceipt(opts.receipt, receipt);
  } catch (error) {
    receipt.status = 'receipt_failed';
    receipt.error = 'initial claim receipt could not be written';
    exitCode = 1;
    await release();
    throw error;
  }

  beginShutdown = ({ signal = null, claimError = null } = {}) => {
    if (claimError) {
      heartbeatError = claimError;
      exitCode = 2;
      receipt.heartbeat = 'lost';
      receipt.status = 'claim_lost';
      receipt.error = claimError.message;
    }
    if (shutdownPromise) return shutdownPromise;
    exiting = true;
    if (!claimError) {
      requestedSignal = signal;
      exitCode = 128 + (signal === 'SIGINT' ? 2 : 15);
      receipt.status = 'interrupted';
    }
    shutdownPromise = (async () => {
      writeReceipt(opts.receipt, receipt);
      if (child) {
        await terminateChild(child, {
          graceMs: opts.terminationGraceMs,
          exitPromise: childExitPromise
        });
      } else {
        resolveNoCommand();
      }
    })();
    return shutdownPromise;
  };

  if (opts.command.length > 0) {
    const childEnv = claimEnvironment({
      hosts: opts.hosts,
      batchId: opts.batch,
      claimGeneration: opts.claimGeneration,
      coreUrl: opts.core
    });
    child = spawn(opts.command[0], opts.command.slice(1), {
      stdio: 'inherit',
      shell: false,
      detached: process.platform !== 'win32',
      env: childEnv
    });
    childExitPromise = waitForChildExit(child);
  } else {
    console.log('[agentx-claim] no command supplied; holding claim until Ctrl+C');
  }

  if (childExitPromise) {
    const childResult = await childExitPromise;
    if (!exiting) {
      exitCode = childResult.signal
        ? 128 + (childResult.signal === 'SIGINT' ? 2 : (childResult.signal === 'SIGKILL' ? 9 : 15))
        : (childResult.code ?? 1);
      if (childResult.error) console.error(`[agentx-claim] command failed to start: ${childResult.error.message}`);
    }
    if (!shutdownPromise) {
      await terminateChild(child, {
        graceMs: opts.terminationGraceMs,
        exitPromise: childExitPromise
      });
    }
  } else {
    await noCommandExit;
  }

  if (shutdownPromise) await shutdownPromise;
  exiting = true;
  await release();
  receipt.heartbeat = heartbeatError ? 'lost' : 'held_until_exit';
  receipt.status = heartbeatError
    ? 'claim_lost'
    : (requestedSignal ? 'interrupted' : (exitCode === 0 ? 'completed' : 'command_failed'));
  receipt.endedAt = new Date().toISOString();
  receipt.exitCode = exitCode;
  writeReceipt(opts.receipt, receipt);
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[agentx-claim] ${err.message}`);
    process.exit(err.status === 409 ? 3 : 1);
  });
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  CLAIM_FINALIZATION_TIMEOUT_MS,
  MAX_TERMINATION_GRACE_MS,
  parseArgs,
  claimPath,
  heartbeatPath,
  releasePath,
  buildClaimBody,
  buildHeartbeatBody,
  buildReleaseBody,
  exactClaimRuntimeSnapshot,
  confirmedClaimResponse,
  buildRequestHeaders,
  writeReceipt,
  exactReleaseResident,
  confirmedReleaseResponse,
  createHeartbeatKeeper,
  releaseAcquiredClaims,
  waitForChildExit,
  processGroupAlive,
  signalChildTree,
  waitForProcessTreeExit,
  terminateChild,
  requestJson,
  main
};
