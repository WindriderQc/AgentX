'use strict';

const { requestJson } = require('../helpers/crossServiceClient');
const Runtime = require('../../models/RuntimeCoordination');
const Images = require('../../models/ImageOperation');
const queue = require('./heavyWorkQueueService');
const { hosts, fail } = require('./heavyWorkQueueContract');
const { planId, planRef, planTag, batchRequest } = require('../../../shared/benchmarkBatchPlan.cjs');

async function benchmark(path) {
  const answer = await requestJson({ baseUrl: process.env.BENCHMARK_SERVICE_URL || 'http://localhost:3081',
    path, method: 'GET', timeoutMs: 10000, serviceName: 'benchmark' });
  return answer?.data ?? answer;
}
function exactHosts(job, actual) {
  if (JSON.stringify(hosts(actual)) !== JSON.stringify(job.hosts)) throw fail('Executor hosts differ from the queued request; submit a new request', 409, 'HEAVY_QUEUE_EXECUTOR_CHANGED');
}
async function preDispatch(job) {
  if (!job.executor) throw fail('No supported executor on this request', 409);
  if (job.kind === 'benchmark') {
    const request = batchRequest(job.executor.request, { judgeRequired: true });
    if (job.executor.prepare !== true && planRef(planId(job.executor.plan), request) !== job.executor.plan) throw fail('Benchmark plan reference differs from its request', 409);
    exactHosts(job, [request.host, request.judgeHost]);
  } else if (job.kind === 'profiler') {
    const host = await benchmark(`/api/profiler/hosts/${encodeURIComponent(job.executor.hostId)}`);
    exactHosts(job, [host.hostUrl]);
  } else if (job.kind === 'image') {
    const config = require('./images/config').loadConfig();
    if (!config || !config.profiles[job.executor.profile || config.defaultProfile]) throw fail('Image executor is not configured', 409);
    exactHosts(job, config.ollamaHosts);
    const input = require('./images/imageService').validate(job.executor, config);
    const prior = await Images.findOne({ actionKey: job.executor.actionKey }).select('requestHash').lean();
    if (prior && prior.requestHash !== input.requestHash) throw fail('Image actionKey already names another request', 409);
  } else throw fail('This request has no supported executor', 409);
}
async function observe(job) {
  let operationId = job.operation?.id;
  let receipt;
  if (job.kind === 'benchmark') {
    if (job.executor.prepare === true) throw fail('Preparation needs its native operator plan receipt, not a batch lookup', 409);
    const tag = planTag(planId(job.executor.plan));
    if (!operationId) {
      const result = await benchmark(`/api/benchmark/batches?tag=${encodeURIComponent(tag)}&limit=2`);
      if (result?.batches?.length !== 1) throw fail('No unique batch receipt for this request; dispatch stays uncertain', 409);
      operationId = String(result.batches[0]._id);
    }
    if (!/^[a-f0-9]{24}$/.test(operationId)) throw fail('Invalid batch receipt identity', 409);
    receipt = await benchmark(`/api/benchmark/batch/${operationId}?result_limit=1`);
    if (!receipt.tags?.includes(tag)) throw fail('Batch does not carry the queued plan identity', 409);
    if (['running', 'judging'].includes(receipt.status) || receipt.judge_status === 'running') return { operationId, terminal: false };
    if (!['completed', 'failed', 'cancelled', 'stopped'].includes(receipt.status)) throw fail('Batch outcome is not terminal', 409);
    receipt = { state: receipt.status === 'stopped' ? 'cancelled' : receipt.status, authority: 'benchmark.batch', operationId };
  } else if (job.kind === 'profiler') {
    if (!operationId) {
      const active = await benchmark('/api/profiler/pipeline/profile-host/active');
      const matches = (active?.active || []).filter(item => item.queueRequestId === job.id);
      if (matches.length !== 1) throw fail('Profiler has no unique receipt; inspect its native journal before recovery', 409);
      operationId = matches[0].queueId;
    }
    const result = await benchmark(`/api/profiler/pipeline/profile-host/${encodeURIComponent(operationId)}/progress`);
    if (result.queueRequestId !== job.id || result.hostId !== job.executor.hostId) throw fail('Profiler receipt belongs to another request', 409);
    if (result.queueStatus === 'running') return { operationId, terminal: false };
    if (!['completed', 'failed', 'cancelled'].includes(result.queueStatus)) throw fail('Profiler outcome is not terminal', 409);
    receipt = { state: result.queueStatus, authority: 'profiler.host-queue', operationId };
  } else if (job.kind === 'image') {
    if (!operationId) operationId = (await Images.findOne({ actionKey: job.executor.actionKey }).select('_id').lean())?._id;
    if (!operationId) throw fail('Image receipt is unavailable; no new generation is authorized', 409);
    const result = await require('./images/imageService').getForAction(operationId, job.executor.actionKey);
    if (!['completed', 'failed', 'cancelled', 'archive_failed'].includes(result.state)) return { operationId, terminal: false, uncertain: result.state === 'unknown' };
    receipt = { state: result.state === 'archive_failed' ? 'failed' : result.state, authority: 'core.image-operation', operationId,
      runtimeRestored: result.runtimeRestored, artifact: result.artifact || null };
  } else throw fail('No executor evidence adapter on this request', 409);
  // Native owners retain release authority. A terminal result is insufficient
  // while a matching runtime admission (including UNKNOWN) remains fenced.
  const runtime = await Runtime.findById('runtime').lean();
  const held = [...(runtime?.workloads || []), ...(runtime?.inferences || [])]
    .some(item => queue.runtimeOverlaps(job, item));
  return { operationId, terminal: !held, waitingForRelease: held, ...receipt, observedAt: new Date().toISOString() };
}
async function reconcile(id, actor) {
  let job = await queue.get(id);
  if (!['dispatching', 'running', 'uncertain'].includes(job.state)) return job;
  const result = await observe(job);
  if (!job.operation) job = await queue.record(id, { dispatchId: job.dispatchId, state: 'running', operationId: result.operationId }, actor);
  if (result.terminal) return queue.settle(id, result, actor);
  if (result.uncertain && job.state !== 'uncertain') return queue.record(id, { dispatchId: job.dispatchId, state: 'uncertain', reason: 'Native executor reports an unknown outcome' }, actor);
  return { ...job, observation: result };
}

module.exports = { preDispatch, reconcile, observe };
