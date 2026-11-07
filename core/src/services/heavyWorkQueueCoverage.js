'use strict';

// Adapter for Benchmark's immutable small-batch intent. Core remains the only
// reservation/dispatch/release owner; Benchmark retains its native batch owner.
const { requestJson } = require('../helpers/crossServiceClient');
const { fail } = require('./heavyWorkQueueContract');
const { isDeepStrictEqual } = require('node:util');

async function request(path, method = 'GET', body) {
  const result = await requestJson({ baseUrl: process.env.BENCHMARK_SERVICE_URL || 'http://localhost:3081',
    path, method, body, timeoutMs: method === 'POST' ? 300000 : 10000, serviceName: 'benchmark' });
  return result?.data ?? result;
}
const profileRequestId = job => job.kind === 'profiler' && /^benchmark-coverage:([a-f0-9-]{36})$/.exec(job.source?.ref || '')?.[1];
const requestIdFor = job => job.executor.mode === 'coverage' ? job.executor.requestId : profileRequestId(job);
const pathFor = job => `/api/benchmark/coverage/attempts/${encodeURIComponent(requestIdFor(job))}`;

function exactIntent(job, result) {
  const manifest = result?.manifest;
  if (result?.requestId !== requestIdFor(job) || result.queueId !== job.id
    || manifest?.key !== job.key || manifest.kind !== job.kind
    || !isDeepStrictEqual(manifest.executor, job.executor)
    || manifest.notBefore !== job.notBefore || manifest.startBefore !== job.startBefore
    || manifest.estimatedMinutes !== job.estimatedMinutes) {
    throw fail('Coverage receipt belongs to another intent', 409, 'HEAVY_QUEUE_EXECUTOR_CHANGED');
  }
  return result;
}

async function assertAdmission(job, { read = request } = {}) {
  const result = exactIntent(job, await read(`${pathFor(job)}/admission`));
  if (result.admitted !== true) throw fail('Coverage admission is not confirmed', 409);
  return result;
}

async function preDispatch(job, { exactHosts, read = request }) {
  const result = exactIntent(job, await read(pathFor(job)));
  exactHosts(job, result.manifest.hosts);
  return result;
}

async function start(job, { send = request } = {}) {
  const result = exactIntent(job, await send(`${pathFor(job)}/launch`, 'POST', {
    queueRequestId: job.id, queueDispatchId: job.dispatchId
  }));
  if (result.dispatchId !== job.dispatchId) throw fail('Coverage dispatch receipt is unavailable', 409);
  // The native producer publishes refusals before replying. Re-observation
  // will use that durable Core receipt even if this entire reply is lost.
  if (result.launchReceipt) {
    const receipt = require('../../../shared/queueLaunchReceipt.cjs').readRefusal(result, job);
    if (!receipt) throw fail('Invalid native coverage refusal receipt', 409);
    throw Object.assign(new Error(receipt.reason), { notStarted: true, code: receipt.code });
  }
  if (result.uncertain) throw fail(result.reason || 'Native coverage launch unknown', 409);
  return { requestId: result.requestId };
}

async function observe(job, { read = request } = {}) {
  const result = exactIntent(job, await read(pathFor(job)));
  if (result.dispatchId !== job.dispatchId || (job.operation && job.operation.id !== result.requestId)) {
    throw fail('Coverage receipt belongs to another dispatch', 409);
  }
  const base = { operationId: result.requestId, terminal: false };
  if (result.launchReceipt) {
    const receipt = require('../../../shared/queueLaunchReceipt.cjs').readRefusal(result, job);
    if (!receipt) throw fail('Invalid native coverage refusal receipt', 409);
    return { ...base, terminal: true, state: 'failed', authority: 'benchmark.coverage-refusal', refusal: receipt };
  }
  if (result.terminal === true && ['completed', 'failed', 'cancelled'].includes(result.state)
    && /^[a-f0-9]{24}$/.test(result.nativeId || '') && result.authority === 'benchmark.batch') {
    return { ...base, terminal: true, state: result.state, nativeId: result.nativeId, authority: result.authority };
  }
  return { ...base, ...(!result.nativeId && { operationId: undefined }),
    runningConfirmed: result.runningConfirmed === true && result.uncertain !== true,
    uncertain: result.uncertain === true, reason: result.reason };
}

async function unstartedRefusal(job, { read = request } = {}) {
  const result = exactIntent(job, await read(pathFor(job)));
  if (result.dispatchId !== job.dispatchId) return null;
  const receipt = require('../../../shared/queueLaunchReceipt.cjs').readRefusal(result, job);
  return receipt ? { dispatchId: job.dispatchId, code: receipt.code, reason: receipt.reason } : null;
}

module.exports = { preDispatch, start, observe, exactIntent, unstartedRefusal, profileRequestId, assertAdmission };
