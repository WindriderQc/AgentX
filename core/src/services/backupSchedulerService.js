'use strict';

/**
 * Platform backup scheduler.
 *
 * One executor runs one backup cycle (Mongo, config, Qdrant) per occurrence of
 * a cron expression in an IANA time zone. Occurrence state is persisted, so a
 * Core restart never creates an extra cycle and never moves the anchor:
 * - an occurrence already completed is not re-run;
 * - several occurrences missed while Core was down cause exactly one catch-up;
 * - a fresh installation waits for the next occurrence (no startup cycle);
 * - retries stay bounded to retryable layers and lose against the next occurrence;
 * - a state store outage never runs an unguarded cycle: the take and the
 *   completion are re-attempted against the store, never a local fallback.
 */

const os = require('os');
const crypto = require('crypto');
const backupService = require('./backupService');
const logger = require('../../config/logger');
const { describeCadence } = require('./backupEvidenceService');
const {
  RETRYABLE_OCCURRENCE_STATES,
  createCronCalendar,
  createIntervalCalendar,
  newestArtifact,
  normalizeDoc,
  planInterruptedSettlement,
  createMemoryStateStore,
  createMongoStateStore
} = require('./backupSchedulerState');
const {
  DEFAULT_CRON,
  DEFAULT_INTERVAL_MS,
  DEFAULT_STARTUP_DELAY_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  NON_RETRYABLE_CODES,
  OPERATION_NAMES,
  flagEnabled,
  positiveMs,
  configSource,
  isRetryableError,
  iso,
  failuresOf,
  statusOf,
  retryLayersFor,
  buildConfig,
  validateSchedule,
  decideRetry
} = require('./backupSchedulerConfig');

const MAX_TIMER_MS = 2 ** 31 - 1;
const REASONS_LIMIT = 6;
// Re-attempt cadence for a plan or a completion the state store refused.
const STORE_RETRY_MS = 5 * 60 * 1000;
// Re-attempt cadence while a manual cycle occupies the executor.
const BUSY_RETRY_MS = 60 * 1000;

function createBackupScheduler(options = {}) {
  const env = options.env || process.env;
  const service = options.backupService || backupService;
  const log = options.logger || logger;
  const scheduleTimeout = options.setTimeout || setTimeout;
  const cancelTimeout = options.clearTimeout || clearTimeout;
  const now = options.now || (() => new Date());
  const instanceId = options.instanceId || `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

  const config = buildConfig(env);
  const scheduleError = validateSchedule(config);
  const anchorReason = config.anchor === 'cron' ? 'cron' : 'interval';
  const identity = { anchor: config.anchor, cron: config.cron, timezone: config.timezone };
  const cronCalendar = config.anchor === 'cron' && !scheduleError ? createCronCalendar(config.cron, config.timezone) : null;
  const normalEveryMs = cronCalendar ? cronCalendar.normalEveryMs(now()) : config.intervalMs;
  const cadenceLabel = describeCadence({ ...identity, intervalMs: config.intervalMs });

  // The memory store is the backend only when no store is injected at all;
  // a real store that fails is reported, never replaced.
  const store = options.stateStore === undefined
    ? createMongoStateStore()
    : (options.stateStore || createMemoryStateStore());

  let timer = null;
  let running = false;
  let stopped = false;
  let starting = null;
  let firing = null;
  let doc = null;
  let pendingCompletion = null;
  let warnedIntervalIgnored = false;
  const state = {
    startedAt: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastStatus: 'never',
    nextRunAt: null,
    nextRunReason: null,
    consecutiveRetries: 0,
    lastCycleMode: null,
    lastFailures: [],
    results: [],
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastSuccessSource: null,
    occurrence: { dueAt: null, state: 'due', attempts: 0, reason: null },
    reasons: [],
    stateStore: store.kind
  };

  function snapshot() {
    return {
      ...config,
      ...state,
      running,
      scheduleValid: !scheduleError,
      scheduleError: scheduleError ? scheduleError.message : null,
      normalEveryMs,
      cadenceLabel,
      completionPending: Boolean(pendingCompletion),
      lastFailures: state.lastFailures.map(entry => ({ ...entry })),
      results: state.results.map(result => ({ ...result })),
      occurrence: { ...state.occurrence },
      reasons: [...state.reasons]
    };
  }

  // Reasons keep the newest entries; `note` appends, `explain` replaces.
  function explain(...entries) {
    state.reasons = entries.filter(Boolean).slice(-REASONS_LIMIT);
  }

  function note(...entries) {
    explain(...state.reasons, ...entries);
  }

  // ---------- persisted state ----------

  /** Every store call is guarded; a failure is reported, never masked. */
  async function persist(op, args) {
    try {
      const result = await store[op](args);
      state.stateStore = store.kind;
      return { ok: true, result };
    } catch (error) {
      state.stateStore = 'unavailable';
      log.warn('Backup scheduler state store operation failed', { op, error: error.message });
      return { ok: false, error };
    }
  }

  function pendingRetry(occurrence) {
    return Boolean(occurrence?.dueAt
      && RETRYABLE_OCCURRENCE_STATES.includes(occurrence.state)
      && occurrence.retry.nextAt
      && !occurrence.retry.dropped
      && retryLayersFor(occurrence).length > 0
      && occurrence.attempts - 1 < config.maxRetries);
  }

  function applyDoc(loaded) {
    doc = loaded || null;
    const occurrence = doc?.occurrence;
    state.lastAttemptAt = iso(doc?.lastAttemptAt);
    state.lastSuccessAt = iso(doc?.lastSuccessAt);
    state.lastSuccessSource = doc?.lastSuccessSource || null;
    state.occurrence = occurrence?.dueAt
      ? { dueAt: iso(occurrence.dueAt), state: occurrence.state, attempts: occurrence.attempts, reason: occurrence.reason || null }
      : { dueAt: null, state: 'due', attempts: 0, reason: null };
    if (running || !occurrence?.dueAt || occurrence.state === 'due') return;
    // Another executor's cycle in progress is visible through `occurrence`,
    // not as this instance's last cycle status.
    if (occurrence.state === 'running' && occurrence.owner !== instanceId) return;
    state.lastStatus = occurrence.state;
    state.lastStartedAt = iso(occurrence.startedAt);
    state.lastFinishedAt = iso(occurrence.finishedAt);
    state.lastCycleMode = occurrence.cycleMode;
    state.results = occurrence.results.map(result => ({ ...result }));
    state.lastFailures = failuresOf(occurrence.results);
    state.consecutiveRetries = pendingRetry(occurrence) ? occurrence.attempts : 0;
  }

  async function refresh() {
    const loaded = await persist('load');
    if (loaded.ok && loaded.result) applyDoc(loaded.result);
  }

  async function applyResult(result) {
    if (result) applyDoc(result);
    else await refresh();
  }

  // ---------- calendar ----------

  function calendarFor(current) {
    if (cronCalendar) return cronCalendar;
    const occurrence = current?.occurrence;
    if (occurrence?.dueAt) return createIntervalCalendar({ origin: occurrence.dueAt, intervalMs: config.intervalMs, includeOrigin: true });
    const lastSuccessAt = current?.lastSuccessAt;
    if (lastSuccessAt) return createIntervalCalendar({ origin: lastSuccessAt, intervalMs: config.intervalMs, includeOrigin: false });
    return createIntervalCalendar({ origin: state.startedAt ? new Date(state.startedAt) : now(), intervalMs: config.intervalMs, includeOrigin: false });
  }

  // ---------- one cycle ----------

  function operationsFor(names) {
    const all = [
      ['mongo', () => service.createBackup()],
      ['config', () => service.createConfigBackup()],
      ['qdrant', () => service.createQdrantBackup()]
    ];
    if (!Array.isArray(names) || names.length === 0) return all;
    return all.filter(([name]) => names.includes(name));
  }

  /**
   * Run one backup cycle.
   *
   * @param {object} [cycleOptions]
   * @param {string[]} [cycleOptions.only] - restrict the cycle to these
   *   operations (retry path: layers that already succeeded are not recreated).
   * @param {object[]} [cycleOptions.previousResults] - results carried forward
   *   for the layers a retry does not re-run.
   */
  async function runCycle(cycleOptions = {}) {
    if (running) {
      log.warn('Scheduled backup cycle skipped because another cycle is running');
      return { ...snapshot(), status: 'skipped', reason: 'already_running' };
    }

    const only = Array.isArray(cycleOptions.only)
      ? cycleOptions.only.filter(name => OPERATION_NAMES.includes(name))
      : null;
    const isRetry = Boolean(only && only.length > 0 && only.length < OPERATION_NAMES.length);
    const previousResults = isRetry ? (cycleOptions.previousResults || state.results) : [];

    running = true;
    const startedAt = now();
    state.lastStartedAt = startedAt.toISOString();
    state.lastStatus = 'running';
    state.lastCycleMode = isRetry ? 'retry' : 'full';
    state.results = [];

    for (const [name, operation] of operationsFor(isRetry ? only : null)) {
      const layerStartedAt = now();
      try {
        const result = await operation();
        state.results.push({
          name,
          status: 'success',
          durationMs: Math.max(0, now().getTime() - layerStartedAt.getTime()),
          artifact: result?.name || null
        });
      } catch (error) {
        const retryable = isRetryableError(error);
        state.results.push({
          name,
          status: 'error',
          durationMs: Math.max(0, now().getTime() - layerStartedAt.getTime()),
          error: error.message,
          code: error?.code ? String(error.code) : null,
          retryable
        });
        log.error('Scheduled backup operation failed', {
          operation: name,
          error: error.message,
          code: error?.code || null,
          retryable
        });
      }
    }

    if (isRetry) {
      // Carry forward every layer that was not re-run so the cycle status still
      // describes the whole backup set. This deliberately includes a previous
      // non-retryable failure: a successful retry of another layer must not
      // erase an operator-action-required failure from status/evidence.
      const rerun = new Set(state.results.map(result => result.name));
      for (const previous of previousResults) {
        if (!rerun.has(previous.name)) {
          state.results.push({ ...previous, carriedForward: true });
        }
      }
      state.results.sort((a, b) => OPERATION_NAMES.indexOf(a.name) - OPERATION_NAMES.indexOf(b.name));
    }

    const failures = state.results.filter(result => result.status === 'error');
    const successes = state.results.length - failures.length;
    const finishedAt = now();
    state.lastStatus = statusOf(state.results);
    state.lastFinishedAt = finishedAt.toISOString();
    state.lastFailures = failuresOf(state.results);
    running = false;

    const message = 'Scheduled backup cycle completed';
    const meta = { status: state.lastStatus, mode: state.lastCycleMode, successes, failures: failures.length };
    if (failures.length > 0) log.warn(message, meta);
    else log.info(message, meta);

    return {
      status: state.lastStatus,
      mode: state.lastCycleMode,
      results: state.results.map(result => ({ ...result })),
      failures: state.lastFailures.map(entry => ({ ...entry })),
      startedAt,
      finishedAt
    };
  }

  // ---------- timers ----------

  function schedule(delayMs, plan) {
    if (stopped || !config.enabled) return;
    if (timer) cancelTimeout(timer);
    const bounded = Math.min(Math.max(0, delayMs), MAX_TIMER_MS);
    const effective = bounded < delayMs ? { kind: 'replan' } : plan;
    timer = scheduleTimeout(() => {
      firing = fire(effective)
        .catch(error => {
          running = false;
          log.error('Backup scheduler cycle failed unexpectedly', { error: error.message });
          return planFromState(now(), 'after-cycle').catch(planError => {
            log.error('Backup scheduler could not re-plan', { error: planError.message });
          });
        })
        .finally(() => { firing = null; });
      return firing;
    }, bounded);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function rearm(plan, delayMs, reason) {
    state.nextRunAt = new Date(now().getTime() + delayMs).toISOString();
    state.nextRunReason = reason;
    schedule(delayMs, plan);
  }

  function scheduleOccurrence(dueAt, reason, minDelayMs = 0) {
    rearm({ kind: 'occurrence', dueAt, reason }, Math.max(minDelayMs, dueAt.getTime() - now().getTime()), reason);
  }

  function scheduleRetry(retryAt, occurrence) {
    state.consecutiveRetries = occurrence.attempts;
    rearm({
      kind: 'retry',
      dueAt: occurrence.dueAt,
      only: [...occurrence.retry.only],
      expectedAttempts: occurrence.attempts
    }, Math.max(0, retryAt.getTime() - now().getTime()), 'retry');
  }

  function nextOccurrenceReason(occurrence) {
    if (!occurrence?.dueAt || occurrence.state === 'due' || occurrence.state === 'success') return anchorReason;
    if (occurrence.retry.dropped) return 'retry-dropped';
    if (retryLayersFor(occurrence).length === 0) return 'non-retryable-failure';
    if (occurrence.attempts - 1 >= config.maxRetries) return 'retry-exhausted';
    return anchorReason;
  }

  async function dropRetry(occurrence, droppedReason) {
    const settled = await persist('settleOccurrence', {
      dueAt: occurrence.dueAt,
      expectedState: occurrence.state,
      retry: { nextAt: null, dropped: true, droppedReason }
    });
    if (settled.ok) await applyResult(settled.result);
  }

  /**
   * Decide the next timer from the persisted occurrence state. `phase` is
   * 'start' (apply the startup grace before an overdue run) or 'after-cycle'.
   * Nothing is planned while a completion is still unrecorded: the stale
   * state would otherwise look like a missed occurrence.
   */
  async function planFromState(at, phase) {
    if (stopped || pendingCompletion) return;
    const occurrence = doc?.occurrence;
    const calendar = calendarFor(doc);
    const latest = calendar.latestAtOrBefore(at);
    const handledDueAt = occurrence?.dueAt && occurrence.state !== 'due' ? occurrence.dueAt : null;
    const lastSuccessAt = doc?.lastSuccessAt || null;
    const grace = phase === 'start' ? config.startupDelayMs : 0;
    const reasons = [...state.reasons];
    let next = calendar.nextAfter(at);
    if (handledDueAt && handledDueAt.getTime() >= next.getTime()) {
      // The clock is behind the last handled occurrence: skip what is done.
      next = calendar.nextAfter(handledDueAt);
      reasons.push(`Occurrence ${handledDueAt.toISOString()} is already handled although it is not due yet (clock moved backwards); skipping to ${next.toISOString()}.`);
    }
    const nextLabel = `${next.toISOString()} (${cadenceLabel})`;

    if (latest && (!handledDueAt || handledDueAt.getTime() < latest.getTime())) {
      if (lastSuccessAt && lastSuccessAt.getTime() >= latest.getTime()) {
        explain(...reasons, `Occurrence ${latest.toISOString()} is covered by the last successful backup at ${lastSuccessAt.toISOString()}; next run ${nextLabel}.`);
        scheduleOccurrence(next, anchorReason);
        return;
      }
      if (!handledDueAt && !lastSuccessAt) {
        explain(...reasons, `No previous backup state: the first automatic backup runs at the next occurrence ${nextLabel}, not at startup.`);
        scheduleOccurrence(next, anchorReason);
        return;
      }
      if (pendingRetry(occurrence)) {
        await dropRetry(occurrence, `superseded by occurrence ${latest.toISOString()}`);
        reasons.push(`Pending retry for occurrence ${occurrence.dueAt.toISOString()} dropped: occurrence ${latest.toISOString()} is already due and wins.`);
      }
      explain(...reasons, `Occurrence ${latest.toISOString()} was missed (last handled: ${handledDueAt ? handledDueAt.toISOString() : 'none'}); running one catch-up, then resuming the ${config.anchor} anchor.`);
      scheduleOccurrence(latest, 'catch-up', grace);
      return;
    }

    if (pendingRetry(occurrence)) {
      const earliest = new Date(at.getTime() + grace);
      const retryAt = occurrence.retry.nextAt.getTime() > earliest.getTime() ? occurrence.retry.nextAt : earliest;
      const layers = retryLayersFor(occurrence).join(', ');
      if (retryAt.getTime() >= next.getTime()) {
        await dropRetry(occurrence, `retry at ${retryAt.toISOString()} would overlap the next occurrence at ${next.toISOString()}`);
        explain(...reasons, `Retry of ${layers} at ${retryAt.toISOString()} would overlap the next occurrence ${nextLabel}; the next occurrence wins and the retry is dropped.`);
        scheduleOccurrence(next, 'retry-dropped');
        return;
      }
      explain(...reasons, `Retry ${occurrence.attempts} of ${config.maxRetries} for ${layers} at ${retryAt.toISOString()}; the ${config.anchor} anchor is unchanged (next occurrence ${nextLabel}).`);
      scheduleRetry(retryAt, occurrence);
      return;
    }

    explain(...reasons, `Next run ${nextLabel}.`);
    scheduleOccurrence(next, nextOccurrenceReason(occurrence));
  }

  async function fire(plan) {
    timer = null;
    state.nextRunAt = null;
    state.nextRunReason = null;
    if (stopped) return;
    const at = now();
    if (plan.kind === 'replan') return planFromState(at, 'after-cycle');
    if (plan.kind === 'complete') return recordCompletion(plan.completion);
    const planReason = plan.kind === 'retry' ? 'retry' : plan.reason;
    if (running) {
      // A manual cycle is in progress; take the occurrence once it is free.
      rearm(plan, BUSY_RETRY_MS, planReason);
      return;
    }

    let dueAt = plan.dueAt;
    let takeArgs;
    if (plan.kind === 'occurrence') {
      // The latest occurrence at or before now wins over a stale plan (a long
      // timer, or a catch-up that straddled the next occurrence).
      const latest = calendarFor(doc).latestAtOrBefore(at);
      if (latest && latest.getTime() > dueAt.getTime()) dueAt = latest;
      takeArgs = { dueAt, mode: 'new', reason: plan.reason, owner: instanceId, now: at, config: identity };
    } else {
      takeArgs = { dueAt, mode: 'retry', expectedAttempts: plan.expectedAttempts, owner: instanceId, now: at, config: identity };
    }
    const take = await persist('takeOccurrence', takeArgs);
    if (!take.ok) {
      // Not taken: the store must witness every take, so nothing runs now.
      note(`Occurrence ${dueAt.toISOString()} not taken: state store unavailable (${take.error.message}); retrying in ${STORE_RETRY_MS / 60000} min.`);
      rearm(plan, STORE_RETRY_MS, planReason);
      return;
    }
    const taken = take.result;
    if (!taken) {
      log.warn('Backup occurrence was taken by another executor or is no longer eligible', { dueAt: dueAt.toISOString(), kind: plan.kind });
      await refresh();
      note(`Occurrence ${dueAt.toISOString()} was already taken by another executor or is no longer eligible; waiting for the next occurrence.`);
      scheduleOccurrence(calendarFor(doc).nextAfter(now()), anchorReason);
      return;
    }

    applyDoc(taken);
    state.consecutiveRetries = plan.kind === 'retry' ? taken.occurrence.attempts - 1 : 0;
    const cycle = await runCycle(plan.kind === 'retry'
      ? { only: plan.only, previousResults: taken.occurrence.results }
      : {});
    if (cycle.status === 'skipped') return;
    const nextOccurrenceAt = calendarFor({ occurrence: taken.occurrence, lastSuccessAt: doc?.lastSuccessAt }).nextAfter(cycle.finishedAt);
    await recordCompletion({
      dueAt: taken.occurrence.dueAt,
      state: cycle.status,
      cycleMode: cycle.mode,
      attempts: taken.occurrence.attempts,
      results: cycle.results,
      finishedAt: cycle.finishedAt,
      retry: decideRetry({ cycle, occurrence: taken.occurrence, at: cycle.finishedAt, nextOccurrenceAt, config, log })
    });
  }

  /**
   * Record a finished cycle. While the store refuses it, the completion stays
   * in memory and is re-attempted; nothing is re-planned from stale state, and
   * a restart reconciles from artifacts if it never lands.
   */
  async function recordCompletion(completion) {
    const completed = await persist('completeOccurrence', completion);
    if (!completed.ok) {
      if (!pendingCompletion) {
        note(`Occurrence ${completion.dueAt.toISOString()} finished (${completion.state}) but the result is not recorded yet: state store unavailable; retrying every ${STORE_RETRY_MS / 60000} min.`);
      }
      pendingCompletion = completion;
      state.nextRunAt = null;
      state.nextRunReason = null;
      schedule(STORE_RETRY_MS, { kind: 'complete', completion });
      return;
    }
    pendingCompletion = null;
    if (!completed.result) log.warn('Backup occurrence completion was not recorded; the state changed under this executor', { dueAt: completion.dueAt.toISOString() });
    await applyResult(completed.result);
    note(`Occurrence ${completion.dueAt.toISOString()} completed: ${completion.state} (attempt ${completion.attempts}).`);
    await planFromState(now(), 'after-cycle');
  }

  // ---------- start / reconcile ----------

  async function reconcileInterrupted(at) {
    const occurrence = doc?.occurrence;
    if (!occurrence?.dueAt || occurrence.state !== 'running') return;
    const plan = planInterruptedSettlement({
      occurrence,
      at,
      retryAt: new Date(at.getTime() + config.startupDelayMs),
      listBackups: () => service.listBackups(),
      listConfigBackups: typeof service.listConfigBackups === 'function' ? () => service.listConfigBackups() : null
    });
    const settled = await persist('settleOccurrence', { dueAt: occurrence.dueAt, expectedState: 'running', ...plan.settlement });
    note(plan.explanation);
    if (settled.ok) await applyResult(settled.result);
    else note(`The settlement of occurrence ${occurrence.dueAt.toISOString()} is not recorded: state store unavailable.`);
  }

  async function bootstrap() {
    const at = now();
    const reasons = [];
    if (pendingCompletion) {
      const completed = await persist('completeOccurrence', pendingCompletion);
      if (!completed.ok) {
        explain(`Occurrence ${pendingCompletion.dueAt.toISOString()} finished (${pendingCompletion.state}) but its result is still not recorded: state store unavailable; retrying every ${STORE_RETRY_MS / 60000} min.`);
        schedule(STORE_RETRY_MS, { kind: 'complete', completion: pendingCompletion });
        return;
      }
      reasons.push(`Recorded the completion of occurrence ${pendingCompletion.dueAt.toISOString()} kept from the previous run.`);
      pendingCompletion = null;
    }
    const loaded = await persist('load');
    let current = loaded.ok ? loaded.result : null;
    if (!loaded.ok) reasons.push('Scheduler state store unavailable at start.');
    if (!current) {
      const artifact = newestArtifact(() => service.listBackups());
      if (artifact) {
        current = normalizeDoc({ lastSuccessAt: artifact.date, lastSuccessSource: 'artifact' });
        reasons.push(`No persisted scheduler state; last success derived from artifact ${artifact.name} (${artifact.date.toISOString()}).`);
      } else {
        reasons.push('No persisted scheduler state and no artifact; waiting for the next scheduled occurrence.');
      }
    }
    if (stopped) return;
    applyDoc(current);
    explain(...reasons);
    if (config.intervalMsIgnored) {
      note('BACKUP_INTERVAL_MS is ignored while BACKUP_SCHEDULE_CRON anchors the schedule; set BACKUP_SCHEDULE_CRON to an empty string to use the interval.');
    }
    await reconcileInterrupted(at);
    if (stopped) return;
    if (config.anchor === 'interval' && !doc?.occurrence?.dueAt && !doc?.lastSuccessAt) {
      const planned = await persist('planOccurrence', { dueAt: new Date(at.getTime() + config.intervalMs), reason: 'interval', config: identity });
      if (planned.ok && planned.result) applyDoc(planned.result);
    }
    await planFromState(now(), 'start');
  }

  function warnIntervalIgnored() {
    if (!config.intervalMsIgnored || warnedIntervalIgnored) return;
    warnedIntervalIgnored = true;
    log.warn('BACKUP_INTERVAL_MS is set but ignored: BACKUP_SCHEDULE_CRON anchors the backup schedule. Set BACKUP_SCHEDULE_CRON to an empty string to use the interval.', {
      cron: config.cron,
      timezone: config.timezone,
      intervalMs: config.intervalMs
    });
  }

  function start() {
    if (!config.enabled) return false;
    if (scheduleError) {
      state.nextRunAt = null;
      state.nextRunReason = scheduleError.reason;
      explain(scheduleError.message, 'Automatic backups are not scheduled until the configuration is fixed.');
      log.error('Backup scheduler disabled by invalid configuration', { reason: scheduleError.reason, error: scheduleError.message });
      return false;
    }
    // A start after a stop re-arms the scheduler even while the bootstrap or
    // a cycle is still in flight: they re-plan when they finish.
    stopped = false;
    warnIntervalIgnored();
    if (timer || running || starting || firing) return true;
    state.startedAt = state.startedAt || now().toISOString();
    starting = bootstrap()
      .catch(error => {
        log.error('Backup scheduler failed to start', { error: error.message });
        explain(`Scheduler start failed: ${error.message}`);
      })
      .finally(() => { starting = null; });
    log.info('Backup scheduler started', { ...config, cadence: cadenceLabel, instanceId });
    return true;
  }

  function stop() {
    stopped = true;
    if (timer) cancelTimeout(timer);
    timer = null;
    state.nextRunAt = null;
    state.nextRunReason = null;
  }

  async function runNow() {
    const cycle = await runCycle();
    if (cycle.status !== 'skipped') {
      const recorded = await persist('recordManualCycle', {
        attemptedAt: cycle.startedAt,
        succeededAt: cycle.status === 'success' ? cycle.finishedAt : null
      });
      if (recorded.ok && recorded.result) {
        doc = recorded.result;
        state.lastAttemptAt = iso(doc.lastAttemptAt);
        state.lastSuccessAt = iso(doc.lastSuccessAt);
        state.lastSuccessSource = doc.lastSuccessSource || null;
      }
    }
    return snapshot();
  }

  return {
    start,
    stop,
    runNow,
    getStatus: snapshot,
    refresh,
    whenReady: () => starting || firing || Promise.resolve(),
    isEnabled: () => config.enabled
  };
}

// Keep default runtime reads explicit so the feature-conservation manifest can
// track the complete deployment contract.
const defaultScheduler = createBackupScheduler({
  env: {
    BACKUP_SCHEDULE_ENABLED: process.env.BACKUP_SCHEDULE_ENABLED,
    BACKUP_SCHEDULE_CRON: process.env.BACKUP_SCHEDULE_CRON,
    BACKUP_SCHEDULE_TZ: process.env.BACKUP_SCHEDULE_TZ,
    PLANNING_TIME_ZONE: process.env.PLANNING_TIME_ZONE,
    BACKUP_INTERVAL_MS: process.env.BACKUP_INTERVAL_MS,
    BACKUP_STARTUP_DELAY_MS: process.env.BACKUP_STARTUP_DELAY_MS,
    BACKUP_RETRY_DELAY_MS: process.env.BACKUP_RETRY_DELAY_MS,
    BACKUP_MAX_RETRIES: process.env.BACKUP_MAX_RETRIES
  }
});

module.exports = {
  ...defaultScheduler,
  createBackupScheduler,
  flagEnabled,
  positiveMs,
  configSource,
  isRetryableError,
  NON_RETRYABLE_CODES,
  STORE_RETRY_MS,
  DEFAULT_CRON,
  DEFAULT_INTERVAL_MS,
  DEFAULT_STARTUP_DELAY_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_MAX_RETRIES
};
