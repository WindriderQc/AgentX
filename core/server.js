/**
 * @file server.js
 * @description AgentX Core — main server entry point
 * @service core
 */
require('dotenv').config();
const connectDB = require('./config/db');
const logger = require('./config/logger');
const { app } = require('./src/app');
const systemHealth = require('./src/systemHealth');
const { normalizeHostUrl } = require('./src/helpers/ollamaHostConfig');
const { flagEnabled, startSingletonDaemon } = require('./src/services/leaderLeaseService');
const { currentAgentXProfile, isDemoProfile } = require('../shared/agentxRuntimeProfile');
const { createServerShutdown } = require('./src/serverShutdown');
const { drainRuntimeOperations } = require('./src/services/pendingRuntimeOperations');

const PORT = process.env.PORT || 3080;
const HOST = process.env.HOST || '127.0.0.1';
const OLLAMA_HOST = normalizeHostUrl(process.env.OLLAMA_HOST);
const AGENTX_PROFILE = currentAgentXProfile();
const DEMO_RUNTIME = isDemoProfile(AGENTX_PROFILE);
if (!OLLAMA_HOST) {
  logger.warn('OLLAMA_HOST not defined in environment variables. Some features may be disabled.');
} else if (String(process.env.OLLAMA_HOST || '').includes('0.0.0.0')) {
  logger.warn('OLLAMA_HOST used a wildcard bind address; normalized to loopback for client requests.', {
    configured: process.env.OLLAMA_HOST,
    effective: OLLAMA_HOST
  });
}

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason?.message || reason,
    stack: reason?.stack,
    promise: promise
  });
});

process.on('uncaughtException', (error) => {
  // EPIPE = closed pipe/socket, ECONNRESET = abrupt client disconnect — both harmless, do not crash.
  if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
    logger.debug(`${error.code} ignored (closed connection)`);
    return;
  }
  logger.error('Uncaught Exception', {
    message: error.message,
    stack: error.stack
  });
  // Give time for logs to flush, then exit
  setTimeout(() => process.exit(1), 1000);
});

// Prevent EPIPE on stdout/stderr from crashing the process (closed log pipes)
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

// Health Check Functions
async function checkMongoHealth() {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.admin().ping();
      return { healthy: true, message: 'Connected' };
    }
    return { healthy: false, message: 'Not connected' };
  } catch (err) {
    return { healthy: false, message: err.message };
  }
}

async function checkOllamaHealth() {
  try {
    const fetch = require('node-fetch');
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, {
      method: 'GET',
      timeout: 2000
    });

    if (response.ok) {
      return { healthy: true, message: 'Connected' };
    }
    return { healthy: false, message: `HTTP ${response.status}` };
  } catch (err) {
    return { healthy: false, message: err.message };
  }
}

const singletonDaemonControllers = [];
const startupWork = [];
let startupPromise;
let httpServer;
let healthRefreshTimer;
const shutdown = createServerShutdown({
  logger,
  stop: async () => {
    clearInterval(healthRefreshTimer);
    const results = await Promise.allSettled(singletonDaemonControllers.map(async controller => controller.stop()));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Daemon shutdown failed');
  },
  close: () => new Promise((resolve, reject) => {
    if (!httpServer) return resolve();
    httpServer.close(error => error ? reject(error) : resolve());
  }),
  drain: async () => {
    await startupPromise;
    await Promise.all(startupWork);
    await drainRuntimeOperations();
  },
  flush: () => require('./src/middleware/performanceTracker').stop(),
  disconnect: () => {
    // Registered work is drained; sockets still open belong to departed callers.
    require('./src/helpers/httpAgent').destroyOutboundSockets();
    return require('mongoose').disconnect();
  }
});
process.on('SIGTERM', () => { shutdown.run('SIGTERM'); });
process.on('SIGINT', () => { shutdown.run('SIGINT'); });

async function startCoreSingletonDaemon({ name, label, start, stop }) {
  if (shutdown.stopping) return;
  const leaderLeaseEnabled = flagEnabled(process.env.CORE_LEADER_LEASE_ENABLED);
  const mongoose = leaderLeaseEnabled ? require('mongoose') : null;
  const controller = await startSingletonDaemon({
    name,
    db: mongoose?.connection?.db,
    enabled: leaderLeaseEnabled,
    start,
    stop,
    logger
  });

  if (shutdown.stopping) await controller.stop();
  else singletonDaemonControllers.push(controller);
  if (controller.mode === 'leader-lease' && !controller.isLeader) {
    console.log(`   ⓘ ${label}: Standby (leader lease held elsewhere)`);
  }
  return controller;
}

// Health Check - Detailed
app.get('/health/detailed', async (_req, res) => {
  // Refresh checks
  const mongoStatus = await checkMongoHealth();
  const ollamaStatus = await checkOllamaHealth();

  const health = {
    status: mongoStatus.healthy ? 'healthy' : 'degraded',
    profile: AGENTX_PROFILE,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {
      mongodb: {
        status: mongoStatus.healthy ? 'connected' : 'error',
        message: mongoStatus.message,
        lastCheck: new Date().toISOString()
      },
      ollama: {
        status: ollamaStatus.healthy ? 'connected' : 'error',
        required: false,
        message: ollamaStatus.message,
        host: OLLAMA_HOST,
        lastCheck: new Date().toISOString()
      }
    },
    system: {
      nodeVersion: process.version,
      platform: process.platform,
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
      }
    }
  };

  const statusCode = mongoStatus.healthy ? 200 : 503;
  res.status(statusCode).json(health);
});


// Startup initialization - perform health checks before starting server
async function startServer() {
  const packageJson = require('./package.json');
  console.log(`\n╔════════════════════════════════════════════════════════╗`);
  console.log(`║                   Agent X Core v${packageJson.version}                  ║`);
  console.log(`╚════════════════════════════════════════════════════════╝\n`);
  console.log(`🔍 Checking system dependencies...\n`);

  // Check MongoDB
  try {
    await connectDB();
    // Resume only previously requested erasures after an interrupted shutdown.
    try { await require('./src/services/surfaceConversationService').resumeDeletedSessionCleanup(); }
    catch { logger.warn('Pending attachment erasure remains hidden and will be retried at the next start.'); }
    systemHealth.mongodb = { status: 'connected', lastCheck: new Date().toISOString(), error: null };
    console.log(`   ✓ MongoDB:  Connected`);
    logger.info('MongoDB connected successfully');

    // Seed default data
    try {
      const seedDefaultData = require('./src/helpers/initDb');
      await seedDefaultData();
    } catch (seedErr) {
      logger.warn('Failed to seed default data', { error: seedErr.message });
    }

    // Registered inference hosts join the env bootstrap before routing loads.
    try {
      const hostCount = await require('./src/services/inferenceHostRegistry').load();
      if (hostCount > 0) console.log(`   ✓ Hosts:    ${hostCount} registered inference host(s)`);
    } catch (hostErr) {
      logger.warn('Inference host registry load failed (env hosts only)', { error: hostErr.message });
    }

    // Load dynamic routing overrides from MongoDB
    try {
      const { ensureTaskModelOverridesLoaded } = require('./src/services/modelRouterConfig');
      const overrides = await ensureTaskModelOverridesLoaded({ force: true });
      const count = Object.keys(overrides).length;
      if (count > 0) {
        console.log(`   ✓ Routing:  ${count} task override(s) loaded from DB`);
      } else {
        console.log(`   ✓ Routing:  Using static defaults`);
      }
    } catch (routeErr) {
      logger.warn('Dynamic routing load failed (using static defaults)', { error: routeErr.message });
    }
    const fallbackLadder = require('./src/services/routing/taskFallbackLadder').validateTaskFallbackConfig();
    if (!fallbackLadder.valid) console.log('   ✗ Routing:  fallback ladder rejected (see log)');
    else if (fallbackLadder.tasks.length) console.log(`   ✓ Routing:  fallback ladder for ${fallbackLadder.tasks.join(', ')}`);
    const envStatus = require('../shared/envStatus');
    logger.info(envStatus.summarizeForLog(envStatus.buildEnvStatus({ service: 'core' })));

    // Sync model registry from Ollama hosts
    try {
      const { syncAllHosts } = require('./src/services/modelSync/syncOrchestrator');
      const syncResult = await syncAllHosts();
      const syncParts = [];
      if (syncResult.created) syncParts.push(`${syncResult.created} new`);
      if (syncResult.updated) syncParts.push(`${syncResult.updated} updated`);
      if (syncResult.retired) syncParts.push(`${syncResult.retired} retired`);
      if (syncParts.length > 0) {
        console.log(`   ✓ Registry: Synced ${syncParts.join(', ')}`);
      } else {
        console.log(`   ✓ Registry: ${syncResult.unchanged} models up to date`);
      }
    } catch (syncErr) {
      logger.warn('Model registry sync failed (non-fatal)', { error: syncErr.message });
    }

  } catch (err) {
    systemHealth.mongodb = { status: 'error', lastCheck: new Date().toISOString(), error: err.message };
    console.log(`   ✗ MongoDB:  ${err.message}`);
    logger.warn('Starting without database connection - some features will be limited', { error: err.message });
  }

  if (shutdown.stopping) return;

  // Check Ollama
  try {
    const ollamaResult = await checkOllamaHealth();
    if (ollamaResult.healthy) {
      systemHealth.ollama = { status: 'connected', lastCheck: new Date().toISOString(), error: null };
      console.log(`   ✓ Ollama:   Connected (${OLLAMA_HOST})`);
      logger.info('Ollama connected successfully', { host: OLLAMA_HOST });

      // Full-profile operators may explicitly prewarm configured defaults.
      // The demo only discovers models; it never consumes VRAM implicitly.
      if (!DEMO_RUNTIME) {
        try {
          const hostPrefService = require('./src/services/hostPreferenceService');
          const prefs = await hostPrefService.getAll();
          console.log(`   ✓ Host Preferences: ${prefs.length} host(s) configured`);
          if (shutdown.stopping) return;
          startupWork.push(hostPrefService.warmAllDefaults().then(results => {
            for (const r of results) {
              if (r.status === 'ok' || r.status === 'already_loaded') {
                console.log(`   ✓ Default: ${r.model} ${r.status === 'already_loaded' ? 'already loaded' : 'loaded'} on ${r.host} (${r.durationMs}ms)`);
              } else if (typeof r.status === 'string' && r.status.startsWith('skipped')) {
                console.log(`   ↷ Default: ${r.model} on ${r.host} — ${r.status}`);
              } else {
                console.log(`   ⚠ Default: ${r.model} on ${r.host} — ${r.error}`);
              }
            }
          }).catch(warmErr => {
            console.log(`   ⚠ Warm defaults: ${warmErr.message}`);
          }));
          await startCoreSingletonDaemon({
            name: 'host-preference-health-check',
            label: 'Host preference health check',
            start: async () => {
              hostPrefService.startHealthCheck();
              const intervalSec = typeof hostPrefService.getHealthCheckIntervalMs === 'function'
                ? Math.round(hostPrefService.getHealthCheckIntervalMs() / 1000)
                : 60;
              console.log(`   ✓ Host preference health check: Active (${intervalSec}s interval)`);
            },
            stop: async () => {
              if (typeof hostPrefService.stopHealthCheck === 'function') await hostPrefService.stopHealthCheck();
            }
          });
        } catch (warmErr) {
          console.log(`   ⚠ Host Preferences: ${warmErr.message}`);
        }
      } else {
        console.log('   ⓘ Model prewarm and host health polling: Disabled in demo profile');
      }
    } else {
      throw new Error(ollamaResult.message);
    }
  } catch (err) {
    systemHealth.ollama = { status: 'error', lastCheck: new Date().toISOString(), error: err.message };
    console.log(`   ✗ Ollama:   ${err.message} (${OLLAMA_HOST})`);
    logger.warn('Ollama not available - chat features will not work until Ollama is running', {
      error: err.message,
      host: OLLAMA_HOST
    });
  }

  // Keep systemHealth live so the basic /health endpoint self-heals. /health is
  // a cheap read of the cached systemHealth snapshot (monitors hit it often), so
  // without a refresher it stays frozen at the boot-time value forever (e.g. a
  // stale ollama:error after a host cutover, until a restart). Re-probe on an
  // interval; unref() so the timer never keeps the process alive.
  const HEALTH_REFRESH_MS = Number(process.env.HEALTH_REFRESH_MS) || 30_000;
  if (shutdown.stopping) return;
  healthRefreshTimer = setInterval(async () => {
    try {
      const r = await checkOllamaHealth();
      systemHealth.ollama = r.healthy
        ? { status: 'connected', lastCheck: new Date().toISOString(), error: null }
        : { status: 'error', lastCheck: new Date().toISOString(), error: r.message };
      const rs = require('mongoose').connection.readyState;
      systemHealth.mongodb.status = rs === 1 ? 'connected' : 'error';
    } catch (refreshErr) {
      logger.debug('health refresh tick failed', { error: refreshErr.message });
    }
  }, HEALTH_REFRESH_MS);
  if (typeof healthRefreshTimer.unref === 'function') healthRefreshTimer.unref();

  // Full-profile operational daemons never run in the product demo.
  if (!DEMO_RUNTIME) {
  // Auto-resolve stale alerts. Event-driven alerts have no "cleared"
  // signal, so a condition that stops recurring (e.g. a host recovered) would
  // leave its alert active indefinitely. Sweep periodically; the reaper is
  // idempotent (a filtered updateMany) so running it is always safe.
  try {
    const alertService = require('./src/services/alertService');
    const { reconcilePipelineTaskEscalations } = require('./src/services/pipelineTaskEscalationService');
    let staleAlertTimer = null;
    let taskEscalationScanRunning = false;
    await startCoreSingletonDaemon({
      name: 'alert-stale-resolver',
      label: 'Alert Auto-Resolver',
      start: async () => {
        const tick = () => {
          alertService.resolveStaleAlerts()
            .catch(err => logger.debug('stale-alert sweep failed', { error: err.message }));
          if (taskEscalationScanRunning) return;
          taskEscalationScanRunning = true;
          reconcilePipelineTaskEscalations()
            .catch(err => logger.warn('pipeline task escalation scan failed', { error: err.message }))
            .finally(() => { taskEscalationScanRunning = false; });
        };
        tick();
        staleAlertTimer = setInterval(tick, Number(process.env.ALERT_STALE_SWEEP_MS) || 300000);
        if (typeof staleAlertTimer.unref === 'function') staleAlertTimer.unref();
        console.log('   ✓ Alert Auto-Resolver: Active (stale sweep)');
      },
      stop: async () => { if (staleAlertTimer) { clearInterval(staleAlertTimer); staleAlertTimer = null; } }
    });
  } catch (err) {
    console.log(`   ⚠ Alert Auto-Resolver: ${err.message}`);
  }

  // Start Ollama Enrichment service (polls configured Ollama hosts for telemetry)
  try {
    const ollamaEnrichmentService = require('./src/services/ollamaEnrichmentService');
    await startCoreSingletonDaemon({
      name: 'ollama-enrichment',
      label: 'Ollama Enrichment',
      start: async () => {
        ollamaEnrichmentService.start();
        console.log(`   ✓ Ollama Enrichment: Active`);
      },
      stop: async () => ollamaEnrichmentService.stop()
    });
  } catch (err) {
    console.log(`   ⚠ Ollama Enrichment: ${err.message}`);
  }

  // Start Ollama Watchdog (inference jam detection + auto-recovery)
  try {
    const ollamaWatchdog = require('./src/services/ollamaWatchdogService');
    await startCoreSingletonDaemon({
      name: 'ollama-watchdog',
      label: 'Ollama Watchdog',
      start: async () => {
        ollamaWatchdog.start();
        console.log(`   ✓ Ollama Watchdog: Active`);
      },
      stop: async () => ollamaWatchdog.stop()
    });
  } catch (err) {
    console.log(`   ⚠ Ollama Watchdog: ${err.message}`);
  }

  // Hourly inference aggregation — populates HostUsageLedger
  try {
    const { aggregateHour } = require('./src/services/hostUsageAggregator');
    let usageAggregationInterval = null;
    await startCoreSingletonDaemon({
      name: 'host-usage-aggregator',
      label: 'Usage Aggregator',
      start: async () => {
        aggregateHour().catch(err => console.warn('Initial aggregation failed:', err.message));
        usageAggregationInterval = setInterval(() => {
          aggregateHour().catch(err => console.warn('Hourly aggregation failed:', err.message));
        }, 3_600_000);
        console.log(`   ✓ Usage Aggregator: Active (hourly)`);
      },
      stop: async () => {
        if (usageAggregationInterval) {
          clearInterval(usageAggregationInterval);
          usageAggregationInterval = null;
        }
      }
    });
  } catch (err) {
    console.log(`   ⚠ Usage Aggregator: ${err.message}`);
  }
  } else {
    console.log('   ⓘ Operational monitors and usage aggregation: Disabled in demo profile');
  }

  // Stale benchmark-claim reaper — if a batch crashes between claim and
  // release, HostPreference.status stays 'benchmarking' and blocks consumers.
  // Grace factor (1.5×estimatedDurationMs) and hard cap (2h) live in
  // hostPreferenceService.reapStaleBenchmarkClaims. Interval is
  // env-configurable via BENCHMARK_CLAIM_REAP_INTERVAL_MS (default 5 min).
  try {
    const hostPrefSvc = require('./src/services/hostPreferenceService');
    const startReaper = async () => {
      // One immediate sweep so a freshly-booted core doesn't wait a full
      // interval to clear any claim left over from the previous process.
      hostPrefSvc.reapStaleBenchmarkClaims()
        .then(r => {
          const summary = hostPrefSvc.summarizeBenchmarkClaimReaps(r.reaped);
          const releasedCount = summary.released.length;
          const refusedCount = summary.refused.length;
          if (releasedCount > 0) console.warn(`   ♻ Reaped ${releasedCount} stale benchmark claim(s)`);
          if (refusedCount > 0) console.warn(`   ⚠ Refused to reap ${refusedCount} changed benchmark claim(s)`);
        })
        .catch(err => console.warn('Benchmark claim reap failed:', err.message));
      hostPrefSvc.startBenchmarkClaimReaper();
      const intervalSec = hostPrefSvc.getBenchmarkClaimReaperIntervalMs() / 1000;
      console.log(`   ✓ Benchmark Claim Reaper: Active (every ${intervalSec}s)`);
    };
    const stopReaper = async () => hostPrefSvc.stopBenchmarkClaimReaper();
    await startCoreSingletonDaemon({
      name: 'benchmark-claim-reaper',
      label: 'Benchmark Claim Reaper',
      start: startReaper,
      stop: stopReaper
    });
  } catch (err) {
    console.log(`   ⚠ Benchmark Claim Reaper: ${err.message}`);
  }

  if (!DEMO_RUNTIME) {
  // Load default alert rules (seed to MongoDB + sync to in-memory engine)
  try {
    const { seedDefaultRules, syncRulesToEngine } = require('./src/services/alertRuleSeeder');
    const seeded = await seedDefaultRules();
    await syncRulesToEngine();
    const AlertRule = require('./models/AlertRule');
    const total = await AlertRule.countDocuments({ enabled: true });
    console.log(`   ✓ Alert Rules: ${total} enabled rules loaded${seeded > 0 ? ` (${seeded} defaults seeded)` : ''}`);
  } catch (err) {
    // Fallback: load from JSON if MongoDB seeding fails
    try {
      const alertService = require('./src/services/alertService');
      const defaultRules = require('./config/default-alert-rules.json');
      if (alertService && typeof alertService.loadRules === 'function') {
        alertService.loadRules(defaultRules);
        console.log(`   ✓ Alert Rules: Loaded ${defaultRules.length} default rules (JSON fallback)`);
      }
    } catch (fallbackErr) {
      console.warn('   ⚠ Alert Rules:', err.message);
    }
  }

  // Observe benchmark-qualified inference lanes without touching routing,
  // claims, pins, or model residency. Event-driven contract and
  // lifecycle signals flow through the same service; this singleton daemon
  // only runs the sample-gated latency comparison.
  try {
    const laneObservability = require('./src/services/laneObservabilityService');
    await startCoreSingletonDaemon({
      name: 'lane-observability-monitor',
      label: 'Lane Observability',
      start: async () => {
        laneObservability.start();
        console.log('   ✓ Lane Observability: Active (observe-only, 5m latency scan)');
      },
      stop: async () => laneObservability.stop()
    });
  } catch (err) {
    console.log(`   ⚠ Lane Observability: ${err.message}`);
  }

  // Opt-in: alert once per unknown device the Data network collector reports.
  const networkWatchMs = require('./src/services/networkDeviceWatch').watchIntervalMs();
  if (networkWatchMs) {
    try {
      const networkWatch = require('./src/services/networkDeviceWatch').createNetworkDeviceWatch();
      await startCoreSingletonDaemon({ name: 'network-device-watch', label: 'Network Device Watch',
        start: async () => { networkWatch.start(networkWatchMs); console.log(`   ✓ Network Device Watch: Active (${networkWatchMs}ms)`); },
        stop: async () => networkWatch.stop() });
    } catch (err) {
      console.log(`   ⚠ Network Device Watch: ${err.message}`);
    }
  }

  // Opt-in: a short model-written report of what monitoring rules currently flag.
  const opsWatchMs = require('./src/services/opsWatchService').watchIntervalMs();
  if (opsWatchMs) {
    try {
      const opsWatch = require('./src/services/opsWatchService').getOpsWatch();
      await startCoreSingletonDaemon({ name: 'ops-watch', label: 'Operations Watch',
        start: async () => { opsWatch.start(opsWatchMs); console.log(`   ✓ Operations Watch: Active (${opsWatchMs}ms)`); },
        stop: async () => opsWatch.stop() });
    } catch (err) {
      console.log(`   ⚠ Operations Watch: ${err.message}`);
    }
  }

  // Forgotten and expired notes are hidden at once; remove their text after retention.
  const memoryRetentionDays = require('./src/services/memoryNoteRetention').retentionDays();
  if (memoryRetentionDays) {
    try {
      const retention = require('./src/services/memoryNoteRetention').createMemoryNoteRetention();
      await startCoreSingletonDaemon({ name: 'memory-note-retention', label: 'Memory Note Retention',
        start: async () => { retention.start(); console.log(`   ✓ Memory Note Retention: Active (${memoryRetentionDays} days, daily sweep)`); },
        stop: async () => retention.stop() });
    } catch (err) {
      console.log(`   ⚠ Memory Note Retention: ${err.message}`);
    }
  }

  // Council sessions only advance inside the process that started them. Close
  // any pending/running session a previous process left behind so the Council
  // page never shows a RUNNING status that nothing can complete.
  try {
    const roundtableService = require('./src/services/roundtable');
    let councilReaper = null;
    await startCoreSingletonDaemon({
      name: 'council-stale-session-reaper',
      label: 'Council Reaper',
      start: async () => {
        const first = await roundtableService.reconcileStaleRoundtables();
        councilReaper = setInterval(() => {
          roundtableService.reconcileStaleRoundtables().catch(() => {});
        }, 5 * 60 * 1000);
        if (typeof councilReaper.unref === 'function') councilReaper.unref();
        console.log(`   ✓ Council Reaper: Active (closed ${first.reconciled} stale session${first.reconciled === 1 ? '' : 's'} at boot, 5m sweep)`);
      },
      stop: async () => { if (councilReaper) clearInterval(councilReaper); }
    });
  } catch (err) {
    console.log(`   ⚠ Council Reaper: ${err.message}`);
  }

  // Durable platform backups. Docker enables this by default after wiring a
  // host-visible /backups mount and the MongoDB database tools into Core. Each
  // cycle attempts Mongo, runtime config, and Qdrant independently so one
  // failing layer cannot prevent the others from being protected. Occurrences
  // follow BACKUP_SCHEDULE_CRON in BACKUP_SCHEDULE_TZ and are persisted, so a
  // restart never adds a cycle.
  try {
    const backupScheduler = require('./src/services/backupSchedulerService');
    if (!backupScheduler.isEnabled()) {
      console.log('   ⓘ Backup Scheduler: Disabled (BACKUP_SCHEDULE_ENABLED)');
    } else {
      await startCoreSingletonDaemon({
        name: 'platform-backup-scheduler',
        label: 'Backup Scheduler',
        start: async () => {
          const started = backupScheduler.start();
          const status = backupScheduler.getStatus();
          if (started) console.log(`   ✓ Backup Scheduler: Active (${status.cadenceLabel})`);
          else console.log(`   ⚠ Backup Scheduler: Not scheduled (${status.scheduleError || status.nextRunReason})`);
        },
        stop: async () => backupScheduler.stop()
      });
    }
  } catch (err) {
    console.log(`   ⚠ Backup Scheduler: ${err.message}`);
  }

  // Finance inbox: ingests statements dropped in FINANCE_INBOX_PATH (off
  // unless the inbox, archive and review paths are configured).
  try {
    const { financeInbox } = require('./src/services/finance/financeInboxService');
    require('./src/services/finance/financeIngestionService').backfillFlow()
      .then(({ updated }) => { if (updated) console.log(`   ✓ Finance: owner flow filled on ${updated} ledger row(s)`); })
      .catch((error) => console.log(`   ⚠ Finance flow backfill: ${error.message}`));
    const inbox = financeInbox();
    if (!inbox.settings.enabled) {
      console.log('   ⓘ Finance Inbox: Disabled (FINANCE_INBOX_PATH / FINANCE_ARCHIVE_PATH)');
    } else {
      await startCoreSingletonDaemon({
        name: 'finance-inbox',
        label: 'Finance Inbox',
        start: async () => {
          inbox.start();
          console.log(`   ✓ Finance Inbox: Active (every ${Math.round(inbox.settings.pollMs / 60000)} min)`);
        },
        stop: async () => inbox.stop()
      });
    }
  } catch (err) {
    console.log(`   ⚠ Finance Inbox: ${err.message}`);
  }
  } else {
    console.log('   ⓘ Alerts, lane monitoring, and backups: Disabled in demo profile');
  }

  // Start Express server
  if (shutdown.stopping) return;
  httpServer = app.listen(PORT, HOST, () => {
    console.log(`\n${'─'.repeat(58)}`);
    console.log(`🚀 Server:    http://${HOST}:${PORT}`);
    console.log(`💚 Health:    http://${HOST}:${PORT}/health`);
    console.log(`📚 Docs:      /docs folder`);
    console.log(`📋 Logs:      logs/combined.log & logs/error.log`);
    console.log(`${'─'.repeat(58)}\n`);

    const isHealthy = systemHealth.mongodb.status === 'connected';

    if (isHealthy) {
      console.log(`✅ Required product services are ready\n`);
      if (systemHealth.ollama.status !== 'connected') {
        console.log(`   ⓘ Ollama is optional and currently unavailable: ${systemHealth.ollama.error}\n`);
      }
    } else {
      console.log(`⚠️  WARNING: Running in degraded mode\n`);
      if (systemHealth.mongodb.status !== 'connected') {
        console.log(`   MongoDB Issue: ${systemHealth.mongodb.error}`);
      }
      console.log(`\n   Restore required dependencies before using the product.\n`);
    }

    logger.info('AgentX Core server started', {
      port: PORT,
      host: HOST,
      environment: process.env.NODE_ENV || 'development',
      mongodb: systemHealth.mongodb.status,
      ollama: systemHealth.ollama.status,
      healthy: isHealthy
    });

  });
}

// Start the server
startupPromise = startServer().catch(err => {
  logger.error('Failed to start server', { error: err.message, stack: err.stack });
  console.error(`\n❌ Fatal Error: ${err.message}\n`);
  process.exit(1);
});
