const { getRepoWatcherService } = require('./repoWatcherService');
const { handleChatRequest } = require('./chatService');
const { routeRequest, getRoutingStatus, getFailoverStatus } = require('./modelRouter');

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
  default:
    throw new Error(`Unsupported task type: ${task.type}`);
  }
}

module.exports = {
  runTaskByType
};
