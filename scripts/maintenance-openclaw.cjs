'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameTarget = (a, b) => a?.pid === b?.pid && a?.ownerId === b?.ownerId && a?.port === b?.port;

function readTarget(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.ownerId !== 'string'
    || !value.ownerId || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || value.role && value.role !== 'gateway') throw new Error('Native gateway lock identity is unavailable');
  return { pid: value.pid, ownerId: value.ownerId, port: value.port };
}

// Native suspension owns the scheduler and admission fence. No local busy
// registry, systemctl restart, force, cancellation or bounded safe-restart timer.
async function reloadWithFence({ requestId, waitMs, healthMs = 180000, rpc, target,
  readTarget: inspect, save, ready, now = Date.now, sleep = pause, ActionError }) {
  const fail = (message, outcome = 'refused') => new ActionError(message,
    { outcome, exitCode: outcome === 'unknown' ? 3 : 4 });
  const deadline = now() + waitMs;
  let suspensionId, dispatched = false;
  try {
    for (;;) {
      if (!sameTarget(target, await inspect())) throw fail('Gateway changed before reload; no restart dispatched');
      const lease = await rpc('gateway.suspend.prepare', { requestId, terminalPolicy: 'preserve', drain: true });
      if (!['ready', 'draining'].includes(lease?.status) || typeof lease.suspensionId !== 'string') {
        throw fail('Native gateway did not grant this request a suspension fence');
      }
      if (suspensionId && lease.suspensionId !== suspensionId) throw fail('Native suspension identity changed');
      suspensionId = lease.suspensionId;
      await save({ phase: 'draining', suspensionId, expiresAtMs: lease.expiresAtMs });
      if (lease.status === 'ready') {
        if (lease.activeCount !== 0 || !Array.isArray(lease.blockers) || lease.blockers.length
          || !Number.isFinite(lease.expiresAtMs) || lease.expiresAtMs - now() < 15000) {
          throw fail('Native gateway idle evidence is incomplete or expiring');
        }
        break;
      }
      if (now() >= deadline) throw fail('Gateway remains busy; reload refused without interrupting work');
      await sleep(Math.min(5000, deadline - now()));
    }
    if (!sameTarget(target, await inspect())) throw fail('Gateway changed behind the suspension fence');
    // Persist before the single irreversible dispatch. A lost acknowledgement
    // must never cause a second restart or release an uncertain native owner.
    await save({ phase: 'dispatching', suspensionId });
    dispatched = true;
    const ack = await rpc('gateway.restart.request', { reason: `agentx.reload:${requestId}`, target,
      restartIntent: { waitMs: 0 } });
    if (ack?.ok !== true || ack.status !== 'emitted' || ack.pid !== target.pid) {
      throw fail('Native restart acknowledgement is uncertain; reconcile this request', 'unknown');
    }
    await save({ phase: 'accepted', suspensionId, acknowledgement: ack });
    const healthDeadline = now() + healthMs;
    do {
      try {
        const after = await inspect();
        if (!sameTarget(target, after) && after.port === target.port && await ready(after)) {
          await save({ phase: 'completed', targetAfter: after });
          return { requestId, targetBefore: target, targetAfter: after, runtimeReady: true };
        }
      } catch { /* A missing lock during the native handoff is not a retry. */ }
      if (now() >= healthDeadline) throw fail('Reload accepted but readiness is unconfirmed; do not repeat it', 'unknown');
      await sleep(Math.min(2000, healthDeadline - now()));
    } while (true);
  } catch (error) {
    if (dispatched) throw fail(error.message, 'unknown');
    if (suspensionId) {
      try {
        const resumed = await rpc('gateway.suspend.resume', { suspensionId });
        if (resumed?.ok !== true || resumed.status !== 'running') throw new Error('Unconfirmed native resume');
        await save({ phase: 'refused', suspensionId, resumed: true, reason: error.message });
      } catch (resumeError) {
        throw fail(`${error.message}; native resume unconfirmed: ${resumeError.message}`, 'unknown');
      }
    }
    throw error;
  }
}

async function reloadOpenclaw(config, options, ActionError) {
  const allowed = ['actor', 'request-id', 'wait-minutes'];
  if (Object.keys(options).some(key => !allowed.includes(key))) throw new ActionError('Unsupported reload option', { exitCode: 2 });
  const requestId = options['request-id'];
  const minutes = Number(options['wait-minutes'] ?? 5);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(requestId || '') || !Number.isFinite(minutes) || minutes < 0 || minutes > 15) {
    throw new ActionError('Use a stable --request-id and --wait-minutes from 0 to 15', { exitCode: 2 });
  }
  const lockFile = process.env.AGENTX_OPENCLAW_LOCK_FILE;
  if (!lockFile || !path.isAbsolute(lockFile) || !config.receiptsDir) {
    throw new ActionError('Configure AGENTX_OPENCLAW_LOCK_FILE and AGENTX_ACTION_RECEIPTS_DIR', { exitCode: 2 });
  }
  fs.mkdirSync(config.receiptsDir, { recursive: true });
  const file = path.join(config.receiptsDir, `openclaw-reload-${requestId}.json`);
  const record = { contract: 'agentx.openclaw-reload/v1', requestId, lockFile, phase: 'preparing', target: readTarget(lockFile) };
  try { fs.writeFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new ActionError('Request already recorded; reconcile its native result, never dispatch it again',
      { outcome: 'unknown', exitCode: 3, details: { file } });
  }
  const save = async patch => {
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    const temporary = `${file}.next`;
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  const rpc = async (method, params) => {
    const { stdout } = await execute(process.env.AGENTX_OPENCLAW_COMMAND || 'openclaw',
      ['gateway', 'call', method, '--params', JSON.stringify(params), '--timeout', '10000', '--json'],
      { timeout: 20000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  };
  try {
    const result = await reloadWithFence({ requestId, waitMs: minutes * 60000, rpc, target: record.target,
      readTarget: async () => readTarget(lockFile), save, ActionError,
      ready: async after => {
        const statuses = await Promise.all(['/healthz', '/readyz'].map(async route =>
          (await fetch(`http://127.0.0.1:${after.port}${route}`, { signal: AbortSignal.timeout(2000), redirect: 'error' })).status));
        return statuses.every(status => status === 200);
      } });
    return { ...result, receiptRef: file };
  } catch (error) {
    error.details = { ...error.details, file, phase: record.phase };
    throw error;
  }
}

module.exports = { reloadWithFence, reloadOpenclaw, readTarget };
