const { getRepoWatcherService } = require('./repoWatcherService');
const { handleChatRequest } = require('./chatService');
const { routeRequest, getRoutingStatus, getFailoverStatus } = require('./modelRouter');
const { runSnapshot, generateDigest, listRepos } = require('./maintenanceSnapshotService');

const DEFAULT_REPO_PATH = process.env.REPO_WATCHER_PATH || process.cwd();
const SPECIALX_SYSTEM_USER = process.env.SPECIALX_SYSTEM_USER || 'specialx-system';

async function runRepoSummaryTask(task) {
  const repoPath = task.input?.repoPath || DEFAULT_REPO_PATH;
  const service = getRepoWatcherService();
  const result = await service.scan(repoPath, task.workspaceId || null);

  const topFindings = (result.findings || [])
    .slice(0, 5)
    .map((finding) => `${finding.severity}:${finding.type}`);

  return {
    summary: `Repo scan ${result.status.toUpperCase()} • Fail ${result.summary.failures} • Warn ${result.summary.warnings}`,
    output: {
      repoPath,
      scanStatus: result.status,
      scanDuration: result.scanDuration,
      summary: result.summary,
      topFindings
    },
    artifacts: [{
      name: 'repo_summary',
      kind: 'json',
      content: result
    }],
    metrics: {
      localCalls: 1,
      cloudCalls: 0
    },
    execution: {
      routed: false
    }
  };
}

async function runModelHealthDigestTask() {
  const [routingStatus, failover] = await Promise.all([
    getRoutingStatus(),
    Promise.resolve(getFailoverStatus())
  ]);

  const hosts = routingStatus.hosts || {};
  const hostStates = Object.entries(hosts).map(([name, host]) => ({
    name,
    status: host.status || 'unknown',
    latency: host.latency || -1,
    models: (host.models || []).length
  }));

  const onlineCount = hostStates.filter((h) => h.status === 'online').length;
  const summary = `Model health ${onlineCount}/${hostStates.length} hosts online • Active ${failover.currentHost || 'n/a'}`;

  return {
    summary,
    output: {
      hosts: hostStates,
      failover
    },
    artifacts: [{
      name: 'model_health_digest',
      kind: 'json',
      content: {
        hosts: hostStates,
        failover,
        generatedAt: new Date().toISOString()
      }
    }],
    metrics: {
      localCalls: 1,
      cloudCalls: 0
    },
    execution: {
      routed: false
    }
  };
}

async function runCiFailureTriageTask(task, specialX) {
  const logs = String(task.input?.failureLogs || task.input?.logs || '').slice(0, 18000);
  const failingTests = Array.isArray(task.input?.failingTests) ? task.input.failingTests.join('\n') : '';
  const branch = task.input?.branch || 'unknown';
  const pipeline = task.input?.pipeline || 'unknown';

  const prompt = [
    'You are SpecialX Operator. Triage this CI failure.',
    'Return concise sections: Root Cause, Quick Fix, Verification Steps, Risk.',
    `Pipeline: ${pipeline}`,
    `Branch: ${branch}`,
    failingTests ? `Failing Tests:\n${failingTests}` : '',
    logs ? `Logs:\n${logs}` : 'Logs unavailable.'
  ].filter(Boolean).join('\n\n');

  const routing = await routeRequest(prompt, {
    autoRoute: true,
    taskType: specialX?.modelPolicy?.preferredTaskType || 'analysis'
  });

  const chat = await handleChatRequest({
    userId: SPECIALX_SYSTEM_USER,
    model: routing.model,
    target: routing.target,
    message: prompt,
    persona: specialX?.promptProfile?.persona || 'default_chat',
    options: { temperature: 0.1, num_predict: 1000 },
    autoRoute: false,
    useRag: false,
    workspaceId: task.workspaceId || null
  });

  return {
    summary: (chat.response || '').split('\n').find(Boolean)?.slice(0, 180) || 'CI triage completed',
    output: {
      triage: chat.response || '',
      conversationId: chat.conversationId || null,
      assistantMessageId: chat.assistantMessageId || null
    },
    artifacts: [{
      name: 'ci_failure_triage',
      kind: 'markdown',
      content: chat.response || ''
    }],
    metrics: {
      localCalls: 1,
      cloudCalls: 0
    },
    execution: {
      model: routing.model,
      target: routing.target,
      taskType: routing.taskType,
      routed: true,
      fallbackUsed: false
    }
  };
}

async function runCustomPromptAnalysisTask(task, specialX) {
  const promptInput = String(task.input?.prompt || '').slice(0, 20000);
  if (!promptInput.trim()) {
    throw new Error('custom_prompt_analysis requires input.prompt');
  }

  const prompt = [
    'Analyze this prompt for quality and operational fitness.',
    'Return sections: Strengths, Weaknesses, Risks, Improved Prompt.',
    promptInput
  ].join('\n\n');

  const routing = await routeRequest(prompt, {
    autoRoute: true,
    taskType: specialX?.modelPolicy?.preferredTaskType || 'analysis'
  });

  const chat = await handleChatRequest({
    userId: SPECIALX_SYSTEM_USER,
    model: routing.model,
    target: routing.target,
    message: prompt,
    persona: specialX?.promptProfile?.persona || 'default_chat',
    options: { temperature: 0.1, num_predict: 1200 },
    autoRoute: false,
    useRag: false,
    workspaceId: task.workspaceId || null
  });

  return {
    summary: (chat.response || '').split('\n').find(Boolean)?.slice(0, 180) || 'Prompt analysis completed',
    output: {
      analysis: chat.response || '',
      conversationId: chat.conversationId || null
    },
    artifacts: [{
      name: 'prompt_analysis',
      kind: 'markdown',
      content: chat.response || ''
    }],
    metrics: {
      localCalls: 1,
      cloudCalls: 0
    },
    execution: {
      model: routing.model,
      target: routing.target,
      taskType: routing.taskType,
      routed: true,
      fallbackUsed: false
    }
  };
}

async function runDailyOperationsDigestTask(task, getQueueMetrics) {
  const repoPath = task.input?.repoPath || DEFAULT_REPO_PATH;
  const [repoResult, routingStatus, queueStats] = await Promise.all([
    getRepoWatcherService().scan(repoPath, task.workspaceId || null),
    getRoutingStatus(),
    getQueueMetrics()
  ]);

  const hosts = Object.entries(routingStatus.hosts || {}).map(([key, host]) => ({
    host: key,
    status: host.status || 'unknown',
    latency: host.latency || -1
  }));

  const summary = [
    `Repo ${repoResult.status.toUpperCase()} (fail:${repoResult.summary.failures}, warn:${repoResult.summary.warnings})`,
    `Queue queued:${queueStats.queue.queued} running:${queueStats.queue.running}`,
    `Local-first ratio: ${queueStats.runs.localFirstRatio}%`
  ].join(' | ');

  return {
    summary,
    output: {
      repo: repoResult,
      hosts,
      queue: queueStats
    },
    artifacts: [{
      name: 'daily_operations_digest',
      kind: 'json',
      content: {
        generatedAt: new Date().toISOString(),
        repo: repoResult,
        hosts,
        queue: queueStats
      }
    }],
    metrics: {
      localCalls: 2,
      cloudCalls: 0
    },
    execution: {
      routed: false
    }
  };
}

// ---------------------------------------------------------------------------
// Maintenance Snapshot — runs all scanners against one repo, upserts findings
// ---------------------------------------------------------------------------
async function runMaintenanceSnapshotTask(task) {
  const repoId = task.input?.repoId;
  const scanners = task.input?.scanners || undefined;
  if (!repoId) throw new Error('maintenance_snapshot requires input.repoId');

  const result = await runSnapshot(repoId, { scanners });
  const s = result.summary;

  return {
    summary: `${repoId} scan: ${s.newThisScan} new · ${s.totalOpenFindings} open · high:${s.bySeverity?.high || 0} med:${s.bySeverity?.medium || 0}`,
    output: result,
    artifacts: [{ name: 'maintenance_snapshot', kind: 'json', content: result }],
    metrics: { localCalls: 0, cloudCalls: 0 },
    execution: { routed: false }
  };
}

// ---------------------------------------------------------------------------
// Maintenance Digest — Telegram-formatted summary across all repos
// ---------------------------------------------------------------------------
async function runMaintenanceDigestTask() {
  const repos = listRepos();
  const digests = await Promise.all(repos.map(r => generateDigest(r.id)));
  const text = digests.join('\n\n---\n\n');

  return {
    summary: `Maintenance digest for ${repos.map(r => r.id).join(', ')}`,
    output: { text, repos: repos.map(r => r.id) },
    artifacts: [{ name: 'maintenance_digest', kind: 'markdown', content: text }],
    metrics: { localCalls: 0, cloudCalls: 0 },
    execution: { routed: false }
  };
}

// ---------------------------------------------------------------------------
// Schedule Reconcile — audit the maintenance pipeline for missed/failed tasks
// ---------------------------------------------------------------------------
async function runScheduleReconcileTask(task, getQueueMetrics) {
  const AutomationTask = require('../../models/AutomationTask');

  const windowHours = task.input?.windowHours || 25;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  // Tracked types driven by MaintenanceSchedulerService
  const TRACKED_TYPES = ['telemetry_aggregate', 'maintenance_snapshot', 'maintenance_digest'];

  // Load all scheduled tasks created within the window
  const recentTasks = await AutomationTask.find({
    source: 'schedule',
    type: { $in: TRACKED_TYPES },
    createdAt: { $gte: since }
  }).select('type status idempotencyKey createdAt completedAt lastError').lean();

  // Group by type
  const byType = {};
  for (const t of recentTasks) {
    if (!byType[t.type]) byType[t.type] = [];
    byType[t.type].push(t);
  }

  let okCount = 0, missedCount = 0, degradedCount = 0;
  const report = {};

  for (const type of TRACKED_TYPES) {
    const tasks = byType[type] || [];
    const completed = tasks.filter((t) => t.status === 'completed').length;
    const failed    = tasks.filter((t) => ['failed', 'dead_letter'].includes(t.status)).length;
    const queued    = tasks.filter((t) => ['queued', 'leased', 'running'].includes(t.status)).length;

    let status;
    if (tasks.length === 0)       { status = 'missed';   missedCount++; }
    else if (failed > 0)           { status = 'degraded'; degradedCount++; }
    else if (completed > 0)        { status = 'ok';       okCount++; }
    else                           { status = 'pending';  okCount++; }

    report[type] = { total: tasks.length, completed, failed, queued, status };
  }

  const queueStats = await getQueueMetrics();
  const summary = `Schedule reconcile: ${okCount} ok · ${missedCount} missed · ${degradedCount} degraded (${windowHours}h window)`;

  return {
    summary,
    output: {
      windowHours,
      since: since.toISOString(),
      trackedTypes: TRACKED_TYPES,
      report,
      queue: {
        queued: queueStats.queue?.queued || 0,
        running: queueStats.queue?.running || 0,
        failed: queueStats.queue?.failed || 0
      }
    },
    artifacts: [{
      name: 'schedule_reconcile',
      kind: 'json',
      content: {
        generatedAt: new Date().toISOString(),
        windowHours,
        report,
        queue: queueStats
      }
    }],
    metrics: { localCalls: 0, cloudCalls: 0 },
    execution: { routed: false }
  };
}

// ---------------------------------------------------------------------------
// Telemetry Aggregate — aggregate InferenceLog → HostUsageLedger
// ---------------------------------------------------------------------------
async function runTelemetryAggregateTask() {
  try {
    const { aggregateHour } = require('./hostUsageAggregator');
    const result = await aggregateHour();
    return {
      summary: `Telemetry aggregated: ${result.hoursProcessed} hour(s), ${result.recordsWritten} ledger records`,
      output: result,
      artifacts: [{ name: 'telemetry_aggregate', kind: 'json', content: result }],
      metrics: { localCalls: 0, cloudCalls: 0 },
      execution: { routed: false }
    };
  } catch (err) {
    return {
      summary: `Telemetry aggregate failed: ${err.message}`,
      output: { error: err.message },
      artifacts: [],
      metrics: { localCalls: 0, cloudCalls: 0 },
      execution: { routed: false }
    };
  }
}

async function runTaskByType(task, specialX, getQueueMetrics) {
  switch (task.type) {
  case 'repo_summary':
    return runRepoSummaryTask(task);
  case 'ci_failure_triage':
    return runCiFailureTriageTask(task, specialX);
  case 'model_health_digest':
    return runModelHealthDigestTask();
  case 'daily_operations_digest':
    return runDailyOperationsDigestTask(task, getQueueMetrics);
  case 'custom_prompt_analysis':
    return runCustomPromptAnalysisTask(task, specialX);
  case 'maintenance_snapshot':
    return runMaintenanceSnapshotTask(task);
  case 'maintenance_digest':
    return runMaintenanceDigestTask();
  case 'telemetry_aggregate':
    return runTelemetryAggregateTask();
  case 'schedule_reconcile':
    return runScheduleReconcileTask(task, getQueueMetrics);
  default:
    throw new Error(`Unsupported task type: ${task.type}`);
  }
}

module.exports = {
  runTaskByType
};
