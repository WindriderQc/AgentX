#!/usr/bin/env node
'use strict';

/**
 * AIOps-owned OpenClaw schedule projection.
 *
 * Reads the bounded Core projection by default (or the official OpenClaw CLI /
 * state file when explicitly configured) and sends normalized entries to the
 * AgentX cluster schedule API. Uses only Node 18+ built-ins.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const AGENTX_URL = process.env.AGENTX_URL || 'http://127.0.0.1:3180';
const JOBS_URL = process.env.AGENTX_OPENCLAW_JOBS_URL || `${AGENTX_URL}/api/openclaw/cron?includeDisabled=true`;
const JOBS_FILE = process.env.OPENCLAW_JOBS_FILE
  || path.join(process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw'), 'cron', 'jobs.json');
// ClusterScheduleEntry intentionally keeps scheduler implementations outside
// the reusable Product schema. OpenClaw is an AIOps-owned external scheduler,
// so mirror it through the Product's generic system-schedule source and retain
// the concrete authority only as bounded metadata.
const CLUSTER_SOURCE = 'agentx-system';
const MIRROR_PREFIX = 'oc-';

function envValue(file, key) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const separator = line.indexOf('=');
      const name = line.slice(0, separator).trim().replace(/^export\s+/, '');
      if (name !== key) continue;
      let value = line.slice(separator + 1).trim();
      if (value.length >= 2 && value[0] === value[value.length - 1] && ['"', "'"].includes(value[0])) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return '';
}

function projectDelivery(delivery) {
  if (!delivery || typeof delivery !== 'object') return null;
  const mode = typeof delivery.mode === 'string' && delivery.mode.trim()
    ? delivery.mode.trim()
    : null;
  const channel = typeof delivery.channel === 'string' && delivery.channel.trim()
    ? delivery.channel.trim()
    : null;
  return {
    mode,
    channel,
    hasTarget: typeof delivery.to === 'string' && delivery.to.trim().length > 0,
    hasThread: delivery.threadId !== undefined && delivery.threadId !== null,
  };
}

function resolveModel(model, host) {
  const explicitModel = typeof model === 'string' ? model.trim() : '';
  const explicitHost = typeof host === 'string' ? host.trim() : '';
  return {
    model: explicitModel || null,
    host: explicitHost || null,
  };
}

function classifyTaskType(name) {
  if (/health|monitor|infra/i.test(name)) return 'monitoring';
  if (/benchmark/i.test(name)) return 'benchmark';
  if (/maintenance|memory|rag/i.test(name)) return 'maintenance';
  if (/sync|bisync/i.test(name)) return 'sync';
  if (/audit|security|analytics|report|review|quality|improve/i.test(name)) return 'diagnostics';
  return 'inference';
}

function parseCronSchedule(job) {
  const schedule = job?.schedule;
  if (schedule?.kind === 'cron' && schedule.expr) {
    return { type: 'cron', cron: schedule.expr, timezone: schedule.tz || 'UTC' };
  }
  if (schedule?.kind === 'every' && schedule.everyMs) {
    return { type: 'interval', intervalMs: schedule.everyMs, timezone: schedule.tz || 'UTC' };
  }
  return null;
}

function normalizeJobs(value) {
  const jobs = Array.isArray(value) ? value : value?.data || value?.jobs;
  if (!Array.isArray(jobs)) throw new Error('OpenClaw source did not return a jobs array');
  return jobs;
}

async function loadJobsFromAgentX(url = JOBS_URL, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const headers = options.headers || {};
  const response = await fetchImpl(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `AgentX returned HTTP ${response.status}`);
  return normalizeJobs(body);
}

function loadJobsFromCli(bin = process.env.OPENCLAW_BIN || 'openclaw') {
  const raw = execFileSync(bin, ['cron', 'list', '--json'], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  return normalizeJobs(JSON.parse(raw));
}

function loadJobsFromFile(file = JOBS_FILE) {
  return normalizeJobs(JSON.parse(fs.readFileSync(file, 'utf8')));
}

async function loadJobs() {
  if (JOBS_URL) return { jobs: await loadJobsFromAgentX(), source: JOBS_URL };
  try {
    return { jobs: loadJobsFromCli(), source: 'openclaw cron list --json' };
  } catch (cliError) {
    try {
      return { jobs: loadJobsFromFile(), source: JOBS_FILE };
    } catch (fileError) {
      throw new Error(`OpenClaw CLI failed (${cliError.message}); state file failed (${fileError.message})`);
    }
  }
}

function toEntry(job) {
  const name = job.name || job.id || 'unknown';
  const schedule = parseCronSchedule(job);
  if (!schedule) return null;
  const modelReference = job.payload?.model || null;
  const { model, host } = resolveModel(modelReference, job.payload?.host);
  const state = job.state || {};
  const lastDurationMs = state.lastDurationMs ?? job.lastDurationMs ?? null;
  const lastStatus = state.lastStatus ?? job.lastStatus ?? job.lastRunStatus ?? null;
  const consecutiveErrors = state.consecutiveErrors ?? job.consecutiveErrors ?? 0;
  const lastRunAtMs = state.lastRunAtMs ?? job.lastRunAtMs ?? null;
  const nextRunAtMs = state.nextRunAtMs ?? job.nextRunAtMs ?? null;
  return {
    source: CLUSTER_SOURCE,
    sourceId: `${MIRROR_PREFIX}${name}`,
    name: name.replace(/[:-]/g, ' ').replace(/\b\w/g, (value) => value.toUpperCase()).trim(),
    taskType: classifyTaskType(name),
    host,
    model,
    agent: job.agentId || null,
    schedule,
    estimatedDurationMs: lastDurationMs,
    enabled: job.enabled !== false,
    lastRun: lastRunAtMs ? new Date(lastRunAtMs) : null,
    metadata: {
      scheduler: 'openclaw',
      sourceAuthority: 'bounded-agentx-openclaw-cron',
      modelReference,
      delivery: projectDelivery(job.delivery),
      lastStatus,
      consecutiveErrors,
      originalJobId: job.id || name,
      nextRunAtMs,
    },
  };
}

async function loadExistingMirrorEntries(url = AGENTX_URL, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const headers = options.headers || {};
  const response = await fetchImpl(`${url}/api/cluster/schedule?source=${encodeURIComponent(CLUSTER_SOURCE)}`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status !== 'success') {
    throw new Error(body.error || body.message || `schedule read returned HTTP ${response.status}`);
  }
  const entries = body.data?.entries;
  if (!Array.isArray(entries)) throw new Error('AgentX schedule read did not return an entries array');
  return entries.filter((entry) => String(entry.sourceId || '').startsWith(MIRROR_PREFIX));
}

function tombstoneMissingEntries(existingEntries, currentEntries) {
  const currentIds = new Set(currentEntries.map((entry) => entry.sourceId));
  return existingEntries
    .filter((entry) => !currentIds.has(entry.sourceId))
    .map((entry) => ({
      source: CLUSTER_SOURCE,
      sourceId: entry.sourceId,
      name: entry.name,
      taskType: entry.taskType,
      host: entry.host ?? null,
      model: entry.model ?? null,
      agent: entry.agent ?? null,
      schedule: {
        type: entry.schedule?.type,
        cron: entry.schedule?.cron ?? null,
        intervalMs: entry.schedule?.intervalMs ?? null,
        timezone: entry.schedule?.timezone || 'UTC',
      },
      estimatedDurationMs: entry.estimatedDurationMs ?? null,
      vramMb: entry.vramMb ?? null,
      priority: entry.priority ?? 5,
      enabled: false,
      lastRun: entry.lastRun ?? null,
      metadata: {
        ...(entry.metadata || {}),
        scheduler: 'openclaw',
        sourceAuthority: 'bounded-agentx-openclaw-cron',
        mirrorState: 'absent-from-openclaw',
      },
    }));
}

async function main() {
  const loaded = await loadJobs();
  const entries = loaded.jobs.map(toEntry).filter(Boolean);
  const existing = await loadExistingMirrorEntries();
  const tombstones = tombstoneMissingEntries(existing, entries);
  const reconciledEntries = [...entries, ...tombstones];
  const response = await fetch(`${AGENTX_URL}/api/cluster/schedule/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: reconciledEntries }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status !== 'success') {
    throw new Error(body.error || body.message || `sync returned HTTP ${response.status}`);
  }
  const result = body.data || {};
  console.log(`Parsed ${entries.length} jobs from ${loaded.source}; tombstoned ${tombstones.length} removed mirror entries`);
  console.log(`Sync OK: ${result.created || 0} created, ${result.updated || 0} updated, ${result.unchanged || 0} unchanged`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  CLUSTER_SOURCE,
  classifyTaskType,
  envValue,
  loadJobsFromAgentX,
  loadJobsFromCli,
  loadJobsFromFile,
  loadExistingMirrorEntries,
  normalizeJobs,
  parseCronSchedule,
  projectDelivery,
  resolveModel,
  tombstoneMissingEntries,
  toEntry,
};
