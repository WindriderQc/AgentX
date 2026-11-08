'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameTarget = (a, b) => a?.pid === b?.pid && a?.ownerId === b?.ownerId && a?.port === b?.port;

function validTarget(value) {
  return Number.isSafeInteger(value?.pid) && value.pid > 0 && typeof value.ownerId === 'string'
    && value.ownerId.trim().length > 0 && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535;
}

function readTarget(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!validTarget(value) || value.role && value.role !== 'gateway') throw new Error('Native gateway lock identity is unavailable');
  return { pid: value.pid, ownerId: value.ownerId, port: value.port };
}

async function gatewayReady(after) {
  const statuses = await Promise.all(['/healthz', '/readyz'].map(async route =>
    (await fetch(`http://127.0.0.1:${after.port}${route}`, { signal: AbortSignal.timeout(2000), redirect: 'error' })).status));
  return statuses.every(status => status === 200);
}

// Only observations: a slow native drain/startup never becomes a new operation.
async function observeReload({ target, readTarget: inspect, ready = gatewayReady, waitMs,
  now = () => performance.now(), sleep = pause }) {
  const deadline = now() + waitMs;
  do {
    try {
      const after = await inspect();
      if (validTarget(after) && after.ownerId !== target.ownerId && after.port === target.port
        && await ready(after) && sameTarget(after, await inspect())) {
        return { runtimeReady: true, targetAfter: after };
      }
    } catch { /* Lock absence and HTTP failures are expected during native handoff. */ }
    if (now() >= deadline) return { runtimeReady: false };
    await sleep(Math.min(2000, deadline - now()));
  } while (true);
}

async function reloadOpenclawStatus(config, options, ActionError) {
  const requestId = options['request-id'];
  const minutes = Number(options['wait-minutes'] ?? 0);
  if (Object.keys(options).some(key => !['request-id', 'wait-minutes'].includes(key))
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(requestId || '')
    || !Number.isFinite(minutes) || minutes < 0 || minutes > 15) {
    throw new ActionError('Use --request-id and optional --wait-minutes from 0 to 15', { exitCode: 2 });
  }
  const lockFile = process.env.AGENTX_OPENCLAW_LOCK_FILE;
  if (!lockFile || !path.isAbsolute(lockFile) || !config.receiptsDir) {
    throw new ActionError('Configure AGENTX_OPENCLAW_LOCK_FILE and AGENTX_ACTION_RECEIPTS_DIR', { exitCode: 2 });
  }
  const file = path.join(config.receiptsDir, `openclaw-reload-${requestId}.json`);
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch {
    throw new ActionError('Original reload receipt is unavailable; do not dispatch a replacement',
      { outcome: 'unknown', exitCode: 3, details: { file, requestId } });
  }
  const phase = ['preparing', 'draining', 'dispatching', 'accepted', 'completed', 'refused'].includes(record?.phase)
    ? record.phase : undefined;
  const details = { file, requestId, phase };
  if (record?.contract !== 'agentx.openclaw-reload/v1' || record.requestId !== requestId
    || record.lockFile !== lockFile || !validTarget(record.target)) {
    throw new ActionError('Original reload receipt does not match this request and configured gateway',
      { outcome: 'unknown', exitCode: 3, details });
  }
  // A changed lock cannot recover a lost restart ACK or prove who caused it.
  const ack = record.acknowledgement;
  if (!['accepted', 'completed'].includes(record.phase) || ack?.ok !== true
    || ack.status !== 'emitted' || ack.pid !== record.target.pid) {
    throw new ActionError('Native restart acceptance is unconfirmed; preserve the original request',
      { outcome: 'unknown', exitCode: 3, details });
  }
  if (record.phase === 'completed' && (!validTarget(record.targetAfter)
    || record.targetAfter.ownerId === record.target.ownerId || record.targetAfter.port !== record.target.port)) {
    throw new ActionError('Original completion receipt has no valid successor identity',
      { outcome: 'unknown', exitCode: 3, details });
  }
  const observed = await observeReload({ target: record.target,
    readTarget: async () => readTarget(lockFile), waitMs: minutes * 60000 });
  // The original intent, ACK, failure/action receipt and lease release stay intact.
  // v1 has no native successor receipt bound to requestId. Current readiness
  // cannot turn an accepted request into a proven operation completion.
  const { pid, ownerId, port } = record.target;
  return { requestId, targetBefore: { pid, ownerId, port }, receiptRef: file, phase,
    operationOutcome: record.phase === 'completed' ? 'completed' : 'unknown',
    reason: record.phase === 'completed' ? 'Original receipt records completion; current readiness is a separate observation'
      : 'Native successor is not bound to this request by a completion receipt; do not repeat it',
    observedReadiness: observed };
}

module.exports = { readTarget, sameTarget, observeReload, reloadOpenclawStatus };
