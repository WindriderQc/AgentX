'use strict';
const {coreBackupEntry, withNativeEntries} = require('../../src/services/clusterScheduleNativeEntries');
const enabled = {enabled: true, anchor: 'cron', cron: '0 3 * * *', timezone: 'America/Toronto',
  nextRunAt: '2026-10-15T07:00:00Z', lastStartedAt: '2026-10-14T07:00:00Z', lastFinishedAt: '2026-10-14T07:02:00Z'};
test('the calendar reads the backup owner without creating another persistent schedule', () => {
  const entry = coreBackupEntry(enabled);
  expect(entry).toMatchObject({_id: 'core:backup', model: null, estimatedDurationMs: 120000,
    schedule: {type: 'cron', cron: enabled.cron, timezone: enabled.timezone},
    metadata: {requiresGpu: false, sourceAuthority: 'core.backup-scheduler', controlUrl: '/backup'}});
  expect(withNativeEntries([], {enabled: true}, enabled)).toHaveLength(1);
  expect(withNativeEntries([entry], {}, enabled)).toHaveLength(1);
});
test('paused, invalid and unrelated filtered schedules cannot acquire a projected occurrence', () => {
  expect(coreBackupEntry({...enabled, enabled: false})).toBeNull();
  expect(coreBackupEntry({...enabled, scheduleValid: false})).toBeNull();
  for (const filters of [{enabled: false}, {source: 'ollama-persistent'}, {taskType: 'inference'}, {host: 'gpu'}]) {
    expect(withNativeEntries([], filters, enabled)).toEqual([]);
  }
});
test('interval backup recurrence preserves the native next-run anchor', () => {
  const entry = coreBackupEntry({...enabled, anchor: 'interval', normalEveryMs: 86400000});
  expect(entry.schedule).toMatchObject({type: 'interval', intervalMs: 86400000});
  expect(entry.metadata.nextRunAtMs).toBe(Date.parse(enabled.nextRunAt));
});
