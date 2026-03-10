#!/usr/bin/env node
/**
 * Sync OpenClaw Schedule → AgentX
 *
 * Reads OpenClaw's cron/jobs.json and pushes to AgentX's cluster schedule API.
 * Zero OpenClaw code changes — reads the existing file directly.
 * Zero npm dependencies — uses Node 18+ built-in fetch.
 *
 * Deploy to ClawdX (one-time):
 *   scp scripts/sync-openclaw-schedule.js clawdx:~/sync-openclaw-schedule.js
 *   ssh clawdx 'crontab -l 2>/dev/null; echo "every 15 minutes: node ~/sync-openclaw-schedule.js >> /tmp/openclaw-sync.log 2>&1"' | ssh clawdx 'crontab -'
 *
 * Manual run:
 *   node sync-openclaw-schedule.js
 *
 * Environment overrides:
 *   OPENCLAW_JOBS_FILE  (default: ~/.openclaw/cron/jobs.json)
 *   AGENTX_URL          (default: http://localhost:3080)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const JOBS_FILE = process.env.OPENCLAW_JOBS_FILE
  || path.join(os.homedir(), '.openclaw', 'cron', 'jobs.json');
const AGENTX_URL = process.env.AGENTX_URL || 'http://localhost:3080';
const SYNC_ENDPOINT = `${AGENTX_URL}/api/cluster/schedule/sync`;

// OpenClaw model alias → { model, host }
const MODEL_ALIASES = {
  local:   { model: 'qwen2.5:14b-instruct-q5_K_M', host: 'secondary' },
  fast:    { model: 'qwen3:14b',                    host: 'tertiary' },
  big:     { model: 'qwen32b:perf',                 host: 'tertiary' },
  think:   { model: 'deepseek-r1:14b',              host: 'secondary' },
  coder:   { model: 'deepcoder:14b-preview-q4_K_M', host: 'secondary' },
  oss:     { model: 'openclaw-oss-20b',              host: 'secondary' },
  mistral: { model: 'Mistral-Small3.1-24B',          host: 'secondary' }
};

function resolveModel(alias) {
  if (!alias) return { model: null, host: 'tertiary' };
  return MODEL_ALIASES[alias] || { model: alias, host: 'tertiary' };
}

function classifyTaskType(jobName) {
  if (/health|monitor|infra/i.test(jobName)) return 'monitoring';
  if (/benchmark/i.test(jobName)) return 'benchmark';
  if (/maintenance|memory|rag/i.test(jobName)) return 'maintenance';
  if (/sync|bisync/i.test(jobName)) return 'sync';
  if (/audit|security/i.test(jobName)) return 'diagnostics';
  if (/analytics|report|quality|improve/i.test(jobName)) return 'diagnostics';
  return 'inference';
}

function parseCronSchedule(job) {
  const sched = job.schedule;
  if (!sched || !sched.kind) return null;
  const tz = sched.tz || 'America/Toronto';

  if (sched.kind === 'cron' && sched.expr) {
    return { type: 'cron', cron: sched.expr, timezone: tz };
  }
  if (sched.kind === 'every' && sched.everyMs) {
    return { type: 'interval', intervalMs: sched.everyMs, timezone: tz };
  }
  return null;
}

async function main() {
  // 1. Read jobs.json
  if (!fs.existsSync(JOBS_FILE)) {
    console.error(`Jobs file not found: ${JOBS_FILE}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(JOBS_FILE, 'utf8');
  let jobs;
  try {
    jobs = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse ${JOBS_FILE}:`, err.message);
    process.exit(1);
  }

  // jobs.json can be an array or { jobs: [...] }
  const jobList = Array.isArray(jobs) ? jobs : (jobs.jobs || Object.values(jobs));

  if (!jobList || jobList.length === 0) {
    console.log('No jobs found in', JOBS_FILE);
    process.exit(0);
  }

  // 2. Transform to ClusterScheduleEntry format
  const entries = [];
  for (const job of jobList) {
    const name = job.name || job.id || 'unknown';
    const schedule = parseCronSchedule(job);
    if (!schedule) continue;

    const modelAlias = job.payload?.model || null;
    const { model, host } = resolveModel(modelAlias);
    const state = job.state || {};

    entries.push({
      source: 'openclaw',
      sourceId: `oc-${name}`,
      name: name.replace(/[:-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim(),
      taskType: classifyTaskType(name),
      host,
      model,
      agent: job.agentId || null,
      schedule,
      estimatedDurationMs: state.lastDurationMs || null,
      enabled: job.enabled !== false,
      lastRun: state.lastRunAtMs ? new Date(state.lastRunAtMs) : null,
      metadata: {
        modelAlias,
        delivery: job.delivery || null,
        lastStatus: state.lastStatus || null,
        consecutiveErrors: state.consecutiveErrors || 0,
        originalJobId: job.id || name
      }
    });
  }

  console.log(`Parsed ${entries.length} jobs from ${JOBS_FILE}`);

  // 3. POST to AgentX sync endpoint (uses Node 18+ built-in fetch — no npm deps)
  try {
    const res = await fetch(SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
      signal: AbortSignal.timeout(10000)
    });

    const data = await res.json();
    if (data.status === 'success') {
      console.log(`Sync OK: ${data.data.created} created, ${data.data.updated} updated, ${data.data.unchanged} unchanged`);
    } else {
      console.error('Sync failed:', data.error || JSON.stringify(data));
      process.exit(1);
    }
  } catch (err) {
    console.error(`Failed to reach AgentX at ${SYNC_ENDPOINT}:`, err.message);
    process.exit(1);
  }
}

main();
