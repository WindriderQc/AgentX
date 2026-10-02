'use strict';

const {
  projectBackupPolicy,
  summarizeInventory
} = require('../../src/services/backupEvidenceService');

describe('backupEvidenceService', () => {
  test('reports the bounded product defaults without implying scheduled creation', () => {
    const policy = projectBackupPolicy(
      { retentionDays: 30, retentionDaysSource: 'default' },
      {
        enabled: false,
        enabledSource: 'default',
        intervalMs: 86400000,
        intervalMsSource: 'default',
        retryDelayMs: 3600000,
        retryDelayMsSource: 'default',
        startupDelayMs: 300000,
        startupDelayMsSource: 'default'
      },
      '2026-08-28T12:00:00.000Z'
    );

    expect(policy.schedule).toMatchObject({
      enabled: false,
      anchor: 'cron',
      cron: null,
      timezone: null,
      cadence: { anchor: 'cron', cron: null, timezone: null, label: 'cadence unavailable' },
      scheduleValid: true,
      normalEveryMs: 86400000,
      normalCyclesPerDay: 0,
      logicalOperationsPerDay: 0,
      occurrence: { dueAt: null, state: 'due', attempts: 0, reason: null },
      reasons: []
    });
    expect(policy.retention).toMatchObject({
      days: 30,
      mode: 'bounded',
      automaticCleanup: true,
      enforcement: 'after each successful backup operation'
    });
    expect(policy.growthRisk.level).toBe('low');
  });

  test('makes scheduled unbounded growth and shorter failure retries explicit', () => {
    const policy = projectBackupPolicy(
      { retentionDays: 0, retentionDaysSource: 'runtime' },
      {
        enabled: true,
        enabledSource: 'env',
        intervalMs: 40 * 60 * 1000,
        intervalMsSource: 'env',
        retryDelayMs: 20 * 60 * 1000,
        retryDelayMsSource: 'env',
        startupDelayMs: 1000,
        startupDelayMsSource: 'env',
        lastStatus: 'partial'
      }
    );

    expect(policy.schedule).toMatchObject({
      normalCyclesPerDay: 36,
      logicalOperationsPerDay: 108,
      failureRetryEveryMs: 1200000
    });
    expect(policy.retention.mode).toBe('unbounded');
    expect(policy.growthRisk.level).toBe('high');
    expect(policy.growthRisk.warnings.join(' ')).toMatch(/accumulate/i);
    expect(policy.growthRisk.warnings.join(' ')).toMatch(/retry cadence/i);
  });

  test('summarizes the complete recognized inventory and labels known-size coverage', () => {
    const inventory = summarizeInventory([
      { date: '2026-08-20T00:00:00.000Z', size: 100 },
      { date: '2026-08-28T00:00:00.000Z', size: 300 },
      { date: null, size: null }
    ], {
      authority: 'core.backup-inventory.mongo',
      source: 'Core backup filesystem'
    }, '2026-08-28T12:00:00.000Z');

    expect(inventory).toMatchObject({
      count: 3,
      knownSizeCount: 2,
      totalKnownBytes: 400,
      oldestAt: '2026-08-20T00:00:00.000Z',
      newestAt: '2026-08-28T00:00:00.000Z',
      observedAt: '2026-08-28T12:00:00.000Z'
    });
    expect(inventory.countBasis).toMatch(/no date window or pagination/i);
  });
});

describe('backupEvidenceService failure evidence', () => {
  const { projectBackupPolicy: project } = require('../../src/services/backupEvidenceService');

  test('surfaces a non-retryable layer failure and the suspended retry reason', () => {
    const policy = project(
      { retentionDays: 30, retentionDaysSource: 'env' },
      {
        enabled: true,
        intervalMs: 24 * 60 * 60 * 1000,
        retryDelayMs: 60 * 60 * 1000,
        lastStatus: 'partial',
        lastCycleMode: 'full',
        nextRunReason: 'non-retryable-failure',
        consecutiveRetries: 0,
        maxRetries: 3,
        maxRetriesSource: 'default',
        lastFailures: [
          { name: 'qdrant', error: 'Recovery snapshot authorization is not configured', code: 'RECOVERY_AUTH_REQUIRED', retryable: false },
          { name: 'bogus', error: 'ignored', code: 'x', retryable: true }
        ]
      }
    );

    expect(policy.schedule.lastFailures).toEqual([
      { name: 'qdrant', error: 'Recovery snapshot authorization is not configured', code: 'RECOVERY_AUTH_REQUIRED', retryable: false }
    ]);
    expect(policy.schedule.nextRunReason).toBe('non-retryable-failure');
    expect(policy.schedule.maxRetries).toBe(3);
    expect(policy.growthRisk.level).toBe('watch');
    expect(policy.growthRisk.reasons.join(' ')).toMatch(/qdrant backup is failing with a non-retryable error/);
    expect(policy.growthRisk.warnings.join(' ')).toMatch(/RECOVERY_AUTH_REQUIRED/);
  });

  test('projects the cron anchor, time zone, cadence label, occurrence and reasons', () => {
    const policy = project(
      { retentionDays: 30, retentionDaysSource: 'env' },
      {
        enabled: true,
        anchor: 'cron',
        cron: '0 3 * * *',
        cronSource: 'default',
        timezone: 'America/Toronto',
        timezoneSource: 'env',
        scheduleValid: true,
        intervalMs: 24 * 60 * 60 * 1000,
        normalEveryMs: 24 * 60 * 60 * 1000,
        retryDelayMs: 60 * 60 * 1000,
        lastStatus: 'success',
        nextRunAt: '2026-09-23T07:00:00.000Z',
        nextRunReason: 'catch-up',
        lastAttemptAt: '2026-09-22T07:00:00.000Z',
        lastSuccessAt: '2026-09-22T07:04:00.000Z',
        lastSuccessSource: 'reconciled_from_artifact',
        occurrence: { dueAt: '2026-09-22T07:00:00.000Z', state: 'success', attempts: 1, reason: 'reconciled_from_artifact' },
        reasons: [
          'Occurrence 2026-09-22T07:00:00.000Z was reconciled from artifact agentx-a.tar.gz.',
          'ignored http://private/path',
          42
        ]
      }
    );

    expect(policy.schedule).toMatchObject({
      anchor: 'cron',
      cron: '0 3 * * *',
      cronSource: 'default',
      timezone: 'America/Toronto',
      timezoneSource: 'env',
      cadence: { anchor: 'cron', cron: '0 3 * * *', timezone: 'America/Toronto', label: 'daily at 03:00 America/Toronto' },
      normalEverySource: 'default',
      normalCyclesPerDay: 1,
      nextRunReason: 'catch-up',
      lastAttemptAt: '2026-09-22T07:00:00.000Z',
      lastSuccessAt: '2026-09-22T07:04:00.000Z',
      lastSuccessSource: 'reconciled_from_artifact',
      occurrence: { dueAt: '2026-09-22T07:00:00.000Z', state: 'success', attempts: 1, reason: 'reconciled_from_artifact' },
      reasons: ['Occurrence 2026-09-22T07:00:00.000Z was reconciled from artifact agentx-a.tar.gz.']
    });
    expect(policy.growthRisk.reasons.join(' ')).toMatch(/exactly one catch-up cycle/);
  });

  test('describes weekly and interval cadences and rejects hostile cron or time zone strings', () => {
    const { describeCadence } = require('../../src/services/backupEvidenceService');
    expect(describeCadence({ anchor: 'cron', cron: '30 2 * * 1,5', timezone: 'Europe/Paris' })).toBe('at 02:30 Europe/Paris on Mon, Fri');
    expect(describeCadence({ anchor: 'cron', cron: '*/15 * * * *', timezone: 'UTC' })).toBe('cron "*/15 * * * *" (UTC)');
    expect(describeCadence({ anchor: 'interval', intervalMs: 12 * 60 * 60 * 1000 })).toBe('every 12 h after the last successful cycle');
    const policy = project({ retentionDays: 30 }, {
      enabled: true,
      anchor: 'cron',
      cron: '0 3 * * * <script>',
      timezone: 'America/Toronto; rm -rf /',
      nextRunReason: 'startup'
    });
    expect(policy.schedule.cron).toBeNull();
    expect(policy.schedule.timezone).toBeNull();
    expect(policy.schedule.nextRunReason).toBeNull();
    expect(policy.schedule.cadence.label).toBe('cadence unavailable');
  });

  test('keeps a schedule error that quotes a cron or time zone with slashes and drops path-like or secret-like text', () => {
    const { safeScheduleError } = require('../../src/services/backupEvidenceService');
    expect(safeScheduleError('Invalid time zone "Mars/Olympus"')).toBe('Invalid time zone "Mars/Olympus"');
    expect(safeScheduleError('Invalid cron expression "*/5 * * * *": Constraint error')).toBe('Invalid cron expression "*/5 * * * *": Constraint error');
    expect(safeScheduleError('bad cron at /backups/dir')).toBeNull();
    expect(safeScheduleError('see http://private/cron')).toBeNull();
    expect(safeScheduleError('C:/backups/x')).toBeNull();
    expect(safeScheduleError('password leaked')).toBeNull();
    expect(safeScheduleError('a\\b')).toBeNull();
    expect(safeScheduleError('')).toBeNull();
    const policy = project(
      { retentionDays: 30 },
      { enabled: true, scheduleValid: false, scheduleError: 'Invalid time zone "Mars/Olympus"', nextRunReason: 'invalid-timezone' }
    );
    expect(policy.schedule).toMatchObject({ scheduleValid: false, scheduleError: 'Invalid time zone "Mars/Olympus"', nextRunReason: 'invalid-timezone' });
  });

  test('an invalid schedule is a high growth risk with an explicit reason', () => {
    const policy = project(
      { retentionDays: 30, retentionDaysSource: 'env' },
      {
        enabled: true,
        anchor: 'cron',
        cron: '99 99 * * *',
        timezone: 'UTC',
        scheduleValid: false,
        scheduleError: 'Invalid cron expression "99 99 * * *": Constraint error, got value 99 expected range 0-59',
        nextRunReason: 'invalid-cron',
        intervalMs: 24 * 60 * 60 * 1000,
        retryDelayMs: 60 * 60 * 1000
      }
    );
    expect(policy.schedule).toMatchObject({ scheduleValid: false, nextRunReason: 'invalid-cron', normalCyclesPerDay: 0, logicalOperationsPerDay: 0 });
    expect(policy.schedule.scheduleError).toMatch(/Invalid cron expression/);
    expect(policy.growthRisk.level).toBe('high');
    expect(policy.growthRisk.reasons.join(' ')).toMatch(/enabled but not running/);
  });

  test('never labels a retryable partial cycle as low risk', () => {
    const policy = project(
      { retentionDays: 30, retentionDaysSource: 'env' },
      {
        enabled: true,
        intervalMs: 24 * 60 * 60 * 1000,
        retryDelayMs: 60 * 60 * 1000,
        lastStatus: 'partial',
        nextRunReason: 'retry',
        lastFailures: [
          { name: 'mongo', error: 'temporary mongo outage', retryable: true }
        ]
      }
    );

    expect(policy.growthRisk.level).toBe('watch');
    expect(policy.growthRisk.warnings.join(' ')).toMatch(/without a fresh artifact/);
  });
});
