'use strict';

// Benchmark batch actions of ./agentx action (#394): prepare a plan, start
// exactly that plan once, read a batch.
//
//   benchmark-batch-prepare  observes Benchmark and records a plan; starts nothing
//   benchmark-batch-start    names a plan, checks it again, posts it once
//   benchmark-batch-status   reads Benchmark's own batch record
//
// Benchmark decides: registration, readiness, preflight, admission and conflicts
// are its answers, never rebuilt here. A plan is one file under the action
// receipts directory and is also the launch's request identity. A start marks
// the plan dispatched before its single POST and never posts that plan again:
// when the answer is lost, the batch is found by the tag Benchmark stored on
// it, and until it is found the launch stays unknown.

const fs = require('node:fs');
const path = require('node:path');
const { hostUrlKey } = require('../shared/ollamaHostConfig');
const { normalizeModelTag } = require('../shared/modelNames');
const { batchRequest, newPlanRef, planRef, planId, planTag, batchId, describeRequest } = require('../shared/benchmarkBatchPlan.cjs');

const PLAN_CONTRACT = 'agentx.benchmark-batch-plan/v1';
const MAX_PROMPTS = 100; // Benchmark's own limit on prompt_ids
const LAUNCH_TIMEOUT_MS = 5 * 60_000;
// Statuses with which Benchmark's launch route states that it started nothing.
const CONFLICT = [409, 423];
const NOT_ADMITTED = [400, 422, 503];
// These exact Benchmark errors occur before its durable batch insert.
// Other 500 errors can occur after insertion and remain ambiguous.
const PRE_INSERT_REFUSALS = ['WORKLOAD_ADMISSION_REJECTED', 'WORKLOAD_ADMISSION_CONFLICT', 'WORKLOAD_RECOVERY_ARM_REJECTED'];
const OPTIONS = Object.freeze({ host: 'host', model: 'model', categories: 'categories', levels: 'levels', repeats: 'repeats',
  'judge-host': 'judgeHost', 'judge-model': 'judgeModel', name: 'name', tag: 'tag' });

const usage = (ctx, message) => new ctx.ActionError(message, { exitCode: 2 });
const refuse = (ctx, message, details) => new ctx.ActionError(message, { exitCode: 4, outcome: 'refused', details });
const unknown = (ctx, message, details) => new ctx.ActionError(message, { exitCode: 3, outcome: 'unknown', details });

/** The typed request named by command-line options, or null when none is given. */
function cliRequest(ctx, { also = [], judgeRequired = false } = {}) {
  const extra = Object.keys(ctx.options).filter(key => !OPTIONS[key] && !['actor', ...also].includes(key));
  if (extra.length) throw usage(ctx, `Unexpected option: ${extra.map(key => `--${key}`).join(', ')}`);
  const number = value => (/^\d+$/.test(value) ? Number(value) : value);
  const params = {};
  for (const [option, field] of Object.entries(OPTIONS)) {
    const value = ctx.options[option];
    if (value === undefined) continue;
    if (field === 'categories') params[field] = value.split(',').map(item => item.trim());
    else if (field === 'levels') params[field] = value.split(',').map(item => number(item.trim()));
    else params[field] = field === 'repeats' ? number(value) : value;
  }
  if (!Object.keys(params).length) return null;
  try { return batchRequest(params, { judgeRequired }); } catch (error) { throw usage(ctx, error.message); }
}

// --- Plans: one file each, under the action receipts directory -------------------------

function planFile(ctx, id) {
  if (!ctx.receiptsDir) throw usage(ctx, 'Benchmark batch actions need AGENTX_ACTION_RECEIPTS_DIR to keep their plans');
  return path.join(ctx.receiptsDir, 'benchmark-batch', `${id}.json`);
}

function writePlan(ctx, plan) {
  const file = planFile(ctx, planId(plan.ref));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function readPlan(ctx, ref) {
  let id;
  try { id = planId(ref); } catch (error) { throw usage(ctx, error.message); }
  let plan;
  try { plan = JSON.parse(fs.readFileSync(planFile(ctx, id), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw usage(ctx, `No prepared plan ${ref} on this instance; prepare one first`);
    throw error;
  }
  // The reference names the request: another digest is another request, whoever wrote it.
  if (plan.contract !== PLAN_CONTRACT || plan.ref !== ref || planRef(id, plan.request) !== ref) {
    throw usage(ctx, `${ref} does not name the plan prepared under this identity`);
  }
  return plan;
}

// --- What Benchmark says now -----------------------------------------------------------

// Metadata only, before Benchmark's preflight can generate. The fixed tags
// route is read only on an already registered host, never an arbitrary URL.
// Ollama exposes remote_host/remote_model even when a cloud model is aliased.
async function assertLocalModel(ctx, host, model) {
  let response;
  try { response = await ctx.http(`${host}/api/tags`, { timeoutMs: 10_000 }); }
  catch (error) { throw refuse(ctx, `Local model inventory could not be verified: ${error.message}`, { code: 'LOCAL_INVENTORY_UNAVAILABLE' }); }
  const models = response.ok && response.json?.models;
  if (!Array.isArray(models)) throw refuse(ctx, 'Ollama returned no verifiable model inventory', { code: 'LOCAL_INVENTORY_UNAVAILABLE' });
  const entry = models.find(item => normalizeModelTag(item.model || item.name) === normalizeModelTag(model));
  if (!entry) throw refuse(ctx, `${model} is not installed on ${host}`, { code: 'LOCAL_MODEL_NOT_INSTALLED' });
  if (entry.remote_host || entry.remote_model) {
    throw refuse(ctx, `${model} uses remote inference; this action accepts only local models`, { code: 'REMOTE_MODEL_FORBIDDEN' });
  }
}

async function ask(ctx, route, options) {
  const response = await ctx.http(`${ctx.benchmark}${route}`, options);
  if (!response.ok || response.json?.status !== 'success' || !response.json.data) {
    throw new ctx.ActionError(`Benchmark did not answer ${route.split('?')[0]} (HTTP ${response.status})`, { details: { response: response.json || response.text } });
  }
  return response.json.data;
}

/**
 * The launch body and projection for a request, from Benchmark's current
 * answers; refuses with what Benchmark reported when the batch could not start.
 */
async function observe(ctx, request) {
  const readiness = await ask(ctx, '/api/benchmark/judge/readiness');
  const registered = url => (readiness.hosts || []).find(host => hostUrlKey(host.hostUrl) === hostUrlKey(url))?.hostUrl || null;
  const host = registered(request.host);
  if (!host) throw refuse(ctx, `${request.host} is not a registered inference host`, { code: 'HOST_NOT_REGISTERED' });
  const judge = request.judgeHost
    ? { host: registered(request.judgeHost), model: request.judgeModel, source: 'named' }
    : { host: registered(readiness.preferred_target?.host), model: readiness.preferred_target?.model, source: 'default' };
  if (request.judgeHost && !judge.host) throw refuse(ctx, `${request.judgeHost} is not a registered inference host`, { code: 'JUDGE_HOST_NOT_REGISTERED' });
  if (!judge.host || !judge.model) {
    throw refuse(ctx, 'No default judge is ready on a registered host', { code: 'JUDGE_NOT_READY', blockers: readiness.blockers || [] });
  }
  // Validate an implicit judge before preflight, which may probe that model.
  // A configured cloud default must not cause even a preparation to spend.
  try { batchRequest({ ...request, judgeHost: judge.host, judgeModel: judge.model }); }
  catch (error) { throw refuse(ctx, `The selected judge is outside the bounded local contract: ${error.message}`, { code: 'JUDGE_NOT_LOCAL' }); }
  await assertLocalModel(ctx, host, request.model);
  await assertLocalModel(ctx, judge.host, judge.model);

  const library = (await ask(ctx, '/api/benchmark/prompts')).prompts || [];
  const selected = library
    .filter(prompt => request.categories.includes(prompt.category) && request.levels.includes(prompt.level))
    .map(prompt => ({ id: String(prompt._id), category: prompt.category, level: prompt.level }))
    .sort((a, b) => a.level - b.level || a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  const categories = Object.fromEntries(request.categories.map(category => [category, selected.filter(prompt => prompt.category === category).length]));
  const empty = request.categories.filter(category => !categories[category]);
  if (empty.length) throw refuse(ctx, `No prompt at the selected levels for: ${empty.join(', ')}`, { code: 'CATEGORY_WITHOUT_PROMPTS', categories });
  if (selected.length > MAX_PROMPTS) {
    throw refuse(ctx, `${selected.length} prompts exceed the ${MAX_PROMPTS} a batch accepts; narrow the categories or levels`, { code: 'TOO_MANY_PROMPTS', categories });
  }

  const body = {
    host, models: [request.model], levels: [...request.levels], prompt_ids: selected.map(prompt => prompt.id),
    run_name: request.name || `agentx-action ${request.model} ${request.categories.join('+')}`,
    judge_config: { host: judge.host, model: judge.model }, execution_config: { repeats: request.repeats },
    multi_judge: 'off', tags: request.tag ? [request.tag] : [],
  };
  const preflight = await ask(ctx, '/api/benchmark/preflight', { method: 'POST', timeoutMs: 60_000, body: {
    targets: [{ host, model: request.model }], judge_config: body.judge_config, levels: body.levels,
    prompt_ids: body.prompt_ids, execution_config: body.execution_config } });
  if (preflight.ready !== true) {
    const hosts = (preflight.checks?.hosts || []).map(check => ({ host: check.host, model: check.model, ok: check.ok, error: check.error || check.benchmark_blocked_reason || null }));
    const code = preflight.checks?.judge?.ok === false ? 'JUDGE_NOT_READY'
      : hosts.some(check => !check.ok) ? 'EXECUTION_TARGET_NOT_READY' : 'PREFLIGHT_NOT_READY';
    throw refuse(ctx, 'Benchmark preflight does not allow this batch', { code, issues: preflight.issues || [], hosts });
  }
  return { body, judge, warnings: preflight.warnings || [],
    projection: { prompts: selected.length, repeats: request.repeats, tests: selected.length * request.repeats, categories } };
}

// --- Actions ---------------------------------------------------------------------------

async function prepare(ctx) {
  const asked = cliRequest(ctx);
  if (!asked) throw usage(ctx, 'benchmark-batch-prepare needs --host, --model and --categories');
  planFile(ctx, 'unwritten'); // refuses now, before any request, when plans have nowhere to go
  const observed = await observe(ctx, asked);
  // The plan pins the judge it observed, so the start names it and the launch uses it.
  const request = batchRequest({ ...asked, judgeHost: observed.judge.host, judgeModel: observed.judge.model });
  const ref = newPlanRef(request);
  const body = { ...observed.body, tags: [planTag(planId(ref)), ...observed.body.tags] };
  const plan = { contract: PLAN_CONTRACT, ref, preparedAt: new Date().toISOString(), preparedBy: ctx.options.actor,
    request, judgeSource: observed.judge.source, body, projection: observed.projection, launch: null };
  writePlan(ctx, plan);
  return { plan: ref, started: false, request, judgeSource: plan.judgeSource, projection: plan.projection, warnings: observed.warnings,
    launch: body, start: { action: 'benchmark-batch-start', plan: ref, ...request } };
}

const launched = (plan, extra = {}) => ({ plan: plan.ref, batchId: plan.launch.batchId, totalTests: plan.launch.totalTests ?? null,
  request: plan.request, projection: plan.projection, ...extra });

/** The batch Benchmark holds for a dispatched plan, read-only; unknown until one is found. */
async function reconcile(ctx, plan, { reason, response } = {}) {
  const id = planId(plan.ref);
  let batches;
  try {
    batches = (await ask(ctx, `/api/benchmark/batches?tag=${planTag(id)}&limit=5`)).batches;
    if (!Array.isArray(batches)) throw new Error('Benchmark returned no batch list');
  } catch (error) {
    throw unknown(ctx, `${reason || 'This plan was dispatched'} and Benchmark could not be read to reconcile it; run the same start again, it never relaunches`,
      { plan: plan.ref, dispatchedAt: plan.launch.dispatchedAt, lookupError: error.message, response });
  }
  if (batches.length !== 1) {
    throw unknown(ctx, batches.length
      ? `${batches.length} batches carry this plan; an operator must look at them`
      : `${reason || 'This plan was dispatched'} and no batch carries it yet; it is never relaunched. Run the same start again to reconcile it. Do not prepare a replacement launch while this outcome is unknown`,
    { plan: plan.ref, dispatchedAt: plan.launch.dispatchedAt, batches: batches.map(batch => String(batch._id)), response });
  }
  const batch = batches[0];
  if (!/^[0-9a-f]{24}$/.test(String(batch._id)) || !batch.tags?.includes(planTag(id))) {
    throw unknown(ctx, 'Benchmark returned an invalid correlation result; no batch ID is verified',
      { plan: plan.ref, dispatchedAt: plan.launch.dispatchedAt });
  }
  if (plan.launch.responseFailure) {
    plan.launch = { ...plan.launch, batchId: String(batch._id), observedAt: new Date().toISOString() };
    writePlan(ctx, plan);
    throw unknown(ctx, 'Benchmark recorded this batch but the launch returned an error; execution is not confirmed. Read its state and request operator review, never relaunch it',
      { plan: plan.ref, batchId: String(batch._id), batchStatus: batch.status || null, response: plan.launch.responseFailure });
  }
  plan.launch = { ...plan.launch, state: 'launched', batchId: String(batch._id), totalTests: batch.total_tests ?? null, reconciledAt: new Date().toISOString() };
  writePlan(ctx, plan);
  return launched(plan, { recovered: true, batchStatus: batch.status || null });
}

async function start(ctx) {
  if (!ctx.options.plan) throw usage(ctx, 'benchmark-batch-start needs --plan <reference of a prepared plan>');
  let plan = readPlan(ctx, ctx.options.plan);
  const restated = cliRequest(ctx, { also: ['plan'], judgeRequired: true });
  if (restated && planRef(planId(plan.ref), restated) !== plan.ref) {
    throw usage(ctx, 'These parameters are not the ones prepared under this plan; prepare a new plan to change them');
  }
  const replay = () => (plan.launch.state === 'launched' ? launched(plan, { recovered: true }) : reconcile(ctx, plan));
  if (plan.launch) return replay();

  // The lease serializes two starts of one plan: the second finds the first's mark.
  ctx.takeLead(`benchmark-batch-start ${plan.ref} (${describeRequest(plan.request)})`);
  plan = readPlan(ctx, plan.ref);
  if (plan.launch) return replay();
  const observed = await observe(ctx, plan.request);
  const body = { ...observed.body, tags: [planTag(planId(plan.ref)), ...observed.body.tags] };
  if (JSON.stringify(body) !== JSON.stringify(plan.body)) {
    throw refuse(ctx, 'Benchmark no longer resolves this plan to the same launch; prepare a new plan', { code: 'PLAN_STALE', projection: observed.projection });
  }

  plan.launch = { state: 'dispatched', actor: ctx.options.actor, dispatchedAt: new Date().toISOString() };
  writePlan(ctx, plan);
  let response;
  try { response = await ctx.http(`${ctx.benchmark}/api/benchmark/batch`, { method: 'POST', body: plan.body, timeoutMs: LAUNCH_TIMEOUT_MS }); }
  catch (error) { return reconcile(ctx, plan, { reason: `The launch answer was lost (${error.message})` }); }

  const data = response.json?.data;
  if (response.ok && response.json?.status === 'success' && /^[0-9a-f]{24}$/.test(String(data?.batch_id))) {
    plan.launch = { ...plan.launch, state: 'launched', batchId: String(data.batch_id), totalTests: data.total_tests ?? null, launchedAt: new Date().toISOString() };
    writePlan(ctx, plan);
    return launched(plan, { recovered: false, categories: data.plan?.categories || [], judge: plan.body.judge_config, warnings: data.preflight?.warnings || [] });
  }
  const answer = { status: response.status, response: response.json || response.text };
  if (!response.ok || response.json?.status === 'error') {
    plan.launch.responseFailure = answer;
    writePlan(ctx, plan);
  }
  const verdict = response.json?.status !== 'error' ? null
    : CONFLICT.includes(response.status) ? 'conflict'
      : NOT_ADMITTED.includes(response.status) || PRE_INSERT_REFUSALS.includes(response.json.code) ? 'not-admitted' : null;
  if (!verdict) return reconcile(ctx, plan, { reason: `Benchmark answered HTTP ${response.status} without a launch verdict`, response: answer });
  // Benchmark says it started nothing. The plan becomes startable again only once
  // Benchmark also shows no batch carrying it; otherwise the launch stays uncertain.
  const stored = await ask(ctx, `/api/benchmark/batches?tag=${planTag(planId(plan.ref))}&limit=5`).then(list => list.batches, () => null);
  if (Array.isArray(stored) && stored.length) return reconcile(ctx, plan);
  if (Array.isArray(stored) && stored.length === 0) {
    plan.launch = null;
    writePlan(ctx, plan);
  }
  const settled = plan.launch === null;
  throw refuse(ctx, verdict === 'conflict' ? 'Benchmark refused the batch: another batch or a profile holds the host' : 'Benchmark did not admit the batch',
    { verdict, ...answer, plan: plan.ref, planStartable: settled,
      ...(!settled && { note: 'Benchmark could not confirm that no batch carries this plan; run the same start again to reconcile it.' }) });
}

async function status(ctx) {
  const extra = Object.keys(ctx.options).filter(key => key !== 'id' && key !== 'actor');
  if (extra.length) throw usage(ctx, `Unexpected option: ${extra.map(key => `--${key}`).join(', ')}`);
  let id;
  try { id = batchId(ctx.options.id); } catch (error) { throw usage(ctx, `benchmark-batch-status needs --id: ${error.message}`); }
  const response = await ctx.http(`${ctx.benchmark}/api/benchmark/batch/${id}?result_limit=1`, { timeoutMs: 30_000 });
  if (response.status === 404) throw new ctx.ActionError(`Benchmark has no batch ${id}`, { details: { code: 'BATCH_NOT_FOUND' } });
  const batch = response.json?.data;
  if (!response.ok || response.json?.status !== 'success' || !batch) {
    throw new ctx.ActionError(`Benchmark did not return batch ${id} (HTTP ${response.status})`, { details: { response: response.json || response.text } });
  }
  if (String(batch._id) !== id) {
    throw new ctx.ActionError('Benchmark returned a different batch identity; status is unknown', { outcome: 'unknown', exitCode: 3 });
  }
  return {
    batchId: id, runName: batch.run_name ?? null, status: batch.status ?? null, judgeStatus: batch.judge_status ?? null,
    authorityState: batch.authority_state ?? null, failureReason: batch.failure_reason ?? null,
    host: batch.host ?? null, models: batch.models || [], tags: batch.tags || [],
    tests: { planned: batch.total_tests ?? null, completed: batch.completed ?? null, failed: batch.failed ?? null, progress: batch.progress ?? null },
    judging: { total: batch.judge_total ?? null, completed: batch.judge_completed ?? null, failed: batch.judge_failed ?? null },
    startedAt: batch.started_at ?? null, completedAt: batch.completed_at ?? null,
  };
}

const ACTIONS = Object.freeze({ 'benchmark-batch-prepare': prepare, 'benchmark-batch-start': start, 'benchmark-batch-status': status });

module.exports = { ACTIONS, cliRequest };
