/**
 * Maintenance Scheduler Service
 *
 * Idempotent task enqueuer for the maintenance pipeline. Fires on startup
 * and then once per hour. Uses AutomationTask idempotency keys so duplicate
 * calls within the same time window are safe no-ops.
 *
 * Tasks enqueued:
 *   telemetry_aggregate   — every hour  (idempotency: type:YYYY-MM-DDTHH)
 *   maintenance_snapshot  — once/day per repo  (idempotency: type:repoId:YYYY-MM-DD)
 *   maintenance_digest    — once/day   (idempotency: type:YYYY-MM-DD)
 *
 * Env overrides:
 *   MAINTENANCE_SCHEDULER_ENABLED=false  — disable entirely
 *   MAINTENANCE_SCHEDULER_POLL_MS        — override poll interval (default 3600000)
 *
 * Used by: server.js
 */
'use strict';

const logger = require('../../config/logger');
const AutomationTask = require('../../models/AutomationTask');

const HOUR_MS = 60 * 60 * 1000;

// ── Idempotency key helpers ───────────────────────────────────

function utcDateKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function utcHourKey() {
  const d = new Date();
  return `${utcDateKey()}T${String(d.getUTCHours()).padStart(2, '0')}`;
}

// ── Task creation helpers ─────────────────────────────────────

async function enqueueOnce(payload, label) {
  try {
    await AutomationTask.create(payload);
    logger.debug(`[MaintenanceScheduler] Enqueued ${label}`, { key: payload.idempotencyKey });
  } catch (err) {
    if (err?.code === 11000) {
      // Duplicate key — already enqueued this window, no-op
      logger.debug(`[MaintenanceScheduler] Already queued (no-op) ${label}`, { key: payload.idempotencyKey });
    } else {
      logger.error(`[MaintenanceScheduler] Failed to enqueue ${label}`, { error: err.message });
    }
  }
}

// ── Scheduler class ───────────────────────────────────────────

class MaintenanceSchedulerService {
  constructor() {
    this.timer = null;
    this.started = false;
    this.pollMs = parseInt(process.env.MAINTENANCE_SCHEDULER_POLL_MS || String(HOUR_MS), 10);
  }

  /**
   * Start the scheduler. Safe to call multiple times — idempotent.
   * Fires immediately on startup then on each poll interval.
   */
  start() {
    if (this.started) return;
    if (process.env.NODE_ENV === 'test') return;

    const enabled = process.env.MAINTENANCE_SCHEDULER_ENABLED !== 'false';
    if (!enabled) {
      logger.info('[MaintenanceScheduler] Disabled via MAINTENANCE_SCHEDULER_ENABLED=false');
      return;
    }

    this.started = true;

    // Run immediately on startup (catches today's tasks on restart)
    this._tick().catch(err => logger.error('[MaintenanceScheduler] Initial tick failed', { error: err.message }));

    // Then once per hour
    this.timer = setInterval(() => {
      this._tick().catch(err => logger.error('[MaintenanceScheduler] Tick failed', { error: err.message }));
    }, this.pollMs);

    logger.info('[MaintenanceScheduler] Started', { pollMs: this.pollMs });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    logger.info('[MaintenanceScheduler] Stopped');
  }

  // ── Tick: enqueue all maintenance tasks for this hour/day ────

  async _tick() {
    await Promise.all([
      this._enqueueTelemetry(),
      this._enqueueDaily()
    ]);
  }

  /**
   * Enqueue telemetry_aggregate once per UTC hour.
   */
  async _enqueueTelemetry() {
    const hourKey = utcHourKey();
    await enqueueOnce({
      type: 'telemetry_aggregate',
      source: 'schedule',
      status: 'queued',
      priority: 6,         // low priority — background housekeeping
      input: {},
      idempotencyKey: `telemetry_aggregate:${hourKey}`,
      tags: ['maintenance', 'telemetry', 'hourly'],
      constraints: {
        noCloud: true,
        allowCloudFallback: false,
        maxLocalAttempts: 2,
        timeoutMs: 60000
      }
    }, `telemetry_aggregate:${hourKey}`);
  }

  /**
   * Enqueue maintenance_snapshot (per repo) + maintenance_digest once per UTC day.
   */
  async _enqueueDaily() {
    const dateKey = utcDateKey();

    // Load repo list from config — falls back to 'agentx' if missing
    let repoIds = ['agentx'];
    try {
      const profiles = require('../../config/repo-profiles.json');
      if (Array.isArray(profiles.repos) && profiles.repos.length > 0) {
        repoIds = profiles.repos.map(r => r.id);
      }
    } catch (_) {
      // config file missing — use fallback
    }

    // One snapshot per repo
    for (const repoId of repoIds) {
      const key = `maintenance_snapshot:${repoId}:${dateKey}`;
      await enqueueOnce({
        type: 'maintenance_snapshot',
        source: 'schedule',
        status: 'queued',
        priority: 4,
        input: { repoId },
        idempotencyKey: key,
        tags: ['maintenance', 'snapshot', 'daily', repoId],
        constraints: {
          noCloud: true,
          allowCloudFallback: false,
          maxLocalAttempts: 2,
          timeoutMs: 300000     // 5-min timeout for multi-scanner run
        }
      }, key);
    }

    // One digest summarising all repos
    const digestKey = `maintenance_digest:${dateKey}`;
    await enqueueOnce({
      type: 'maintenance_digest',
      source: 'schedule',
      status: 'queued',
      priority: 5,
      input: {},
      idempotencyKey: digestKey,
      tags: ['maintenance', 'digest', 'daily'],
      constraints: {
        noCloud: true,
        allowCloudFallback: false,
        maxLocalAttempts: 2,
        timeoutMs: 180000
      }
    }, digestKey);
  }

  getStatus() {
    return {
      started: this.started,
      pollMs: this.pollMs,
      active: Boolean(this.timer)
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────

let _instance = null;

function getMaintenanceSchedulerService() {
  if (!_instance) _instance = new MaintenanceSchedulerService();
  return _instance;
}

module.exports = { getMaintenanceSchedulerService };
