'use strict';

/**
 * Per-task fallback ladder (#135).
 *
 * A light task may be served by a different model on another host when its
 * configured primary is unavailable before dispatch: the host is not
 * configured or does not answer, a benchmark claim or session hold refuses
 * it, runtime coordination blocks ordinary admission there, an UNKNOWN
 * quarantine fences it, or its pinned model is not wholly in VRAM (#149). The ladder is instance configuration
 * (`AGENTX_TASK_FALLBACKS_JSON`), empty by default, so an instance without it
 * routes exactly as before.
 *
 * Only the tasks in DEGRADABLE_TASKS may have a ladder. A configuration that
 * names any other task is rejected as a whole at startup, with a log naming
 * the offending entry, and no task degrades until it is fixed.
 *
 * A fallback rung faces the same checks as a primary: a claimed, held,
 * quarantined, blocked or unreachable rung is skipped, and the rung model must
 * be installed on its host. Dispatch then runs the usual admission and claim
 * guard on the chosen host, so nothing here bypasses runtime coordination.
 */

const mongoose = require('mongoose');
const { setTimeout: sleep } = require('node:timers/promises');
const logger = require('../../../config/logger');
const { HOSTS, refreshHosts, DEFAULT_TASK_MODELS } = require('../modelRouterDefaults');
const { modelsMatch } = require('../../helpers/modelNameNormalization');

const CONFIG_ENV = 'AGENTX_TASK_FALLBACKS_JSON';
const WAIT_ENV = 'AGENTX_TASK_FALLBACK_WAIT_MS';
const ROUTING_SOURCE = 'task_fallback_ladder';
const DEFAULT_WAIT_MS = 2000;
const MAX_WAIT_MS = 10000;
const WAIT_POLL_MS = 500;
const HEALTH_TTL_MS = 5000;
const MAX_RUNGS = 4;

/** The owner's list (#135). Every other task is strict and never degrades. */
const DEGRADABLE_TASKS = Object.freeze([
  'quick_chat',
  'buddy_reaction',
  'nestor_answer_light',
  'rag_query_expansion',
  'rag_reranking',
  'rag_compression',
  'janitor_ai',
]);

const UNAVAILABLE_REASONS = Object.freeze({
  HOST_UNCONFIGURED: 'host_unconfigured',
  HOST_DOWN: 'host_down',
  HOST_DEGRADED: 'host_gpu_degraded',
  MODEL_MISSING: 'model_missing',
  BENCHMARK_CLAIM: 'benchmark_claim',
  SESSION_HOLD: 'session_hold',
  QUARANTINED: 'quarantined',
  ADMISSION_BLOCKED: 'admission_blocked',
  // The primary is serving another request (the 27B runs one at a time).
  PRIMARY_BUSY: 'primary_busy',
  // The primary passed the probe, then refused before any output was sent.
  DISPATCH_REFUSED: 'dispatch_refused',
  // The target model is pinned there but runs partly or wholly on CPU.
  VRAM_SPILL: 'vram_spill',
});

// Reasons that can clear by themselves within the short wait.
const TRANSIENT_REASONS = new Set([
  UNAVAILABLE_REASONS.BENCHMARK_CLAIM,
  UNAVAILABLE_REASONS.SESSION_HOLD,
  UNAVAILABLE_REASONS.ADMISSION_BLOCKED,
  UNAVAILABLE_REASONS.PRIMARY_BUSY,
]);

// Refusals that happen before a request reaches the model: safe to send to
// the next rung once. Anything after dispatch may have produced output.
const PRE_DISPATCH_REFUSALS = new Set([
  'BENCHMARK_CLAIM_ACTIVE',
  'BENCHMARK_CLAIM_PROOF_INVALID',
  'HOST_SESSION_HOLD_BUSY',
  'RUNTIME_INFERENCE_ADMISSION_DENIED',
  'RUNTIME_INFERENCE_RECOVERY_REQUIRED',
]);

let cached = { raw: undefined, config: null };
const healthCache = new Map();
const stats = { served: {}, byReason: {}, exhausted: 0, lastServedAt: null, lastExhaustedAt: null };

/**
 * Parse and validate a ladder configuration.
 * @returns {{ ladders: Map<string, Array<{model: string, host: string}>>, errors: string[] }}
 */
function parseTaskFallbacks(raw, { hosts = HOSTS } = {}) {
  const ladders = new Map();
  const errors = [];
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ladders, errors };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ladders: new Map(), errors: [`${CONFIG_ENV} is not valid JSON: ${err.message}`] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ladders: new Map(), errors: [`${CONFIG_ENV} must be an object keyed by task type`] };
  }

  for (const [taskType, rungs] of Object.entries(parsed)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_TASK_MODELS, taskType)) {
      errors.push(`unknown task type "${taskType}"`);
      continue;
    }
    if (!DEGRADABLE_TASKS.includes(taskType)) {
      errors.push(`task "${taskType}" is strict and never degrades; remove its fallback list`);
      continue;
    }
    if (!Array.isArray(rungs) || rungs.length === 0 || rungs.length > MAX_RUNGS) {
      errors.push(`task "${taskType}" needs an array of 1 to ${MAX_RUNGS} { model, host } fallbacks`);
      continue;
    }
    const normalized = [];
    rungs.forEach((rung, index) => {
      const model = typeof rung?.model === 'string' ? rung.model.trim() : '';
      const host = typeof rung?.host === 'string' ? rung.host.trim() : '';
      const where = `task "${taskType}" fallback ${index + 1}`;
      if (!model || !host) {
        errors.push(`${where} needs a model and a host`);
      } else if (!Object.prototype.hasOwnProperty.call(hosts, host)) {
        errors.push(`${where} names unknown host "${host}" (use ${Object.keys(hosts).join(', ')})`);
      } else if (!hosts[host]) {
        errors.push(`${where} names host "${host}", which has no configured URL`);
      } else {
        normalized.push(Object.freeze({ model, host }));
      }
    });
    if (normalized.length === rungs.length) ladders.set(taskType, Object.freeze(normalized));
  }

  return errors.length ? { ladders: new Map(), errors } : { ladders, errors };
}

function loadConfig() {
  const raw = process.env[CONFIG_ENV] || '';
  if (cached.raw === raw && cached.config) return cached.config;
  refreshHosts();
  const config = parseTaskFallbacks(raw);
  cached = { raw, config };
  return config;
}

/**
 * Startup check. Logs the accepted ladder, or rejects the whole configuration
 * with one clear error naming every problem.
 */
function validateTaskFallbackConfig({ log = logger } = {}) {
  cached = { raw: undefined, config: null };
  const config = loadConfig();
  if (config.errors.length) {
    log.error(`[TaskFallbackLadder] ${CONFIG_ENV} rejected; no task will degrade until it is fixed`, {
      errors: config.errors,
    });
    return { valid: false, errors: [...config.errors], tasks: [] };
  }
  const tasks = [...config.ladders.keys()];
  if (tasks.length) {
    log.info('[TaskFallbackLadder] fallback ladder configured', {
      tasks: Object.fromEntries([...config.ladders].map(([task, rungs]) => [task, rungs.map(r => `${r.model}@${r.host}`)])),
    });
  }
  return { valid: true, errors: [], tasks };
}

function getTaskFallbackLadder(taskType) {
  return loadConfig().ladders.get(taskType) || [];
}

function waitMs() {
  const raw = process.env[WAIT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_WAIT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(MAX_WAIT_MS, Math.round(parsed)) : DEFAULT_WAIT_MS;
}

function canonical(value) {
  return require('../runtimeCoordinationService')._internal.canonicalHost(value);
}

async function readCoordination() {
  if (mongoose.connection.readyState !== 1) return null;
  return require('../../../models/RuntimeCoordination').findById('runtime').lean();
}

async function assertHostAvailable(hostUrl, model) {
  return require('../benchmarkClaimGuard').assertHostAvailableForConsumer(hostUrl, {
    callerDetail: 'task-fallback-ladder',
    model,
    path: 'task-fallback-ladder',
  });
}

async function checkHostHealth(hostUrl, now = Date.now()) {
  const hit = healthCache.get(hostUrl);
  if (hit && now - hit.checkedAt < HEALTH_TTL_MS) return hit;
  const health = await require('../modelRouter').checkHostHealth(hostUrl);
  const entry = { online: health.status === 'online', models: health.models || [],
    degraded: health.gpuHealth?.status === 'degraded' && health.gpuHealth?.reason === 'fresh_gpu_inventory_empty',
    spilledModels: (health.gpuHealth?.entries || []).filter(item => item.status !== 'unknown' && item.status !== (item.expected || 'full') && item.status),
    checkedAt: now };
  healthCache.set(hostUrl, entry);
  return entry;
}

/** Spilled pins the reconciler recorded for this host: [{ model, size, sizeVram }]. */
async function readPinVramSpill(hostUrl) {
  if (mongoose.connection.readyState !== 1) return [];
  const pref = await require('../../../models/HostPreference')
    .findOne({ hostUrl }).select('pinVramSpill').lean();
  return pref?.pinVramSpill?.models || [];
}

function defaultDeps() {
  return { readCoordination, assertHostAvailable, checkHostHealth, readPinVramSpill, sleep, now: Date.now };
}

/** Read-only view of what ordinary admission would refuse on this host. */
function coordinationBlock(runtime, hostUrl, nowMs, { busyCounts = false } = {}) {
  if (!runtime) return null;
  const host = canonical(hostUrl);
  if (runtime.maintenance) {
    return runtime.maintenance.state === 'UNKNOWN'
      ? UNAVAILABLE_REASONS.QUARANTINED
      : UNAVAILABLE_REASONS.ADMISSION_BLOCKED;
  }
  const inferences = (runtime.inferences || []).filter(item => canonical(item.host) === host);
  if (inferences.some(item => item.state === 'UNKNOWN')) return UNAVAILABLE_REASONS.QUARANTINED;
  const workloads = (runtime.workloads || []).filter(item => (item.hosts || []).some(h => canonical(h) === host));
  if (workloads.some(item => item.recoveryRequired === true || item.recoveryState === 'UNKNOWN')) {
    return UNAVAILABLE_REASONS.QUARANTINED;
  }
  if (inferences.some(item => item.mode === 'exclusive'
    && new Date(item.expiresAt).getTime() > nowMs)) return UNAVAILABLE_REASONS.ADMISSION_BLOCKED;
  if (workloads.some(item => !item.yieldedAt)) return UNAVAILABLE_REASONS.ADMISSION_BLOCKED;
  if (busyCounts && inferences.some(item => item.state === 'ACTIVE'
    && new Date(item.expiresAt).getTime() > nowMs)) return UNAVAILABLE_REASONS.PRIMARY_BUSY;
  return null;
}

/**
 * Probe one { model, host } target before dispatch.
 * `requireModel` verifies the model is installed (fallback rungs only; the
 * primary keeps its existing routing semantics).
 */
async function probeTarget({ model, host, url = null }, deps, { requireModel = false, busyCounts = false } = {}) {
  const hostUrl = url || HOSTS[host] || null;
  if (!hostUrl) return { available: false, reason: UNAVAILABLE_REASONS.HOST_UNCONFIGURED };
  try {
    await deps.assertHostAvailable(hostUrl, model);
  } catch (err) {
    return {
      available: false,
      reason: err?.code === 'BENCHMARK_CLAIM_ACTIVE' || err?.code === 'BENCHMARK_CLAIM_PROOF_INVALID'
        ? UNAVAILABLE_REASONS.BENCHMARK_CLAIM
        : UNAVAILABLE_REASONS.SESSION_HOLD,
    };
  }
  let runtime = null;
  try {
    runtime = await deps.readCoordination();
  } catch (err) {
    logger.debug('[TaskFallbackLadder] coordination read skipped', { error: err.message });
  }
  const blocked = coordinationBlock(runtime, hostUrl, deps.now(), { busyCounts });
  if (blocked) return { available: false, reason: blocked };
  let spilled = [];
  try {
    spilled = (await deps.readPinVramSpill?.(hostUrl)) || [];
  } catch (err) {
    logger.debug('[TaskFallbackLadder] VRAM spill read skipped', { error: err.message });
  }
  if (spilled.some(item => modelsMatch(item.model, model))) {
    return { available: false, reason: UNAVAILABLE_REASONS.VRAM_SPILL };
  }
  const health = await deps.checkHostHealth(hostUrl);
  if (!health.online) return { available: false, reason: UNAVAILABLE_REASONS.HOST_DOWN };
  if (health.spilledModels?.some(item => modelsMatch(item.model, model))) {
    return { available: false, reason: UNAVAILABLE_REASONS.VRAM_SPILL };
  }
  if (health.degraded === true) return { available: false, reason: UNAVAILABLE_REASONS.HOST_DEGRADED };
  if (requireModel && !health.models.some(name => modelsMatch(name, model))) {
    return { available: false, reason: UNAVAILABLE_REASONS.MODEL_MISSING };
  }
  return { available: true, reason: null };
}

async function probePrimary(primary, deps) {
  if (primary.source === 'scheduler-blocked' || primary.recommendation?.blockedByBenchmarkClaim === true) {
    return { available: false, reason: UNAVAILABLE_REASONS.BENCHMARK_CLAIM };
  }
  if (!primary.url) return { available: false, reason: UNAVAILABLE_REASONS.HOST_UNCONFIGURED };
  const target = { model: primary.model, host: primary.host, url: primary.url };
  const deadline = deps.now() + waitMs();
  // Only the primary counts as unavailable while busy; a rung may queue.
  let probe = await probeTarget(target, deps, { busyCounts: true });
  while (!probe.available && TRANSIENT_REASONS.has(probe.reason) && deps.now() + WAIT_POLL_MS <= deadline) {
    await deps.sleep(WAIT_POLL_MS);
    probe = await probeTarget(target, deps, { busyCounts: true });
  }
  return probe;
}

function recordServed(taskType, reason, now) {
  stats.served[taskType] = (stats.served[taskType] || 0) + 1;
  stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
  stats.lastServedAt = new Date(now).toISOString();
}

/** First available rung from `startIndex`, as a degraded recommendation, or null. */
async function selectRung(taskType, base, { fallbackFrom, reason, startIndex = 0, exclude = null }, deps) {
  const ladder = getTaskFallbackLadder(taskType);
  const skipped = [];
  for (let index = startIndex; index < ladder.length; index += 1) {
    const rung = ladder[index];
    if (rung.host === fallbackFrom.host && modelsMatch(rung.model, fallbackFrom.model)) continue;
    if (exclude && HOSTS[rung.host] === exclude.url && modelsMatch(rung.model, exclude.model)) continue;
    const probe = await probeTarget(rung, deps, { requireModel: true });
    if (!probe.available) {
      skipped.push({ model: rung.model, host: rung.host, reason: probe.reason });
      continue;
    }
    const degraded = Object.freeze({
      degraded: true, fallbackFrom, fallbackTo: { model: rung.model, host: rung.host }, reason, rung: index + 1,
    });
    recordServed(taskType, reason, deps.now());
    logger.warn('[TaskFallbackLadder] task served by a fallback model', {
      taskType, from: fallbackFrom, to: degraded.fallbackTo, reason, rung: index + 1, skipped,
    });
    return {
      ...base,
      model: rung.model,
      host: rung.host,
      url: HOSTS[rung.host],
      source: ROUTING_SOURCE,
      reason: `Primary ${fallbackFrom.model} on ${fallbackFrom.host} unavailable (${reason}); degraded to fallback ${index + 1}.`,
      claimId: null,
      claimExpiresAt: null,
      recommendation: null,
      readiness: null,
      degraded,
    };
  }
  stats.exhausted += 1;
  stats.lastExhaustedAt = new Date(deps.now()).toISOString();
  logger.warn('[TaskFallbackLadder] primary unavailable and no fallback is available', {
    taskType, from: fallbackFrom, reason, skipped,
  });
  return null;
}

/**
 * Apply the ladder to a task recommendation. Returns the recommendation
 * unchanged when the task has no ladder, the primary is available, or no rung
 * is available (the caller's usual busy/unavailable handling then applies).
 */
async function applyTaskFallbackLadder(taskType, primary, deps = defaultDeps()) {
  const ladder = getTaskFallbackLadder(taskType);
  if (!ladder.length || !primary) return primary;
  refreshHosts();

  const primaryProbe = await probePrimary(primary, deps);
  if (primaryProbe.available) return primary;
  const fallbackFrom = { model: primary.model || null, host: primary.host || null };
  return await selectRung(taskType, primary, { fallbackFrom, reason: primaryProbe.reason }, deps) || primary;
}

function knownReason(value) {
  return Object.values(UNAVAILABLE_REASONS).includes(value) ? value : null;
}

/** True when a dispatch error proves the request never reached the model. */
function refusedBeforeDispatch(error) {
  const cause = error?.cause && typeof error.cause === 'object' ? error.cause : null;
  return [error, cause].some(item => item && (PRE_DISPATCH_REFUSALS.has(item.code) || item.ollamaRequestNotSent === true));
}

/**
 * The target passed the probe but refused before any output (#135): pick the
 * next rung after it, once. `failed` is { model, host, url, degraded } of the
 * target that refused; the caller must not call this again for the retry.
 */
async function fallbackAfterRefusal(taskType, failed, deps = defaultDeps()) {
  const ladder = getTaskFallbackLadder(taskType);
  if (!ladder.length || !failed?.model) return null;
  refreshHosts();
  const previous = failed.degraded?.degraded === true ? failed.degraded : null;
  const fallbackFrom = previous?.fallbackFrom
    ? { model: previous.fallbackFrom.model || null, host: previous.fallbackFrom.host || null }
    : { model: failed.model, host: failed.host || null };
  const failedIndex = previous ? ladder.findIndex(rung => modelsMatch(rung.model, failed.model)
    && (HOSTS[rung.host] === failed.url || rung.host === failed.host)) : -1;
  return selectRung(taskType, { model: failed.model, host: failed.host, url: failed.url }, {
    fallbackFrom,
    reason: previous?.reason || knownReason(failed.reason) || UNAVAILABLE_REASONS.DISPATCH_REFUSED,
    startIndex: failedIndex + 1,
    exclude: { model: failed.model, url: failed.url },
  }, deps);
}

// An interactive conversation can clear these by asking evaluation work to
// yield (#62), so an exact-model caller tries its primary first for them.
const YIELDABLE_REASONS = new Set([UNAVAILABLE_REASONS.BENCHMARK_CLAIM, UNAVAILABLE_REASONS.ADMISSION_BLOCKED]);

/**
 * Exact-model callers (#143): an OpenClaw conversation names a model, not a
 * task, and borrows the ladder of `taskType`. Before dispatch it degrades only
 * for reasons a yield cannot clear; `afterRefusal` picks a rung once after the
 * primary refused before any output. Returns { model, hostUrl, hostKey,
 * routing } or null (no ladder, primary usable, or no rung available).
 */
async function planExactModelFallback({ model, taskType, afterRefusal = false, refusalReason = null } = {}, deps = defaultDeps()) {
  const requested = String(model || '').trim();
  if (!requested || !DEGRADABLE_TASKS.includes(taskType) || !getTaskFallbackLadder(taskType).length) return null;
  refreshHosts();
  const url = (deps.targetForModel || require('../modelRouterConfig').getTargetForModel)(requested) || null;
  const host = Object.keys(HOSTS).find(key => HOSTS[key] && HOSTS[key] === url) || null;
  const primary = { model: requested, host, url };
  let chosen;
  if (afterRefusal) {
    // The caller's observed cause (e.g. benchmark_claim) names the degradation.
    chosen = await fallbackAfterRefusal(taskType, { ...primary, degraded: null, reason: refusalReason }, deps);
  } else {
    const probe = await probePrimary(primary, deps);
    if (probe.available || YIELDABLE_REASONS.has(probe.reason)) return null;
    chosen = await selectRung(taskType, primary, { fallbackFrom: { model: requested, host }, reason: probe.reason }, deps);
  }
  return chosen ? Object.freeze({
    model: chosen.model, hostUrl: chosen.url, hostKey: chosen.host, routing: publicDegradedMarker(chosen.degraded),
  }) : null;
}

/** The marker surfaces receive: { degraded, fallbackFrom, fallbackTo, reason }. */
function publicDegradedMarker(degraded) {
  if (!degraded || degraded.degraded !== true) return null;
  return {
    degraded: true,
    fallbackFrom: { model: degraded.fallbackFrom?.model || null, host: degraded.fallbackFrom?.host || null },
    fallbackTo: { model: degraded.fallbackTo?.model || null, host: degraded.fallbackTo?.host || null },
    reason: degraded.reason || null,
  };
}

/** Stable telemetry reason code (RouteDecision vocabulary). */
function fallbackReasonCode(degraded) {
  return degraded?.degraded === true && degraded.reason ? `task_fallback_${degraded.reason}` : null;
}

function getTaskFallbackStats() {
  return {
    configuredTasks: [...loadConfig().ladders.keys()],
    configurationErrors: [...loadConfig().errors],
    served: { ...stats.served },
    byReason: { ...stats.byReason },
    exhausted: stats.exhausted,
    lastServedAt: stats.lastServedAt,
    lastExhaustedAt: stats.lastExhaustedAt,
  };
}

function resetForTests() {
  cached = { raw: undefined, config: null };
  healthCache.clear();
  stats.served = {};
  stats.byReason = {};
  stats.exhausted = 0;
  stats.lastServedAt = null;
  stats.lastExhaustedAt = null;
}

module.exports = {
  CONFIG_ENV,
  WAIT_ENV,
  ROUTING_SOURCE,
  DEGRADABLE_TASKS,
  UNAVAILABLE_REASONS,
  parseTaskFallbacks,
  validateTaskFallbackConfig,
  getTaskFallbackLadder,
  applyTaskFallbackLadder,
  fallbackAfterRefusal,
  planExactModelFallback,
  refusedBeforeDispatch,
  publicDegradedMarker,
  fallbackReasonCode,
  getTaskFallbackStats,
  _internal: { coordinationBlock, probeTarget, resetForTests },
};
