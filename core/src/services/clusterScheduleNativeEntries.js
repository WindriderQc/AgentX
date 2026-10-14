'use strict';

// Read the native backup scheduler alongside the existing calendar registry.
// This is a virtual projection: no second persisted schedule or executor.
function coreBackupEntry(status = {}) {
  if (status.enabled !== true || status.scheduleValid === false) return null;
  const start = Date.parse(status.lastStartedAt), end = Date.parse(status.lastFinishedAt);
  return {_id: 'core:backup', source: 'agentx-system', sourceId: 'core:backup', name: 'Sauvegarde Core',
    taskType: 'backup', host: null, model: null, agent: null, enabled: true, priority: 5, vramMb: 0,
    lastRun: status.lastStartedAt || null,
    estimatedDurationMs: Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : null,
    schedule: status.anchor === 'interval'
      ? {type: 'interval', intervalMs: status.normalEveryMs || status.intervalMs, timezone: status.timezone}
      : {type: 'cron', cron: status.cron, timezone: status.timezone},
    metadata: {scheduler: 'core-backup', sourceAuthority: 'core.backup-scheduler', controlUrl: '/backup',
      requiresGpu: false, executionHost: 'Core', state: status.lastStatus,
      nextRunAtMs: Number.isFinite(Date.parse(status.nextRunAt)) ? Date.parse(status.nextRunAt) : null}};
}
function withNativeEntries(entries, filters = {}, status) {
  const native = coreBackupEntry(status || require('./backupSchedulerService').getStatus());
  if (!native || entries.some(entry => entry.sourceId === native.sourceId && entry.source === native.source)) return entries;
  if (['source', 'taskType', 'host', 'enabled'].some(key => filters[key] !== undefined && filters[key] !== native[key])) return entries;
  return [...entries, native];
}
module.exports = {coreBackupEntry, withNativeEntries};
