#!/usr/bin/env node
/**
 * Seed SpecialX Maintenance Profiles
 *
 * Idempotent: upserts the three system-managed SpecialX profiles for
 * the maintenance pipeline. Safe to re-run; existing profiles are
 * updated if their fields have changed.
 *
 * Profiles seeded:
 *   specialx.maintenance-operator.v1  — maintenance_snapshot + maintenance_digest
 *   specialx.telemetry-aggregator.v1  — telemetry_aggregate (hourly)
 *   specialx.schedule-auditor.v1      — daily_operations_digest + schedule_reconcile
 *
 * Run: node scripts/seed-specialx-profiles.js
 */
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx';

const PROFILES = [
  {
    name: 'specialx.maintenance-operator.v1',
    displayName: 'Maintenance Operator',
    purpose: 'Runs nightly repo scans and generates maintenance digests for all managed repos.',
    description: 'System-managed profile: drives maintenance_snapshot and maintenance_digest tasks.',
    promptProfile: {
      persona: 'default_chat',
      style: 'concise',
      systemHint: 'Return structured, action-first findings. Focus on high-severity issues.'
    },
    toolPolicy: { rag: false, n8n: false, dataapi: false, repoWatcher: true, codeActions: false },
    modelPolicy: { localFirst: true, allowCloudFallback: false, maxLocalAttempts: 2, preferredTaskType: 'analysis' },
    taskTypes: ['maintenance_snapshot', 'maintenance_digest'],
    schedule: { enabled: true, cron: '0 3 * * *', timezone: 'UTC' },
    isActive: true,
    isSystem: true,
    workspaceId: null
  },
  {
    name: 'specialx.telemetry-aggregator.v1',
    displayName: 'Telemetry Aggregator',
    purpose: 'Hourly aggregation of InferenceLog records into HostUsageLedger.',
    description: 'System-managed profile: drives telemetry_aggregate tasks every hour.',
    promptProfile: { persona: 'default_chat', style: 'concise', systemHint: '' },
    toolPolicy: { rag: false, n8n: false, dataapi: true, repoWatcher: false, codeActions: false },
    modelPolicy: { localFirst: true, allowCloudFallback: false, maxLocalAttempts: 1, preferredTaskType: 'analysis' },
    taskTypes: ['telemetry_aggregate'],
    schedule: { enabled: true, cron: '0 * * * *', timezone: 'UTC' },
    isActive: true,
    isSystem: true,
    workspaceId: null
  },
  {
    name: 'specialx.schedule-auditor.v1',
    displayName: 'Schedule Auditor',
    purpose: 'Daily ops digest and schedule reconciliation across the cluster.',
    description: 'System-managed profile: drives daily_operations_digest and schedule_reconcile tasks.',
    promptProfile: {
      persona: 'default_chat',
      style: 'balanced',
      systemHint: 'Return a compact Telegram-ready digest. Bullet points, no prose.'
    },
    toolPolicy: { rag: false, n8n: true, dataapi: true, repoWatcher: true, codeActions: false },
    modelPolicy: { localFirst: true, allowCloudFallback: false, maxLocalAttempts: 2, preferredTaskType: 'analysis' },
    taskTypes: ['daily_operations_digest', 'schedule_reconcile'],
    schedule: { enabled: true, cron: '0 7 * * *', timezone: 'UTC' },
    isActive: true,
    isSystem: true,
    workspaceId: null
  }
];

async function seed() {
  console.log(`Connecting to ${MONGODB_URI}...`);
  await mongoose.connect(MONGODB_URI);

  const SpecialX = require('../models/SpecialX');

  let created = 0;
  let updated = 0;

  for (const profile of PROFILES) {
    const existing = await SpecialX.findOne({ name: profile.name, workspaceId: null });
    if (!existing) {
      await SpecialX.create(profile);
      console.log(`  ✓ Created: ${profile.name}`);
      created++;
    } else {
      await SpecialX.updateOne(
        { name: profile.name, workspaceId: null },
        {
          $set: {
            displayName: profile.displayName,
            purpose: profile.purpose,
            description: profile.description,
            promptProfile: profile.promptProfile,
            toolPolicy: profile.toolPolicy,
            modelPolicy: profile.modelPolicy,
            taskTypes: profile.taskTypes,
            schedule: profile.schedule,
            isSystem: true
          }
        }
      );
      console.log(`  ↺ Updated: ${profile.name}`);
      updated++;
    }
  }

  console.log(`\nSeed complete: ${created} created, ${updated} updated (${PROFILES.length} total)`);
  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
