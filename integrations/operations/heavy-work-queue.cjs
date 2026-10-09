#!/usr/bin/env node
'use strict';

// Operator entrance for coding sessions. Only named existing executors; no
// arbitrary command, URL or shell is taken from a queued request.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const ROOT = path.resolve(__dirname, '../..');
const { planId, planRef, batchRequest } = require('../../shared/benchmarkBatchPlan.cjs');
const ACTIONS = new Set(['list', 'show', 'submit', 'reserve', 'cancel', 'run', 'reconcile', 'migrate', 'archive', 'recover']);

function parse(argv) {
  const [action, ...args] = argv;
  if (!ACTIONS.has(action)) throw new Error(`Use: ${[...ACTIONS].join(', ')}`);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--[a-z-]+$/.test(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Options need --name value');
    const key = args[i].slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate --${key}`);
    options[key] = args[i + 1];
  }
  const allowed = ['core', 'actor', 'id', 'file', 'revision', 'start', 'priority', 'sha256', 'benchmark', 'dispatch-id', 'receipt', 'confirmation'];
  if (Object.keys(options).some(key => !allowed.includes(key))) throw new Error('Unsupported option');
  const core = options.core || process.env.AGENTX_CORE_URL;
  if (!core) throw new Error('--core or AGENTX_CORE_URL required; use the instance operator address');
  const url = new URL(core);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Core needs an HTTP(S) origin');
  if (!['list', 'show'].includes(action) && !options.actor) throw new Error('--actor required');
  if (['show', 'reserve', 'cancel', 'run', 'reconcile', 'recover'].includes(action) && !/^[a-f0-9-]{36}$/.test(options.id || '')) throw new Error('--id needs a queue request UUID');
  return { action, options, core: url.origin };
}
async function json(url, { body, actor = 'operator', fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const response = await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-service-caller': actor, 'x-agentx-caller': 'operator' },
    signal: AbortSignal.timeout(timeoutMs), ...(body !== undefined && { body: JSON.stringify(body) }) });
  const answer = await response.json();
  if (!response.ok || answer.ok === false || answer.status === 'error') throw new Error(answer.message || answer.error || `HTTP ${response.status}`);
  return answer.data ?? answer;
}
function checkPlan(job, receiptsDir = process.env.AGENTX_ACTION_RECEIPTS_DIR) {
  if (!receiptsDir) throw new Error('Benchmark execution requires AGENTX_ACTION_RECEIPTS_DIR');
  const ref = job.executor.plan;
  const saved = JSON.parse(fs.readFileSync(path.join(receiptsDir, 'benchmark-batch', `${planId(ref)}.json`), 'utf8'));
  if (saved.contract !== 'agentx.benchmark-batch-plan/v1' || saved.ref !== ref || planRef(planId(ref), saved.request) !== ref
    || !isDeepStrictEqual(batchRequest(saved.request, { judgeRequired: true }), batchRequest(job.executor.request, { judgeRequired: true }))) {
    throw new Error('The local prepared plan differs from this queue request');
  }
  return saved;
}
async function benchmarkStart(job, { actor, benchmark, assertDispatch }) {
  const maintenance = require('../../scripts/maintenance-actions.cjs');
  const config = maintenance.instance(process.env, { mutating: true });
  let holder;
  try {
    let options = { actor, plan: job.executor.plan };
    if (job.executor.prepare === true) {
      const r = job.executor.request;
      options = { actor, host: r.host, model: r.model, categories: r.categories.join(','),
        levels: (r.levels || [1, 2, 3, 4, 5]).join(','), repeats: String(r.repeats || 1),
        'judge-host': r.judgeHost, 'judge-model': r.judgeModel,
        ...(r.name && { name: r.name }), ...(r.tag && { tag: r.tag }) };
      await assertDispatch();
    }
    return await require('../../scripts/maintenance-benchmark.cjs').ACTIONS[job.executor.prepare === true ? 'benchmark-batch-prepare' : 'benchmark-batch-start']({
      benchmark, http: maintenance.http, receiptsDir: config.receiptsDir,
      options, ActionError: maintenance.ActionError,
      takeLead: purpose => { holder = maintenance.acquireLead(config.leadFile, actor, purpose); },
      beforeDispatch: assertDispatch
    });
  } finally {
    if (holder) maintenance.releaseLead(config.leadFile, holder, `Queue ${job.id}: read native plan and Core receipts for outcome.`);
  }
}
async function runJob(job, client, { actor, benchmark, benchmarkExecutor = benchmarkStart, fetchImpl = fetch }) {
  // All local file/config checks precede the durable dispatch mark.
  if (job.kind === 'benchmark' && benchmarkExecutor === benchmarkStart) {
    if (job.executor.prepare !== true) checkPlan(job);
    require('../../scripts/maintenance-actions.cjs').instance(process.env, { mutating: true });
  }
  const begun = await client(`/${job.id}/begin`, { expectedRevision: job.revision });
  const assertDispatch = () => client(`/${job.id}/assert-dispatch`, { dispatchId: begun.dispatchId });
  let operationId;
  try {
    if (job.kind === 'benchmark') {
      const result = await benchmarkExecutor(begun, { actor, benchmark, assertDispatch });
      if (begun.executor.prepare === true) {
        operationId = result.plan;
        return await client(`/${job.id}/prepared`, { dispatchId: begun.dispatchId, plan: result.plan });
      }
      operationId = result.batchId;
    } else if (job.kind === 'profiler') {
      await assertDispatch();
      const result = await json(`${benchmark}/api/profiler/pipeline/profile-host`, { actor, fetchImpl,
        body: { ...begun.executor, queueRequestId: begun.id }, timeoutMs: 5 * 60000 });
      operationId = result.queueId;
    } else if (job.kind === 'image') {
      await assertDispatch();
      const result = await client.image(begun.executor);
      operationId = result.operation?.id;
    } else throw new Error('No supported executor');
    if (typeof operationId !== 'string' || !operationId) throw new Error('Executor returned no operation identity');
    return await client(`/${job.id}/record`, { dispatchId: begun.dispatchId, state: 'running', operationId });
  } catch (error) {
    if (operationId) {
      try {
        const current = await client(`/${job.id}`);
        if (current.operation?.id === operationId && ['running', 'completed', 'failed', 'cancelled'].includes(current.state)) return current;
      } catch { /* Lost bookkeeping response remains ambiguous. */ }
    }
    // A lost response is never permission to repeat a launch. The pre-effect
    // queue mark survives even when this final write also loses its answer.
    try { await client(`/${job.id}/record`, { dispatchId: begun.dispatchId, state: 'uncertain', reason: String(error.message).slice(0, 1000) }); }
    catch { /* Read the same durable queue identity, never rerun. */ }
    throw Object.assign(new Error(`Queue ${job.id} requires reconciliation: ${error.message}`), { queueId: job.id, outcome: 'uncertain' });
  }
}
async function main(argv = process.argv.slice(2), deps = {}) {
  const { action, options, core } = parse(argv);
  const base = `${core}/api/cluster/schedule/work-queue`;
  const client = (suffix = '', body) => json(base + suffix, { actor: options.actor, body, fetchImpl: deps.fetchImpl });
  client.image = body => json(`${core}/api/images/operations`, { actor: options.actor, body, fetchImpl: deps.fetchImpl, timeoutMs: 5 * 60000 });
  const revision = () => {
    if (!/^\d+$/.test(options.revision || '')) throw new Error('--revision required; read the request first');
    return Number(options.revision);
  };
  if (action === 'list') return client();
  if (action === 'show') return client(`/${options.id}`);
  if (action === 'submit') {
    if (!options.file) throw new Error('--file needs a JSON request');
    return client('', JSON.parse(fs.readFileSync(options.file, 'utf8')));
  }
  if (action === 'migrate') return client('/migrate', { sha256: options.sha256 });
  if (action === 'archive') return client('/archive', {});
  if (action === 'recover') return client(`/${options.id}/recover`, { expectedRevision: revision(), dispatchId: options['dispatch-id'],
    confirmation: options.confirmation, receiptRef: options.receipt });
  if (action === 'reserve') return client(`/${options.id}/reserve`, { expectedRevision: revision(), start: options.start, priority: options.priority === undefined ? 5 : Number(options.priority) });
  if (action === 'cancel') return client(`/${options.id}/cancel`, { expectedRevision: revision() });
  if (action === 'reconcile') return client(`/${options.id}/reconcile`, {});
  const job = await client(`/${options.id}`);
  if (job.revision !== revision()) throw new Error('Request changed; read its current revision');
  return runJob(job, client, { actor: options.actor, benchmark: options.benchmark || `${core}/benchmark`, ...deps });
}
if (require.main === module) main().then(data => {
  process.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + '\n');
}).catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, message: error.message, queueId: error.queueId, outcome: error.outcome }) + '\n');
  process.exitCode = error.outcome === 'uncertain' ? 3 : 1;
});

module.exports = { main, parse, json, runJob, checkPlan };
