'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOGICAL_OPERATIONS_PER_CYCLE = 3;

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const SAFE_NEXT_RUN_REASONS = new Set([
  'cron', 'interval', 'catch-up', 'retry', 'retry-exhausted', 'retry-dropped',
  'non-retryable-failure', 'reconciled_from_artifact', 'invalid-cron', 'invalid-timezone'
]);
const SAFE_OCCURRENCE_STATES = new Set(['due', 'running', 'success', 'partial', 'failed']);
const SAFE_OCCURRENCE_REASONS = new Set([
  'cron', 'interval', 'catch-up', 'reconciled_from_artifact', 'interrupted', 'interrupted-retry'
]);
const SAFE_SUCCESS_SOURCES = new Set(['recorded', 'reconciled_from_artifact', 'artifact']);
const SAFE_CRON = /^[0-9*,/\-A-Za-z ?#LW]{1,120}$/;
const SAFE_TIME_ZONE = /^[A-Za-z0-9_+\-/]{1,80}$/;
const SAFE_REASON_TEXT = /^[^\\]{1,240}$/;
// A schedule error quotes the operator's cron or time zone ("*/5 * * * *",
// "Mars/Olympus"); only URL, backslash, path-like and secret-like text is dropped.
const UNSAFE_SCHEDULE_ERROR = /:\/\/|\\|(?:^|[\s"'])\/|[a-z]:\/|secret|password|credential/i;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const OPERATION_NAMES = ['mongo', 'config', 'qdrant'];

function safeCron(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return SAFE_CRON.test(text) ? text : null;
}

function safeTimeZone(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return SAFE_TIME_ZONE.test(text) ? text : null;
}

function safeScheduleError(value) {
  return typeof value === 'string' && value.trim().length > 0 && !UNSAFE_SCHEDULE_ERROR.test(value)
    ? value.slice(0, 200)
    : null;
}

function safeDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function humanDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return 'an unknown interval';
  const hours = value / (60 * 60 * 1000);
  if (hours >= 48) return `${Math.round((hours / 24) * 10) / 10} d`;
  if (hours >= 1) return `${Math.round(hours * 10) / 10} h`;
  return `${Math.round(value / 6000) / 10} min`;
}

/**
 * Human cadence label built only from already-sanitized parts, e.g.
 * "daily at 03:00 America/Toronto" or "every 24 h after the last successful cycle".
 */
function describeCadence({ anchor, cron, timezone, intervalMs } = {}) {
  if (anchor === 'interval') return `every ${humanDuration(intervalMs)} after the last successful cycle`;
  const expression = safeCron(cron);
  const zone = safeTimeZone(timezone) || 'UTC';
  if (!expression) return 'cadence unavailable';
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expression);
  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7](?:,[0-7])*)$/.exec(expression);
  const clock = match => `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`;
  if (daily) return `daily at ${clock(daily)} ${zone}`;
  if (weekly) return `at ${clock(weekly)} ${zone} on ${weekly[3].split(',').map(day => DAY_NAMES[Number(day)]).join(', ')}`;
  return `cron "${expression}" (${zone})`;
}

function projectOccurrence(value) {
  const occurrence = value && typeof value === 'object' ? value : {};
  const attempts = Number(occurrence.attempts);
  return {
    dueAt: safeDate(occurrence.dueAt),
    state: SAFE_OCCURRENCE_STATES.has(occurrence.state) ? occurrence.state : 'due',
    attempts: Number.isFinite(attempts) && attempts >= 0 ? Math.floor(attempts) : 0,
    reason: SAFE_OCCURRENCE_REASONS.has(occurrence.reason) ? occurrence.reason : null
  };
}

function projectReasons(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(entry => typeof entry === 'string' && SAFE_REASON_TEXT.test(entry) && !/:\/\/|secret|credential|password/i.test(entry))
    .slice(0, 6);
}

function projectFailures(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(entry => entry && OPERATION_NAMES.includes(entry.name))
    .map(entry => ({
      name: entry.name,
      error: typeof entry.error === 'string' ? entry.error.slice(0, 200) : 'unknown error',
      code: typeof entry.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(entry.code) ? entry.code : null,
      retryable: entry.retryable !== false
    }));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function projectBackupPolicy(config = {}, schedule = {}, observedAt = new Date().toISOString()) {
  const retentionDays = Math.floor(finiteNonNegative(config.retentionDays));
  const enabled = schedule.enabled === true;
  const anchor = schedule.anchor === 'interval' ? 'interval' : 'cron';
  const cron = anchor === 'cron' ? safeCron(schedule.cron) : null;
  const timezone = safeTimeZone(schedule.timezone);
  const scheduleValid = schedule.scheduleValid !== false;
  const scheduleError = scheduleValid ? null : safeScheduleError(schedule.scheduleError);
  const configuredIntervalMs = finiteNonNegative(schedule.intervalMs, DAY_MS);
  const intervalMs = finiteNonNegative(schedule.normalEveryMs, configuredIntervalMs) || configuredIntervalMs;
  const retryDelayMs = finiteNonNegative(schedule.retryDelayMs, 60 * 60 * 1000);
  const startupDelayMs = finiteNonNegative(schedule.startupDelayMs, 5 * 60 * 1000);
  const unbounded = retentionDays === 0;
  const scheduling = enabled && scheduleValid;
  const normalCyclesPerDay = scheduling && intervalMs > 0 ? round(DAY_MS / intervalMs) : 0;
  const logicalOperationsPerDay = round(normalCyclesPerDay * LOGICAL_OPERATIONS_PER_CYCLE);
  const reasons = [];
  const warnings = [];
  let level = 'low';

  if (enabled && !scheduleValid) {
    level = 'high';
    reasons.push(`Scheduled creation is enabled but not running: ${scheduleError || 'invalid schedule configuration'}.`);
    warnings.push('No automatic backup will be created until the schedule configuration is fixed.');
  }
  if (unbounded && enabled) {
    level = 'high';
    reasons.push('Scheduled creation is enabled while retention is unbounded.');
    warnings.push('Backups will accumulate until an operator changes retention or explicitly deletes artifacts.');
  } else if (unbounded) {
    level = 'watch';
    reasons.push('Retention is unbounded, but only manual backup creation is currently enabled.');
    warnings.push('Every manually created artifact is retained indefinitely.');
  } else {
    reasons.push(`Recognized current-format artifacts are retained for ${retentionDays} days.`);
  }

  if (scheduling && intervalMs < 60 * 60 * 1000) {
    if (level === 'low') level = 'watch';
    reasons.push('The normal schedule creates backup sets more often than hourly.');
  }
  if (scheduling && retryDelayMs < intervalMs) {
    warnings.push('After a partial or failed cycle, the retry cadence is shorter than the normal cadence.');
  }

  const lastFailures = projectFailures(schedule.lastFailures);
  const nextRunReason = SAFE_NEXT_RUN_REASONS.has(schedule.nextRunReason) ? schedule.nextRunReason : null;
  const blockedLayers = lastFailures.filter(entry => entry.retryable === false);
  if (lastFailures.length > 0 && level === 'low') level = 'watch';
  if (blockedLayers.length > 0) {
    reasons.push(
      `${blockedLayers.map(entry => entry.name).join(', ')} backup${blockedLayers.length > 1 ? 's are' : ' is'} failing with a non-retryable error; automatic retries are suspended for that layer until an operator fixes the configuration.`
    );
    for (const entry of blockedLayers) {
      warnings.push(`${entry.name}: ${entry.error}${entry.code ? ` (${entry.code})` : ''}`);
    }
  } else if (lastFailures.length > 0) {
    warnings.push(
      `Last cycle left ${lastFailures.map(entry => entry.name).join(', ')} without a fresh artifact; only the failed layer${lastFailures.length > 1 ? 's are' : ' is'} retried.`
    );
  }
  if (nextRunReason === 'retry-exhausted') {
    warnings.push('The retry budget for the last failure was exhausted; the scheduler is back on the normal cadence.');
  }
  if (nextRunReason === 'retry-dropped') {
    warnings.push('The pending retry was dropped because it would have overlapped the next scheduled occurrence; the next occurrence wins.');
  }
  if (nextRunReason === 'catch-up') {
    reasons.push('At least one scheduled occurrence was missed while Core was down; exactly one catch-up cycle runs before the cron anchor resumes.');
  }
  warnings.push('Legacy uncompressed MongoDB backup directories are listed but excluded from automatic retention pruning.');

  return {
    authority: 'core.backup-policy',
    observedAt,
    schedule: {
      enabled,
      enabledSource: schedule.enabledSource || 'unknown',
      anchor,
      cron,
      cronSource: schedule.cronSource || 'unknown',
      timezone,
      timezoneSource: schedule.timezoneSource || 'unknown',
      cadence: {
        anchor,
        cron,
        timezone,
        label: describeCadence({ anchor, cron, timezone, intervalMs: configuredIntervalMs })
      },
      scheduleValid,
      scheduleError,
      normalEveryMs: intervalMs,
      normalEverySource: anchor === 'cron' ? (schedule.cronSource || 'unknown') : (schedule.intervalMsSource || 'unknown'),
      failureRetryEveryMs: retryDelayMs,
      failureRetrySource: schedule.retryDelayMsSource || 'unknown',
      startupDelayMs,
      startupDelaySource: schedule.startupDelayMsSource || 'unknown',
      nextRunAt: schedule.nextRunAt || null,
      lastStartedAt: schedule.lastStartedAt || null,
      lastFinishedAt: schedule.lastFinishedAt || null,
      lastAttemptAt: safeDate(schedule.lastAttemptAt),
      lastSuccessAt: safeDate(schedule.lastSuccessAt),
      lastSuccessSource: SAFE_SUCCESS_SOURCES.has(schedule.lastSuccessSource) ? schedule.lastSuccessSource : null,
      lastStatus: schedule.lastStatus || 'never',
      lastCycleMode: schedule.lastCycleMode === 'retry' ? 'retry' : (schedule.lastCycleMode === 'full' ? 'full' : null),
      lastFailures,
      nextRunReason,
      occurrence: projectOccurrence(schedule.occurrence),
      reasons: projectReasons(schedule.reasons),
      consecutiveRetries: Math.floor(finiteNonNegative(schedule.consecutiveRetries)),
      maxRetries: Math.floor(finiteNonNegative(schedule.maxRetries, 3)),
      maxRetriesSource: schedule.maxRetriesSource || 'unknown',
      logicalOperationsPerCycle: LOGICAL_OPERATIONS_PER_CYCLE,
      operationNames: ['mongo', 'config', 'qdrant'],
      normalCyclesPerDay,
      logicalOperationsPerDay,
      note: 'Qdrant can also retain a local copy of its server-side snapshot.'
    },
    retention: {
      days: retentionDays,
      source: config.retentionDaysSource || 'unknown',
      mode: unbounded ? 'unbounded' : 'bounded',
      automaticCleanup: !unbounded,
      enforcement: unbounded ? 'disabled' : 'after each successful backup operation',
      coveredArtifacts: [
        'current MongoDB tarballs',
        'configuration tarballs',
        'local Qdrant snapshot copies',
        'Qdrant server snapshots (best effort)'
      ],
      excludedArtifacts: ['legacy uncompressed MongoDB backup directories']
    },
    growthRisk: {
      level,
      reasons,
      warnings
    }
  };
}

function summarizeInventory(items, options = {}, observedAt = new Date().toISOString()) {
  const records = Array.isArray(items) ? items : [];
  const dateField = options.dateField || 'date';
  let knownSizeCount = 0;
  let totalKnownBytes = 0;
  const dates = [];

  for (const record of records) {
    const rawSize = record?.size;
    if (rawSize !== null && rawSize !== undefined && rawSize !== '') {
      const size = Number(rawSize);
      if (Number.isFinite(size) && size >= 0) {
        knownSizeCount += 1;
        totalKnownBytes += size;
      }
    }
    const rawDate = record?.[dateField];
    if (rawDate !== null && rawDate !== undefined && rawDate !== '') {
      const timestamp = new Date(rawDate).getTime();
      if (Number.isFinite(timestamp)) dates.push(timestamp);
    }
  }

  dates.sort((a, b) => a - b);
  return {
    authority: options.authority || 'core.backup-inventory',
    source: options.source || 'unknown',
    scope: options.scope || 'Complete recognized inventory returned by the backing store',
    countBasis: 'All recognized records returned by the source; no date window or pagination',
    count: records.length,
    knownSizeCount,
    totalKnownBytes,
    oldestAt: dates.length ? new Date(dates[0]).toISOString() : null,
    newestAt: dates.length ? new Date(dates[dates.length - 1]).toISOString() : null,
    observedAt
  };
}

module.exports = {
  DAY_MS,
  LOGICAL_OPERATIONS_PER_CYCLE,
  SAFE_NEXT_RUN_REASONS,
  describeCadence,
  projectBackupPolicy,
  projectFailures,
  projectOccurrence,
  projectReasons,
  safeCron,
  safeScheduleError,
  safeTimeZone,
  summarizeInventory
};
