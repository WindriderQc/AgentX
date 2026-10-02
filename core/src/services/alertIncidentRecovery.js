'use strict';

const Alert = require('../../models/Alert');
const logger = require('../../config/logger');

async function resolveStaleAlerts(maxAgeMs) {
  const now = new Date();
  const result = await Alert.updateMany({ status: { $in: ['active', 'acknowledged'] },
    ruleId: { $nin: ['pin-vram-spill', 'pipeline-task-escalation'] },
    lastOccurrence: { $lt: new Date(now.getTime() - maxAgeMs) } },
  { $set: { status: 'resolved', 'resolution.resolved': true, 'resolution.resolvedAt': now,
    'resolution.resolvedBy': 'system', 'resolution.resolutionMethod': 'auto-stale' } });
  const count = result?.modifiedCount ?? result?.nModified ?? 0;
  if (count) logger.info('[AlertService] auto-resolved stale alerts', { count, maxAgeMs });
  return count;
}

async function resolveGpuRecovery(health) {
  if (health?.status !== 'healthy' || !health.host || !health.entries?.length
    || !health.entries.every(entry => entry.loaded && entry.status === (entry.expected || 'full'))) return 0;
  const checkedAt = new Date(health.checkedAt);
  if (!Number.isFinite(checkedAt.getTime()) || Date.now() - checkedAt.getTime() > 30_000
    || checkedAt.getTime() > Date.now() + 1000) return 0;
  const result = await Alert.updateMany({ ruleId: 'pin-vram-spill',
    status: { $in: ['active', 'acknowledged'] }, 'context.additionalData.host': health.host,
    lastOccurrence: { $lte: checkedAt } }, { $set: { status: 'resolved',
    'resolution.resolved': true, 'resolution.resolvedAt': new Date(), 'resolution.resolvedBy': 'system',
    'resolution.resolutionMethod': 'gpu-recovery-verified', 'metadata.gpuRecovery': health } });
  return result?.modifiedCount ?? 0;
}

module.exports = { resolveStaleAlerts, resolveGpuRecovery };
