'use strict';

/**
 * Persists one native coverage intent, submits its immutable manifest to
 * Core, and follows that same queue identity. Native owners retain all
 * preflight, admission, execution and release authority.
 */

const { randomUUID } = require('node:crypto');
const { findContextProfile } = require('../modelContextProfileService');
const attempts = require('./coverageAttempts');
const queueClient = require('../../clients/coreHeavyQueue');
const { SCORER_VERSION } = require('../scoring/scorerVersion');

const LEVELS = [1, 2, 3, 4, 5];
const CPU_TEST_TIMEOUT_MS = 20 * 60 * 1000;
// Below this context the default answer budget cannot fit beside the prompt.
const SMALL_CONTEXT = 65536;

function baseUrl() {
  return `http://127.0.0.1:${process.env.PORT || 3081}`;
}

async function post(path, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AgentX-Caller': 'benchmark-coverage' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status === 'error') {
    const message = payload.error || payload.message || `HTTP ${response.status}`;
    throw Object.assign(new Error(String(message).slice(0, 300)), {
      statusCode: response.status, code: payload.code || null, launchReceipt: payload.launchReceipt
    });
  }
  return payload.data || payload;
}

/**
 * Execution settings a cell needs to run at all. Answers are produced without
 * thinking, as the catalog campaigns are. A pin wider than the context the
 * Profiler verified runs at the verified context, and a small context gets an
 * answer budget that fits in it.
 */
async function executionConfigFor(cell, deps = {}) {
  const config = { think: false };
  const profile = cell.artifact?.digest
    ? await (deps.findContextProfile || findContextProfile)(cell.model, cell.hostUrl, cell.artifact).catch(() => null)
    : null;
  const verified = Number(profile?.maxVerifiedContext) || 0;
  const pinned = Number(cell.pinContext) || 0;
  if (verified && (!pinned || pinned > verified)) config.force_num_ctx = verified;
  const context = config.force_num_ctx || pinned;
  if (context && context <= SMALL_CONTEXT) config.response_max_tokens = Math.floor(context / 4);
  if (cell.residency === 'cpu') config.per_test_timeout_ms = CPU_TEST_TIMEOUT_MS;
  return config;
}

function runName(cell, promptCount, now = new Date()) {
  return `coverage ${now.toISOString().slice(0, 16)}Z - ${cell.hostName} - ${cell.model} - ${promptCount} prompts`.slice(0, 200);
}

/** No effect can be dispatched before this complete intent is durable. */
async function prepareBite(cell, settings, deps = {}) {
  const id = deps.requestId || randomUUID();
  const at = (deps.now ? deps.now() : new Date()).toISOString();
  const intent = { cell, kind: cell.next, at, scorerVersion: SCORER_VERSION };
  const manifest = { key: `coverage:${id}`, title: `Coverage: ${cell.hostName} / ${cell.model}`.slice(0, 240),
    kind: cell.next === 'profile' ? 'profiler' : 'benchmark', hosts: [cell.hostUrl], estimatedMinutes: 15,
    notBefore: at, startBefore: new Date(Date.parse(at) + 60000).toISOString(),
    source: { type: 'operator', ref: `benchmark-coverage:${id}` } };
  if (cell.next === 'profile') {
    manifest.executor = { hostId: cell.hostId, depth: 'standard', skipRecentDays: 0, modelNames: [cell.model] };
  } else {
    const judge = await (deps.resolveJudge || require('../benchmark/judgeReadiness').resolveReadyJudgeTarget)({});
    if (!judge.ready) throw Object.assign(new Error(judge.error || 'No ready judge'), { code: 'JUDGE_NOT_READY' });
    manifest.hosts = [...new Set([cell.hostUrl, judge.target.host])];
    manifest.executor = { mode: 'coverage', requestId: id };
    const judgeConfig = await (deps.freezeJudgeConfig || require('../benchmark/judgeExecutionContract').freezeJudgeConfig)({
      host: judge.target.host, model: judge.target.model, think: false
    });
    intent.body = {
      requestId: id, targets: [{ host: cell.hostUrl, model: cell.model }], levels: LEVELS,
      prompt_ids: cell.missingPromptIds.slice(0, settings.bitePrompts),
      run_name: runName(cell, Math.min(cell.missingPromptIds.length, settings.bitePrompts), new Date(at)),
      tags: ['coverage', `coverage-${id}`], judge_config: judgeConfig,
      execution_config: await executionConfigFor(cell, deps)
    };
    intent.promptVersions = await require('./coverageQualification').promptVersions(intent.body.prompt_ids, deps.loadCatalogPrompts);
  }
  intent.manifest = manifest;
  return (deps.attempts || attempts).create(id, intent);
}

/** Read the original Core request before any further action. Only Core's
 * terminal result frees the active intent; elapsed time never frees a dispatch. */
async function followBite(attempt, { allowStart = false, ...deps } = {}) {
  const store = deps.attempts || attempts;
  const queue = deps.queue || queueClient;
  let job;
  if (!attempt.queueId) {
    // Submission is immutable and idempotent in Core, including after archive.
    // A lost submission response replays this same key/content, never a launch.
    job = await queue.submitHeavyWork(attempt.intent.manifest);
    attempt = await store.update(attempt._id, { queueId: job.id });
  } else job = await queue.getHeavyWork(attempt.queueId);
  if (['requested', 'reserved'].includes(job.state)) {
    const currentTime = deps.now ? deps.now().getTime() : Date.now();
    if (currentTime >= Date.parse(job.startBefore)) {
      job = await queue.cancelHeavyWork(job.id, job.revision);
    } else if (allowStart) {
      try { await (deps.validateIntent || require('./coverageQualification').validateIntent)(attempt.intent); }
      catch (error) {
        if (error.notStarted !== true) throw error;
        // Only cancel Core's still-unstarted request at its exact revision.
        // A concurrent begin wins its CAS and refuses this cancellation.
        job = await queue.cancelHeavyWork(job.id, job.revision);
      }
      if (job.state === 'cancelled') return followBite(attempt, { ...deps, attempts: store, queue, allowStart: false });
      if (job.state === 'requested') job = await queue.reserveHeavyWork(job.id, {
        expectedRevision: job.revision, start: attempt.intent.at, autoStart: false
      });
      try { job = await queue.runHeavyWork(job.id, job.revision); }
      catch { job = await queue.getHeavyWork(job.id); }
    }
  }
  const terminal = ['completed', 'failed', 'cancelled'].includes(job.state);
  const nativeAttempt = await store.get(attempt._id);
  const result = { requestId: attempt._id, queueId: job.id, kind: attempt.intent.kind,
    id: nativeAttempt?.nativeId || job.releaseReceipt?.nativeId || job.operation?.id || null, state: job.state, terminal,
    notStarted: terminal && (!job.dispatchId || Boolean(job.launchRefusal) || job.releaseReceipt?.refusal?.outcome === 'not-started'),
    error: job.launchRefusal?.reason || job.releaseReceipt?.refusal?.reason || job.reason || null };
  await store.update(attempt._id, { result, ...(terminal ? { active: false } : {}) });
  return result;
}

module.exports = { prepareBite, followBite, executionConfigFor, runName, post };
