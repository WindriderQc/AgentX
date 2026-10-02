'use strict';

/**
 * Backup scheduler configuration and cycle-result helpers, kept apart from
 * the scheduler so backupSchedulerService.js stays focused on scheduling.
 */

const { defaultPlanningTimeZone } = require('./planningDateService');
const { RETRYABLE_OCCURRENCE_STATES, validateTimeZone, validateCron } = require('./backupSchedulerState');

const DEFAULT_CRON = '0 3 * * *';
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;

// Failures that cannot heal by themselves: retrying them only recreates the
// artifacts of the layers that already succeeded. They wait for the normal
// cadence (and an operator) instead of the short retry loop.
const NON_RETRYABLE_CODES = Object.freeze([
  'RECOVERY_AUTH_REQUIRED',
  'INVALID_CONFIG',
  'CONFIG_MISSING'
]);

const OPERATION_NAMES = Object.freeze(['mongo', 'config', 'qdrant']);

function flagEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function positiveMs(value, fallback, minimum = 1000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function configSource(value) {
  return value === undefined || value === null || String(value).trim() === '' ? 'default' : 'env';
}

function isRetryableError(error) {
  const code = String(error?.code || '').trim();
  return !NON_RETRYABLE_CODES.includes(code);
}

function iso(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
}

function failuresOf(results) {
  return (results || []).filter(result => result.status === 'error').map(result => ({
    name: result.name,
    error: result.error,
    code: result.code || null,
    retryable: result.retryable !== false
  }));
}

function statusOf(results) {
  const failures = (results || []).filter(result => result.status === 'error').length;
  if (failures === 0) return 'success';
  return failures < (results || []).length ? 'partial' : 'failed';
}

function retryableLayers(results) {
  return (results || []).filter(result => result.status === 'error' && result.retryable !== false).map(result => result.name);
}

// An occurrence interrupted before any layer result was recorded re-runs every
// layer; otherwise only the retryable failed layers are retried.
function retryLayersFor(occurrence) {
  if (!occurrence?.dueAt || !RETRYABLE_OCCURRENCE_STATES.includes(occurrence.state)) return [];
  return occurrence.results.length === 0 ? [...OPERATION_NAMES] : retryableLayers(occurrence.results);
}

/**
 * BACKUP_SCHEDULE_CRON unset → default daily cron; explicitly empty → the
 * interval anchor (BACKUP_INTERVAL_MS after the last successful occurrence).
 */
function buildConfig(env) {
  const cronRaw = env.BACKUP_SCHEDULE_CRON;
  const cronExplicitlyEmpty = cronRaw !== undefined && cronRaw !== null && String(cronRaw).trim() === '';
  const anchor = cronExplicitlyEmpty ? 'interval' : 'cron';
  const timezoneRaw = String(env.BACKUP_SCHEDULE_TZ || '').trim();
  const timezone = timezoneRaw || defaultPlanningTimeZone(env);
  return Object.freeze({
    enabled: flagEnabled(env.BACKUP_SCHEDULE_ENABLED),
    enabledSource: configSource(env.BACKUP_SCHEDULE_ENABLED),
    anchor,
    cron: anchor === 'cron' ? (String(cronRaw || '').trim() || DEFAULT_CRON) : '',
    cronSource: cronExplicitlyEmpty ? 'env' : configSource(cronRaw),
    timezone,
    timezoneSource: timezoneRaw || String(env.PLANNING_TIME_ZONE || '').trim() ? 'env' : 'default',
    intervalMs: positiveMs(env.BACKUP_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    intervalMsSource: configSource(env.BACKUP_INTERVAL_MS),
    // The interval only anchors the schedule when the cron is explicitly empty.
    intervalMsIgnored: anchor === 'cron' && configSource(env.BACKUP_INTERVAL_MS) === 'env',
    startupDelayMs: positiveMs(env.BACKUP_STARTUP_DELAY_MS, DEFAULT_STARTUP_DELAY_MS, 0),
    startupDelayMsSource: configSource(env.BACKUP_STARTUP_DELAY_MS),
    retryDelayMs: positiveMs(env.BACKUP_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
    retryDelayMsSource: configSource(env.BACKUP_RETRY_DELAY_MS),
    maxRetries: nonNegativeInt(env.BACKUP_MAX_RETRIES, DEFAULT_MAX_RETRIES),
    maxRetriesSource: configSource(env.BACKUP_MAX_RETRIES)
  });
}

/** Returns null when the schedule is usable, else { reason, message }. */
function validateSchedule(config) {
  const zone = validateTimeZone(config.timezone);
  if (!zone.valid) return { reason: 'invalid-timezone', message: zone.error };
  if (config.anchor !== 'cron') return null;
  const cron = validateCron(config.cron, config.timezone);
  return cron.valid ? null : { reason: 'invalid-cron', message: cron.error };
}

const NO_RETRY = Object.freeze({ nextAt: null, only: [], dropped: false, droppedReason: '' });

/**
 * Retry decision recorded with a completed occurrence. A retry only re-runs
 * retryable layers, stays within maxRetries, never moves the anchor and loses
 * against the next occurrence.
 */
function decideRetry({ cycle, occurrence, at, nextOccurrenceAt, config, log }) {
  if (cycle.status === 'success') return { ...NO_RETRY };
  const layers = retryableLayers(cycle.results);
  if (layers.length === 0) {
    log.warn('Backup failure is not retryable; waiting for the normal cadence and an operator', { failures: cycle.failures });
    return { ...NO_RETRY };
  }
  if (occurrence.attempts - 1 >= config.maxRetries) {
    log.warn('Backup retry budget exhausted; waiting for the normal cadence', {
      attempts: occurrence.attempts,
      maxRetries: config.maxRetries,
      failures: cycle.failures
    });
    return { ...NO_RETRY };
  }
  const retryAt = new Date(at.getTime() + config.retryDelayMs);
  if (nextOccurrenceAt && retryAt.getTime() >= nextOccurrenceAt.getTime()) {
    return {
      nextAt: null,
      only: layers,
      dropped: true,
      droppedReason: `retry at ${retryAt.toISOString()} would overlap the next occurrence at ${nextOccurrenceAt.toISOString()}`
    };
  }
  return { nextAt: retryAt, only: layers, dropped: false, droppedReason: '' };
}

module.exports = {
  DEFAULT_CRON,
  DEFAULT_INTERVAL_MS,
  DEFAULT_STARTUP_DELAY_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  NON_RETRYABLE_CODES,
  OPERATION_NAMES,
  flagEnabled,
  positiveMs,
  nonNegativeInt,
  configSource,
  isRetryableError,
  iso,
  failuresOf,
  statusOf,
  retryableLayers,
  retryLayersFor,
  buildConfig,
  validateSchedule,
  decideRetry
};
