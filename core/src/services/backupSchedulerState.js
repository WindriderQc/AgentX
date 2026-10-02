'use strict';

/**
 * Backup scheduler state: occurrence calendars and the persisted occurrence
 * store used by backupSchedulerService.
 *
 * - A calendar answers "which occurrence is the latest at or before `at`"
 *   and "which occurrence is the next after `at`" for a cron expression in
 *   an IANA time zone, or for an interval anchored on a known occurrence.
 * - A store persists one singleton occurrence document. The Mongo store is
 *   backed by models/BackupSchedulerState; the memory store has identical
 *   semantics so the scheduler's pure tests need no database.
 */

const { CronExpressionParser } = require('cron-parser');

const OCCURRENCE_STATES = Object.freeze(['due', 'running', 'success', 'partial', 'failed']);
const RETRYABLE_OCCURRENCE_STATES = Object.freeze(['partial', 'failed']);

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cronDate(value) {
  return value.toDate ? value.toDate() : new Date(value);
}

function validateTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return { valid: true, error: null };
  } catch (error) {
    return { valid: false, error: `Invalid time zone "${timeZone}"` };
  }
}

function validateCron(expression, timeZone) {
  const expr = String(expression || '').trim();
  if (!expr) return { valid: false, error: 'Empty cron expression' };
  try {
    const parsed = CronExpressionParser.parse(expr, { currentDate: new Date(), tz: timeZone });
    cronDate(parsed.next());
    return { valid: true, error: null };
  } catch (error) {
    return { valid: false, error: `Invalid cron expression "${expr}": ${error.message}` };
  }
}

/**
 * Cron calendar. Mirrors clusterScheduleService's cron-parser usage. Forward
 * iteration in cron-parser 5.5 skips the occurrences that follow a DST gap on
 * the spring-forward day; backward iteration does not, so `nextAfter` walks
 * back from the forward candidate to make sure no occurrence in (at, candidate)
 * is lost. `latestAtOrBefore` is inclusive of `at`.
 */
function createCronCalendar(expression, timeZone) {
  const expr = String(expression || '').trim();
  const next = at => cronDate(CronExpressionParser.parse(expr, { currentDate: at, tz: timeZone }).next());
  const prev = at => cronDate(CronExpressionParser.parse(expr, { currentDate: at, tz: timeZone }).prev());

  return {
    kind: 'cron',
    expression: expr,
    timeZone,
    nextAfter(at) {
      let candidate = next(at);
      for (let guard = 0; guard < 8; guard += 1) {
        const back = prev(candidate);
        if (!(back > at)) break;
        candidate = back;
      }
      return candidate;
    },
    latestAtOrBefore(at) {
      let cursor = prev(new Date(at.getTime() + 1000));
      if (cursor > at) cursor = prev(cursor);
      return cursor;
    },
    // The usual gap between occurrences: the most frequent of the next five
    // gaps, so a 23 h or 25 h DST day does not become the reported cadence.
    normalEveryMs(at) {
      const counts = new Map();
      let best = 0;
      let previous = this.nextAfter(at);
      for (let step = 0; step < 5; step += 1) {
        const following = this.nextAfter(previous);
        const gap = following.getTime() - previous.getTime();
        const count = (counts.get(gap) || 0) + 1;
        counts.set(gap, count);
        if (count > (counts.get(best) || 0)) best = gap;
        previous = following;
      }
      return Math.max(0, best);
    }
  };
}

/**
 * Interval calendar anchored on `origin`. When `includeOrigin` is true the
 * origin itself is an occurrence (a handled or planned slot); otherwise the
 * first occurrence is one interval after it (origin is a last-success time).
 */
function createIntervalCalendar({ origin, intervalMs, includeOrigin = true }) {
  const base = toDate(origin);
  if (!base || !(intervalMs > 0)) throw new Error('interval calendar requires an origin and a positive interval');
  const firstAt = includeOrigin ? base.getTime() : base.getTime() + intervalMs;
  return {
    kind: 'interval',
    origin: base,
    intervalMs,
    nextAfter(at) {
      const t = at.getTime();
      if (t < firstAt) return new Date(firstAt);
      const steps = Math.floor((t - firstAt) / intervalMs) + 1;
      return new Date(firstAt + steps * intervalMs);
    },
    latestAtOrBefore(at) {
      const t = at.getTime();
      if (t < firstAt) return null;
      const steps = Math.floor((t - firstAt) / intervalMs);
      return new Date(firstAt + steps * intervalMs);
    },
    normalEveryMs() {
      return intervalMs;
    }
  };
}

/**
 * Newest artifact time from backupService.listBackups() (mtime-based `date`).
 * Used when no occurrence state exists and to reconcile an interrupted cycle.
 */
function newestArtifact(listBackups) {
  let newest = null;
  let items = [];
  try {
    items = typeof listBackups === 'function' ? listBackups() : listBackups;
  } catch {
    return null;
  }
  for (const item of Array.isArray(items) ? items : []) {
    const date = toDate(item?.date);
    if (!date) continue;
    if (!newest || date > newest.date) newest = { name: String(item.name || ''), date };
  }
  return newest;
}

const NO_RETRY = Object.freeze({ nextAt: null, only: [], dropped: false, droppedReason: '' });

/**
 * Settlement of an occurrence found `running` at start: the previous process
 * died mid-cycle. Pure; the scheduler persists `settlement` with
 * settleOccurrence and reports `explanation`.
 * - An interrupted retry resumes from the layer results it carried.
 * - A full cycle whose newest artifact falls inside the occurrence window is
 *   reconciled from that artifact; exactly one archive is never promised.
 * - Otherwise the occurrence failed before any artifact and is re-run once.
 */
function planInterruptedSettlement({ occurrence, at, retryAt, listBackups, listConfigBackups }) {
  const dueLabel = occurrence.dueAt.toISOString();
  if (occurrence.cycleMode === 'retry' && occurrence.results.length > 0) {
    const failures = occurrence.results.filter(result => result.status === 'error');
    const state = failures.length === 0 ? 'success' : (failures.length < occurrence.results.length ? 'partial' : 'failed');
    return {
      settlement: {
        state,
        finishedAt: occurrence.finishedAt || at,
        reason: 'interrupted-retry',
        retry: { ...NO_RETRY, nextAt: retryAt, only: failures.filter(result => result.retryable !== false).map(result => result.name) }
      },
      explanation: `Retry for occurrence ${dueLabel} was interrupted by a restart; resuming from the recorded layer results.`
    };
  }

  const windowStart = Math.max(occurrence.dueAt.getTime(), occurrence.startedAt ? occurrence.startedAt.getTime() : 0);
  const inWindow = artifact => Boolean(artifact) && artifact.date.getTime() >= windowStart && artifact.date.getTime() <= at.getTime();
  const artifact = newestArtifact(listBackups);
  if (inWindow(artifact)) {
    const results = [{ name: 'mongo', status: 'success', durationMs: 0, artifact: artifact.name, retryable: true, reconciled: true }];
    const configArtifact = listConfigBackups ? newestArtifact(listConfigBackups) : null;
    if (inWindow(configArtifact)) {
      results.push({ name: 'config', status: 'success', durationMs: 0, artifact: configArtifact.name, retryable: true, reconciled: true });
    }
    return {
      settlement: {
        state: 'success',
        results,
        finishedAt: artifact.date,
        reason: 'reconciled_from_artifact',
        retry: { ...NO_RETRY },
        lastSuccessAt: artifact.date,
        lastSuccessSource: 'reconciled_from_artifact'
      },
      explanation: `Occurrence ${dueLabel} was interrupted after artifact ${artifact.name} was written; reconciled from that artifact (Qdrant outcome for that cycle is not verified).`
    };
  }

  return {
    settlement: {
      state: 'failed',
      results: [],
      finishedAt: at,
      reason: 'interrupted',
      retry: { ...NO_RETRY, nextAt: retryAt }
    },
    explanation: `Occurrence ${dueLabel} was interrupted before any artifact was written; it is re-run once after the startup grace.`
  };
}

function cloneDoc(doc) {
  return doc ? JSON.parse(JSON.stringify(doc)) : null;
}

function normalizeDoc(doc) {
  if (!doc) return null;
  const occurrence = doc.occurrence || {};
  const retry = occurrence.retry || {};
  return {
    version: Number(doc.version) || 0,
    anchor: doc.anchor === 'interval' ? 'interval' : 'cron',
    cron: doc.cron || '',
    timezone: doc.timezone || '',
    occurrence: {
      dueAt: toDate(occurrence.dueAt),
      state: OCCURRENCE_STATES.includes(occurrence.state) ? occurrence.state : 'due',
      reason: occurrence.reason || '',
      attempts: Number(occurrence.attempts) || 0,
      cycleMode: occurrence.cycleMode === 'retry' ? 'retry' : (occurrence.cycleMode === 'full' ? 'full' : null),
      owner: occurrence.owner || '',
      startedAt: toDate(occurrence.startedAt),
      finishedAt: toDate(occurrence.finishedAt),
      results: Array.isArray(occurrence.results) ? occurrence.results.map(result => ({ ...result })) : [],
      retry: {
        nextAt: toDate(retry.nextAt),
        only: Array.isArray(retry.only) ? [...retry.only] : [],
        dropped: retry.dropped === true,
        droppedReason: retry.droppedReason || ''
      }
    },
    lastAttemptAt: toDate(doc.lastAttemptAt),
    lastSuccessAt: toDate(doc.lastSuccessAt),
    lastSuccessSource: doc.lastSuccessSource || null
  };
}

function freshOccurrence({ dueAt, reason, owner, now, state = 'running', attempts = 1, cycleMode = 'full' }) {
  return {
    dueAt,
    state,
    reason: reason || '',
    attempts,
    cycleMode,
    owner: owner || '',
    startedAt: state === 'running' ? now : null,
    finishedAt: null,
    results: [],
    retry: { nextAt: null, only: [], dropped: false, droppedReason: '' }
  };
}

function canTakeNew(doc, dueAt) {
  const current = doc?.occurrence;
  if (!current || !current.dueAt) return true;
  if (current.dueAt.getTime() < dueAt.getTime()) return true;
  return current.dueAt.getTime() === dueAt.getTime() && current.state === 'due';
}

function canTakeRetry(doc, dueAt, expectedAttempts) {
  const current = doc?.occurrence;
  return Boolean(current && current.dueAt && current.dueAt.getTime() === dueAt.getTime()
    && RETRYABLE_OCCURRENCE_STATES.includes(current.state)
    && current.attempts === expectedAttempts
    && !current.retry.dropped);
}

/**
 * In-memory store with the same guarded semantics as the Mongo store. Tests
 * share one instance between two schedulers to simulate two executors.
 */
function createMemoryStateStore(initial = null, options = {}) {
  let doc = normalizeDoc(cloneDoc(initial));
  let unavailable = options.unavailable === true;
  const bump = () => { doc.version += 1; };
  const guard = () => { if (unavailable) throw new Error('backup scheduler state store unavailable'); };

  return {
    kind: 'memory',
    setUnavailable(value) { unavailable = value === true; },
    async load() {
      guard();
      return normalizeDoc(doc);
    },
    async takeOccurrence({ dueAt, mode = 'new', expectedAttempts = 0, reason, owner, now, config = {} }) {
      guard();
      if (mode === 'retry') {
        if (!canTakeRetry(doc, dueAt, expectedAttempts)) return null;
        doc.occurrence.state = 'running';
        doc.occurrence.cycleMode = 'retry';
        doc.occurrence.attempts += 1;
        doc.occurrence.owner = owner || '';
        doc.occurrence.startedAt = now;
        doc.occurrence.finishedAt = null;
        doc.occurrence.retry.nextAt = null;
      } else {
        if (!canTakeNew(doc, dueAt)) return null;
        if (!doc) doc = normalizeDoc({});
        doc.occurrence = freshOccurrence({ dueAt, reason, owner, now });
      }
      Object.assign(doc, { anchor: config.anchor || doc.anchor, cron: config.cron ?? doc.cron, timezone: config.timezone ?? doc.timezone });
      doc.lastAttemptAt = now;
      bump();
      return normalizeDoc(doc);
    },
    async completeOccurrence({ dueAt, state, cycleMode, results, finishedAt, retry, lastSuccessSource = 'recorded' }) {
      guard();
      const current = doc?.occurrence;
      if (!current || !current.dueAt || current.dueAt.getTime() !== dueAt.getTime() || current.state !== 'running') return null;
      current.state = state;
      if (cycleMode) current.cycleMode = cycleMode;
      current.results = (results || []).map(result => ({ ...result }));
      current.finishedAt = finishedAt;
      current.retry = { nextAt: null, only: [], dropped: false, droppedReason: '', ...(retry || {}) };
      if (state === 'success') {
        doc.lastSuccessAt = finishedAt;
        doc.lastSuccessSource = lastSuccessSource;
      }
      bump();
      return normalizeDoc(doc);
    },
    async planOccurrence({ dueAt, reason, config = {} }) {
      guard();
      if (doc?.occurrence?.dueAt) return normalizeDoc(doc);
      if (!doc) doc = normalizeDoc({});
      doc.occurrence = freshOccurrence({ dueAt, reason, now: null, state: 'due', attempts: 0, cycleMode: null });
      Object.assign(doc, { anchor: config.anchor || doc.anchor, cron: config.cron ?? doc.cron, timezone: config.timezone ?? doc.timezone });
      bump();
      return normalizeDoc(doc);
    },
    async settleOccurrence({ dueAt, expectedState, state, results, finishedAt, reason, retry, lastSuccessAt, lastSuccessSource }) {
      guard();
      const current = doc?.occurrence;
      if (!current || !current.dueAt || current.dueAt.getTime() !== dueAt.getTime() || current.state !== expectedState) return null;
      if (state) current.state = state;
      if (results) current.results = results.map(result => ({ ...result }));
      if (finishedAt !== undefined) current.finishedAt = finishedAt;
      if (reason !== undefined) current.reason = reason;
      if (retry) current.retry = { ...current.retry, ...retry };
      if (lastSuccessAt) {
        doc.lastSuccessAt = lastSuccessAt;
        doc.lastSuccessSource = lastSuccessSource || 'recorded';
      }
      bump();
      return normalizeDoc(doc);
    },
    async recordManualCycle({ attemptedAt, succeededAt }) {
      guard();
      if (!doc) doc = normalizeDoc({});
      doc.lastAttemptAt = attemptedAt;
      if (succeededAt) {
        doc.lastSuccessAt = succeededAt;
        doc.lastSuccessSource = 'recorded';
      }
      bump();
      return normalizeDoc(doc);
    },
    peek() {
      return normalizeDoc(doc);
    }
  };
}

/**
 * Mongo store. Every mutation is a guarded findOneAndUpdate so two executors
 * cannot both take the same occurrence: the loser gets `null` back.
 */
function createMongoStateStore(options = {}) {
  const Model = options.model || require('../../models/BackupSchedulerState');
  const id = options.id || Model.BACKUP_SCHEDULER_STATE_ID || 'backup-scheduler';
  const lostRace = error => error && (error.code === 11000 || /E11000/.test(String(error.message)));

  async function guardedUpdate(filter, update, { upsert = false } = {}) {
    try {
      const doc = await Model.findOneAndUpdate(
        { _id: id, ...filter },
        update,
        { new: true, upsert, setDefaultsOnInsert: true, lean: true }
      );
      return normalizeDoc(doc);
    } catch (error) {
      if (upsert && lostRace(error)) return null;
      throw error;
    }
  }

  const occurrenceFilter = (dueAt, states) => ({ 'occurrence.dueAt': dueAt, 'occurrence.state': { $in: states } });

  return {
    kind: 'mongo',
    async load() {
      const doc = await Model.findById(id).lean();
      return normalizeDoc(doc);
    },
    async takeOccurrence({ dueAt, mode = 'new', expectedAttempts = 0, reason, owner, now, config = {} }) {
      const identity = { anchor: config.anchor, cron: config.cron, timezone: config.timezone };
      for (const key of Object.keys(identity)) if (identity[key] === undefined) delete identity[key];
      if (mode === 'retry') {
        return guardedUpdate({
          ...occurrenceFilter(dueAt, RETRYABLE_OCCURRENCE_STATES),
          'occurrence.attempts': expectedAttempts,
          'occurrence.retry.dropped': { $ne: true }
        }, {
          $set: {
            ...identity,
            'occurrence.state': 'running',
            'occurrence.cycleMode': 'retry',
            'occurrence.owner': owner || '',
            'occurrence.startedAt': now,
            'occurrence.finishedAt': null,
            'occurrence.retry.nextAt': null,
            lastAttemptAt: now
          },
          $inc: { version: 1, 'occurrence.attempts': 1 }
        });
      }
      return guardedUpdate({
        $or: [
          { 'occurrence.dueAt': null },
          { 'occurrence.dueAt': { $lt: dueAt } },
          { 'occurrence.dueAt': dueAt, 'occurrence.state': 'due' }
        ]
      }, {
        $set: { ...identity, occurrence: freshOccurrence({ dueAt, reason, owner, now }), lastAttemptAt: now },
        $inc: { version: 1 }
      }, { upsert: true });
    },
    async completeOccurrence({ dueAt, state, cycleMode, results, finishedAt, retry, lastSuccessSource = 'recorded' }) {
      const set = {
        'occurrence.state': state,
        'occurrence.results': results || [],
        'occurrence.finishedAt': finishedAt,
        'occurrence.retry': { nextAt: null, only: [], dropped: false, droppedReason: '', ...(retry || {}) }
      };
      if (cycleMode) set['occurrence.cycleMode'] = cycleMode;
      if (state === 'success') {
        set.lastSuccessAt = finishedAt;
        set.lastSuccessSource = lastSuccessSource;
      }
      return guardedUpdate(occurrenceFilter(dueAt, ['running']), { $set: set, $inc: { version: 1 } });
    },
    async planOccurrence({ dueAt, reason, config = {} }) {
      const identity = { anchor: config.anchor, cron: config.cron, timezone: config.timezone };
      for (const key of Object.keys(identity)) if (identity[key] === undefined) delete identity[key];
      const planned = await guardedUpdate(
        { 'occurrence.dueAt': null },
        { $set: { ...identity, occurrence: freshOccurrence({ dueAt, reason, now: null, state: 'due', attempts: 0, cycleMode: null }) }, $inc: { version: 1 } },
        { upsert: true }
      );
      return planned || this.load();
    },
    async settleOccurrence({ dueAt, expectedState, state, results, finishedAt, reason, retry, lastSuccessAt, lastSuccessSource }) {
      const set = {};
      if (state) set['occurrence.state'] = state;
      if (results) set['occurrence.results'] = results;
      if (finishedAt !== undefined) set['occurrence.finishedAt'] = finishedAt;
      if (reason !== undefined) set['occurrence.reason'] = reason;
      for (const [key, value] of Object.entries(retry || {})) set[`occurrence.retry.${key}`] = value;
      if (lastSuccessAt) {
        set.lastSuccessAt = lastSuccessAt;
        set.lastSuccessSource = lastSuccessSource || 'recorded';
      }
      return guardedUpdate(occurrenceFilter(dueAt, [expectedState]), { $set: set, $inc: { version: 1 } });
    },
    async recordManualCycle({ attemptedAt, succeededAt }) {
      const set = { lastAttemptAt: attemptedAt };
      if (succeededAt) {
        set.lastSuccessAt = succeededAt;
        set.lastSuccessSource = 'recorded';
      }
      return guardedUpdate({}, { $set: set, $inc: { version: 1 } }, { upsert: true });
    }
  };
}

module.exports = {
  OCCURRENCE_STATES,
  RETRYABLE_OCCURRENCE_STATES,
  toDate,
  validateTimeZone,
  validateCron,
  createCronCalendar,
  createIntervalCalendar,
  newestArtifact,
  normalizeDoc,
  planInterruptedSettlement,
  createMemoryStateStore,
  createMongoStateStore
};
