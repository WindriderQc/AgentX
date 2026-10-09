'use strict';

const queue = require('./heavyWorkQueueService');
const { getConfiguredHosts } = require('../helpers/ollamaHostConfig');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');

async function reservations(dayStart, dayEnd) {
  const state = await queue.list();
  const configured = getConfiguredHosts();
  const entries = [];
  for (const job of state?.jobs || []) {
    if (!job.reservation || ['completed', 'failed', 'cancelled'].includes(job.state)) continue;
    const start = new Date(job.reservation.start), end = new Date(job.reservation.end);
    if (start >= dayEnd || end <= dayStart) continue;
    for (const endpoint of job.hosts) {
      const host = configured.find(item => hostUrlKey(item.url) === endpoint);
      entries.push({ id: `${job.id}:${endpoint}`, name: `${job.title} (estimated)`, source: 'agentx', sourceId: job.id,
        taskType: job.kind === 'profiler' ? 'diagnostics' : job.kind === 'image' ? 'inference' : job.kind,
        host: host?.id || null, model: null, agent: null, priority: job.priority,
        estimatedDurationMs: job.estimatedMinutes * 60000, vramMb: null, scheduleType: 'one-off',
        lastRun: job.dispatchedAt || null,
        metadata: { scheduler: 'core-heavy-work-queue', queueRequestId: job.id, plannedHost: endpoint,
          lastStatus: job.state, estimated: true, runtimeAdmissionRequired: true },
        slots: [{ start: new Date(Math.max(start.getTime(), dayStart.getTime())).toISOString(),
          end: new Date(Math.min(end.getTime(), dayEnd.getTime())).toISOString(), estimated: true }]
      });
    }
  }
  return entries;
}

module.exports = { reservations };
