#!/usr/bin/env node
/**
 * Seed Cluster Schedule
 *
 * Idempotent: upserts schedule entries from real infrastructure.
 *
 * Sources:
 *   openclaw  — 12 cron jobs from ~/.openclaw/cron/jobs.json (ClawdX)
 *   n8n       — 7 scheduled workflows (Ubundocker)
 *   agentx    — 5 internal timers (Docker Host)
 *   ollama-persistent — 3 GPU hosts always-on
 *
 * Hosts:
 *   UGFrank    (primary)   — 192.168.2.99  — RTX 3080 Ti 12GB
 *   UGBrutal   (secondary) — 192.168.2.12  — RTX 5070 Ti 16GB
 *   UGClawdX   (tertiary)  — 192.168.2.66  — RTX 3090 24GB + OpenClaw
 *   Ubundocker             — 192.168.2.199 — n8n automation
 *   Docker Host            — 192.168.2.33  — DataAPI, MongoDB
 *
 * Run: node scripts/seed-cluster-schedule.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx';

const entries = [
  // ── OpenClaw Cron Jobs (UGClawdX 192.168.2.66) ───────────────
  // Source: ~/.openclaw/cron/jobs.json
  // Model aliases: local=qwen2.5:14b→UGBrutal, big=qwen32b:perf→UGClawdX
  {
    source: 'openclaw', sourceId: 'oc-infra-health-check',
    name: 'Infra Health Check', taskType: 'monitoring',
    host: 'secondary', model: 'qwen2.5:14b-instruct-q5_K_M',
    agent: 'main',
    schedule: { type: 'cron', cron: '0 */2 * * *', timezone: 'America/Toronto' },
    estimatedDurationMs: 120000, priority: 5, enabled: true,
    metadata: { modelAlias: 'local', delivery: 'none' }
  },
  {
    source: 'openclaw', sourceId: 'oc-morning-briefing',
    name: 'Morning Briefing', taskType: 'inference',
    host: 'secondary', model: 'qwen2.5:14b-instruct-q5_K_M',
    agent: 'main',
    schedule: { type: 'cron', cron: '0 8 * * 1-5', timezone: 'America/Toronto' },
    estimatedDurationMs: 300000, priority: 3, enabled: true,
    metadata: { modelAlias: 'local', delivery: 'telegram' }
  },
  {
    source: 'openclaw', sourceId: 'oc-memory-maintenance',
    name: 'Memory Maintenance', taskType: 'maintenance',
    host: 'secondary', model: 'qwen2.5:14b-instruct-q5_K_M',
    agent: 'main',
    schedule: { type: 'cron', cron: '0 22 * * 0,3', timezone: 'America/Toronto' },
    estimatedDurationMs: 600000, priority: 6, enabled: true,
    metadata: { modelAlias: 'local', delivery: 'none' }
  },
  {
    source: 'openclaw', sourceId: 'oc-security-audit',
    name: 'Security Audit', taskType: 'diagnostics',
    host: 'secondary', model: 'qwen2.5:14b-instruct-q5_K_M',
    agent: 'main',
    schedule: { type: 'cron', cron: '0 6 * * 1', timezone: 'America/Toronto' },
    estimatedDurationMs: 600000, priority: 4, enabled: true,
    metadata: { modelAlias: 'local', delivery: 'none' }
  },
  {
    source: 'openclaw', sourceId: 'oc-daily-analytics',
    name: 'AgentX Daily Analytics', taskType: 'diagnostics',
    host: 'secondary', model: 'qwen2.5:14b-instruct-q5_K_M',
    agent: 'main',
    schedule: { type: 'cron', cron: '0 18 * * *', timezone: 'America/Toronto' },
    estimatedDurationMs: 300000, priority: 4, enabled: true,
    metadata: { modelAlias: 'local', delivery: 'telegram' }
  },
  {
    source: 'openclaw', sourceId: 'oc-weekly-benchmark',
    name: 'AgentX Weekly Benchmark', taskType: 'benchmark',
    host: 'secondary', model: 'qwen2.5:14b-instruct-q5_K_M',
    agent: 'clawdx-coder',
    schedule: { type: 'cron', cron: '0 14 * * 6', timezone: 'America/Toronto' },
    estimatedDurationMs: 3600000, priority: 2, enabled: true,
    metadata: { modelAlias: 'local', delivery: 'telegram' }
  },
  {
    source: 'openclaw', sourceId: 'oc-rag-maintenance',
    name: 'RAG Maintenance', taskType: 'maintenance',
    host: 'secondary', model: 'qwen2.5:14b-instruct-q5_K_M',
    agent: 'clawdx-coder',
    schedule: { type: 'cron', cron: '0 3 * * 3', timezone: 'America/Toronto' },
    estimatedDurationMs: 900000, priority: 5, enabled: true,
    metadata: { modelAlias: 'local', delivery: 'none' }
  },
  {
    source: 'openclaw', sourceId: 'oc-weekly-report',
    name: 'Self-Improve Weekly Report', taskType: 'diagnostics',
    host: 'secondary', model: 'qwen2.5:14b-instruct-q5_K_M',
    agent: 'main',
    schedule: { type: 'cron', cron: '0 9 * * 1', timezone: 'America/Toronto' },
    estimatedDurationMs: 300000, priority: 4, enabled: true,
    metadata: { modelAlias: 'local', delivery: 'telegram' }
  },
  {
    source: 'openclaw', sourceId: 'oc-model-quality-watch',
    name: 'Model Quality Watch', taskType: 'diagnostics',
    host: 'secondary', model: 'qwen2.5:14b-instruct-q5_K_M',
    agent: 'thinker',
    schedule: { type: 'cron', cron: '0 20 * * *', timezone: 'America/Toronto' },
    estimatedDurationMs: 300000, priority: 4, enabled: true,
    metadata: { modelAlias: 'local', delivery: 'telegram' }
  },
  {
    source: 'openclaw', sourceId: 'oc-leantime-status',
    name: 'Leantime Daily Status', taskType: 'inference',
    host: 'secondary', model: 'qwen2.5:14b-instruct-q5_K_M',
    agent: 'main',
    schedule: { type: 'cron', cron: '30 8 * * *', timezone: 'America/Toronto' },
    estimatedDurationMs: 180000, priority: 4, enabled: true,
    metadata: { modelAlias: 'local', delivery: 'telegram' }
  },
  {
    source: 'openclaw', sourceId: 'oc-roadmap-work-cycle',
    name: 'Roadmap Driver Work Cycle', taskType: 'inference',
    host: 'tertiary', model: 'qwen32b:perf',
    agent: 'roadmap-driver',
    schedule: { type: 'cron', cron: '0 2 * * 1-5', timezone: 'America/Toronto' },
    estimatedDurationMs: 1800000, vramMb: 20000, priority: 2, enabled: true,
    metadata: { modelAlias: 'big', delivery: 'none' }
  },
  {
    source: 'openclaw', sourceId: 'oc-roadmap-bisync',
    name: 'Roadmap Driver Bisync', taskType: 'sync',
    host: 'secondary', model: 'qwen2.5:14b-instruct-q5_K_M',
    agent: 'roadmap-driver',
    schedule: { type: 'cron', cron: '0 7 * * 1-5', timezone: 'America/Toronto' },
    estimatedDurationMs: 300000, priority: 3, enabled: true,
    metadata: { modelAlias: 'local', delivery: 'telegram' }
  },

  // ── n8n Scheduled Workflows (Ubundocker 192.168.2.199) ────────
  // Source: docs/architecture/SBQC-Stack-Final/04-N8N-WORKFLOWS.md
  {
    source: 'n8n', sourceId: 'n8n-N0.1',
    name: 'N0.1 SBQC Health Dashboard', taskType: 'monitoring',
    host: null, model: null,
    schedule: { type: 'cron', cron: '*/5 * * * *', timezone: 'America/Toronto' },
    estimatedDurationMs: 15000, priority: 5, enabled: true,
    metadata: { webhook: 'sbqc-health-dashboard', runner: 'Ubundocker' }
  },
  {
    source: 'n8n', sourceId: 'n8n-N1.1',
    name: 'N1.1 System Health Check', taskType: 'monitoring',
    host: null, model: null,
    schedule: { type: 'cron', cron: '*/5 * * * *', timezone: 'America/Toronto' },
    estimatedDurationMs: 10000, priority: 4, enabled: true,
    metadata: { webhook: 'sbqc-n1-1-health-check', runner: 'Ubundocker' }
  },
  {
    source: 'n8n', sourceId: 'n8n-N2.1',
    name: 'N2.1 NAS File Scanner', taskType: 'scanning',
    host: null, model: null,
    schedule: { type: 'cron', cron: '0 2 * * *', timezone: 'America/Toronto' },
    estimatedDurationMs: 600000, priority: 3, enabled: true,
    metadata: { webhook: 'sbqc-n2-1-nas-scan', runner: 'Ubundocker' }
  },
  {
    source: 'n8n', sourceId: 'n8n-N2.2',
    name: 'N2.2 NAS Full/Other Scan', taskType: 'scanning',
    host: null, model: null,
    schedule: { type: 'cron', cron: '0 3 * * 0', timezone: 'America/Toronto' },
    estimatedDurationMs: 1800000, priority: 4, enabled: true,
    metadata: { webhook: 'sbqc-n2-2-nas-full-scan', runner: 'Ubundocker' }
  },
  {
    source: 'n8n', sourceId: 'n8n-N2.3',
    name: 'N2.3 RAG Document Ingestion', taskType: 'ingestion',
    host: null, model: null,
    schedule: { type: 'cron', cron: '0 3 * * 0', timezone: 'America/Toronto' },
    estimatedDurationMs: 900000, priority: 3, enabled: true,
    metadata: { webhook: 'sbqc-n2-3-rag-ingest', runner: 'Ubundocker' }
  },
  {
    source: 'n8n', sourceId: 'n8n-N3.1',
    name: 'N3.1 Model Health Monitor', taskType: 'monitoring',
    host: null, model: null,
    schedule: { type: 'cron', cron: '*/10 * * * *', timezone: 'America/Toronto' },
    estimatedDurationMs: 20000, priority: 5, enabled: true,
    metadata: { webhook: 'sbqc-n3-1-model-monitor', runner: 'Ubundocker' }
  },
  {
    source: 'n8n', sourceId: 'n8n-N5.1',
    name: 'N5.1 Feedback Analysis', taskType: 'diagnostics',
    host: null, model: null,
    schedule: { type: 'cron', cron: '0 3 * * 0', timezone: 'America/Toronto' },
    estimatedDurationMs: 300000, priority: 6, enabled: true,
    metadata: { webhook: 'sbqc-n5-1-feedback-analysis', runner: 'Ubundocker' }
  },

  // ── AgentX Internal Timers (UGClawdX 192.168.2.66) ─────────
  {
    source: 'agentx', sourceId: 'ax-runner-poll',
    name: 'SpecialX Runner Poll', taskType: 'monitoring',
    host: null, model: null,
    schedule: { type: 'interval', intervalMs: 5000, timezone: 'America/Toronto' },
    estimatedDurationMs: 500, priority: 1, enabled: true,
    metadata: { runner: 'Docker Host' }
  },
  {
    source: 'agentx', sourceId: 'ax-host-heartbeat',
    name: 'Host Heartbeat Collector', taskType: 'monitoring',
    host: null, model: null,
    schedule: { type: 'interval', intervalMs: 30000, timezone: 'America/Toronto' },
    estimatedDurationMs: 2000, priority: 5, enabled: true,
    metadata: { runner: 'Docker Host' }
  },
  {
    source: 'agentx', sourceId: 'ax-self-healing',
    name: 'Self-Healing Engine Tick', taskType: 'maintenance',
    host: null, model: null,
    schedule: { type: 'interval', intervalMs: 60000, timezone: 'America/Toronto' },
    estimatedDurationMs: 5000, priority: 4, enabled: true,
    metadata: { runner: 'Docker Host' }
  },
  {
    source: 'agentx', sourceId: 'ax-alert-eval',
    name: 'Alert Rule Evaluation', taskType: 'monitoring',
    host: null, model: null,
    schedule: { type: 'interval', intervalMs: 30000, timezone: 'America/Toronto' },
    estimatedDurationMs: 1000, priority: 3, enabled: true,
    metadata: { runner: 'Docker Host' }
  },
  {
    source: 'agentx', sourceId: 'ax-model-sync',
    name: 'Model Registry Sync', taskType: 'sync',
    host: null, model: null,
    schedule: { type: 'cron', cron: '*/30 * * * *', timezone: 'America/Toronto' },
    estimatedDurationMs: 60000, priority: 5, enabled: true,
    metadata: { runner: 'Docker Host' }
  },

  // ── Persistent GPU Loads (Ollama hosts) ───────────────────────
  {
    source: 'ollama-persistent', sourceId: 'gpu-ugfrank',
    name: 'UGFrank — Front-door Models', taskType: 'inference',
    host: 'primary', model: null,
    schedule: { type: 'continuous', timezone: 'America/Toronto' },
    estimatedDurationMs: null, vramMb: 12288, priority: 1, enabled: true,
    metadata: { hostName: 'UGFrank', ip: '192.168.2.99', gpu: 'RTX 3080 Ti 12GB', role: 'qwen 3b-8b, nomic-embed-text' }
  },
  {
    source: 'ollama-persistent', sourceId: 'gpu-ugbrutal',
    name: 'UGBrutal — Heavy Inference', taskType: 'inference',
    host: 'secondary', model: null,
    schedule: { type: 'continuous', timezone: 'America/Toronto' },
    estimatedDurationMs: null, vramMb: 16384, priority: 1, enabled: true,
    metadata: { hostName: 'UGBrutal', ip: '192.168.2.12', gpu: 'RTX 5070 Ti 16GB', role: 'local alias models, whisper, TTS' }
  },
  {
    source: 'ollama-persistent', sourceId: 'gpu-ugclawdx',
    name: 'UGClawdX — Dedicated AI Box', taskType: 'inference',
    host: 'tertiary', model: null,
    schedule: { type: 'continuous', timezone: 'America/Toronto' },
    estimatedDurationMs: null, vramMb: 24576, priority: 1, enabled: true,
    metadata: { hostName: 'UGClawdX', ip: '192.168.2.66', gpu: 'RTX 3090 24GB', role: '32B models, OpenClaw runtime' }
  }
];

// Stale entries from earlier seed versions — idempotent cleanup
const STALE_IDS = [
  { source: 'ollama-persistent', sourceId: 'gpu-primary-resident' },
  { source: 'ollama-persistent', sourceId: 'gpu-secondary-resident' },
  { source: 'agentx', sourceId: 'ax-model-warmup' },
];

async function seed() {
  console.log(`Connecting to ${MONGODB_URI}...`);
  await mongoose.connect(MONGODB_URI);

  const ClusterScheduleEntry = require('../models/ClusterScheduleEntry');

  // Clean stale entries from previous seed versions
  let removed = 0;
  for (const id of STALE_IDS) {
    const res = await ClusterScheduleEntry.deleteOne(id);
    if (res.deletedCount) removed++;
  }
  if (removed) console.log(`Cleaned ${removed} stale entries`);

  let created = 0, updated = 0;
  for (const entry of entries) {
    const existing = await ClusterScheduleEntry.findOne({
      source: entry.source,
      sourceId: entry.sourceId
    });

    if (!existing) {
      await ClusterScheduleEntry.create(entry);
      created++;
    } else {
      await ClusterScheduleEntry.updateOne(
        { source: entry.source, sourceId: entry.sourceId },
        { $set: entry }
      );
      updated++;
    }
  }

  console.log(`Seed complete: ${created} created, ${updated} updated (${entries.length} total)`);
  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
