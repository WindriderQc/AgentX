#!/usr/bin/env node
/**
 * Seed AgentX system-level cron jobs into ClusterScheduleEntry.
 * These are OS crontab jobs that run on UGClawdX but have no openclaw owner.
 * Run once (or re-run idempotently via sync endpoint).
 *
 * Usage: node scripts/seed-agentx-system-crons.js
 */
const AGENTX_URL = process.env.AGENTX_URL || 'http://localhost:3080';
const SYNC_ENDPOINT = `${AGENTX_URL}/api/cluster/schedule/sync`;

const entries = [
  {
    source: 'agentx-system',
    sourceId: 'sys-openclaw-schedule-sync',
    name: 'OpenClaw Schedule Sync',
    taskType: 'sync',
    host: 'primary',           // runs on UGClawdX (gateway host)
    model: null,
    agent: null,
    schedule: { type: 'interval', intervalMs: 15 * 60 * 1000, timezone: 'America/Toronto' },
    estimatedDurationMs: 3000,
    enabled: true,
    metadata: {
      description: 'Reads /home/yb/.openclaw/cron/jobs.json → POST /api/cluster/schedule/sync',
      script: '/home/yb/codes/AgentX/scripts/sync-openclaw-schedule.js',
      crontab: '*/15 * * * *',
      log: '/tmp/openclaw-sync.log'
    }
  },
  {
    source: 'agentx-system',
    sourceId: 'sys-telemetry-aggregate',
    name: 'Telemetry Aggregation',
    taskType: 'monitoring',
    host: 'primary',
    model: null,
    agent: null,
    schedule: { type: 'cron', cron: '5 * * * *', timezone: 'America/Toronto' },
    estimatedDurationMs: 10000,
    enabled: true,
    metadata: {
      description: 'Triggers SpecialX telemetry_aggregate → InferenceLog → HostUsageLedger',
      script: '/home/yb/codes/AgentX/scripts/trigger-telemetry-aggregate.sh',
      crontab: '5 * * * *',
      log: '/tmp/agentx-telemetry.log'
    }
  }
];

async function main() {
  const res = await fetch(SYNC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json();
  if (data.status === 'success') {
    console.log(`Seeded: ${data.data.created} created, ${data.data.updated} updated, ${data.data.unchanged} unchanged`);
  } else {
    console.error('Failed:', data.error || JSON.stringify(data));
    process.exit(1);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
