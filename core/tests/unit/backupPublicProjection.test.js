'use strict';

const {
  projectArtifacts,
  projectBackupConfig,
  projectCreatedConfig,
  projectCreatedQdrant,
  projectMutationResult
} = require('../../src/services/backupPublicProjection');

function expectNoPrivateTopology(value) {
  const forbiddenKeys = new Set([
    'path', 'localpath', 'url', 'root', 'restoredfrom', 'mongouri', 'ragurl',
    'backupdir', 'qdrantlocaldir', 'configroot', 'password', 'credential', 'token'
  ]);
  const visit = current => {
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      expect(forbiddenKeys).not.toContain(key.toLowerCase());
      if (typeof child === 'string') {
        expect(child).not.toMatch(/(?:https?:\/\/|mongodb:\/\/|[a-z]:\\|\/backups(?:\/|$)|\/qdrant(?:\/|$))/i);
      }
      visit(child);
    }
  };
  visit(value);
}

describe('backup API public projection', () => {
  const hostile = {
    name: 'agentx-one.tar.gz',
    date: '2026-08-28T00:00:00.000Z',
    timestamp: '2026-08-28T00:00:00.000Z',
    creation_time: '2026-08-28T00:00:00.000Z',
    size: 12,
    path: '/backups/agentx-one.tar.gz',
    localPath: '/backups/qdrant/one.snapshot',
    url: 'http://qdrant:6333/private',
    root: '/qdrant/storage',
    restoredFrom: '/tmp/restore/agentx',
    mongoUri: 'mongodb://user:password@mongo:27017/agentx',
    ragUrl: 'http://rag:3082',
    token: 'super-secret'
  };

  test('artifact, create, and mutation projections strip topology and secrets by construction', () => {
    const projected = {
      inventory: projectArtifacts([hostile]),
      qdrant: projectCreatedQdrant({ ...hostile, name: 'one.snapshot' }),
      mutation: projectMutationResult(hostile, { restored: true }),
      config: projectCreatedConfig({
        ...hostile,
        includes: ['docker-compose.yml', '.env', 'config/secrets.json', 'http://private/config']
      })
    };

    expect(projected.inventory[0]).toEqual({
      name: 'agentx-one.tar.gz',
      date: '2026-08-28T00:00:00.000Z',
      size: 12
    });
    expect(projected.config.sourceIds).toEqual(['base-compose']);
    expectNoPrivateTopology(projected);
  });

  test('policy evidence keeps the cron schedule fields and drops hostile schedule values', () => {
    const { projectPolicyEvidence } = require('../../src/services/backupPublicProjection');
    const evidence = projectPolicyEvidence({
      schedule: {
        enabled: true,
        anchor: 'cron',
        cron: '0 3 * * *',
        cronSource: 'env',
        timezone: 'America/Toronto',
        timezoneSource: 'env',
        scheduleValid: true,
        normalEveryMs: 86400000,
        nextRunReason: 'reconciled_from_artifact',
        lastSuccessAt: '2026-08-28T07:04:00.000Z',
        lastSuccessSource: 'reconciled_from_artifact',
        lastAttemptAt: '2026-08-28T07:00:00.000Z',
        occurrence: { dueAt: '2026-08-28T07:00:00.000Z', state: 'success', attempts: 2, reason: 'reconciled_from_artifact' },
        reasons: ['Reconciled from artifact agentx-one.tar.gz.', 'http://private/leak', 'mongodb://user:password@mongo']
      }
    });
    expect(evidence.schedule).toMatchObject({
      anchor: 'cron',
      cron: '0 3 * * *',
      timezone: 'America/Toronto',
      cadence: { label: 'daily at 03:00 America/Toronto' },
      scheduleValid: true,
      nextRunReason: 'reconciled_from_artifact',
      lastSuccessAt: '2026-08-28T07:04:00.000Z',
      lastSuccessSource: 'reconciled_from_artifact',
      lastAttemptAt: '2026-08-28T07:00:00.000Z',
      occurrence: { dueAt: '2026-08-28T07:00:00.000Z', state: 'success', attempts: 2, reason: 'reconciled_from_artifact' },
      reasons: ['Reconciled from artifact agentx-one.tar.gz.']
    });
    expectNoPrivateTopology(evidence);

    const hostile = projectPolicyEvidence({
      schedule: {
        enabled: true,
        anchor: 'weird',
        cron: '0 3 * * * $(rm -rf /)',
        timezone: '../../etc',
        scheduleValid: false,
        scheduleError: 'bad cron at /backups/secret',
        nextRunReason: 'startup',
        occurrence: { dueAt: 'nope', state: 'exploded', attempts: -3, reason: 'http://x' }
      }
    });
    expect(hostile.schedule).toMatchObject({
      anchor: 'cron',
      cron: null,
      timezone: null,
      scheduleValid: false,
      scheduleError: null,
      nextRunReason: null,
      cadence: { label: 'cadence unavailable' },
      occurrence: { dueAt: null, state: 'due', attempts: 0, reason: null }
    });
    expect(hostile.growthRisk.reasons.join(' ')).toMatch(/schedule configuration is invalid/);
    expectNoPrivateTopology(hostile);

    for (const scheduleError of ['Invalid time zone "Mars/Olympus"', 'Invalid cron expression "*/5 * * * *": Constraint error']) {
      const quoted = projectPolicyEvidence({ schedule: { enabled: true, scheduleValid: false, scheduleError, nextRunReason: 'invalid-cron' } });
      expect(quoted.schedule.scheduleError).toBe(scheduleError);
      expectNoPrivateTopology(quoted);
    }
  });

  test('sanitized config exposes logical storage and honest restore policy only', () => {
    const config = projectBackupConfig({
      ...hostile,
      retentionDays: 30,
      retentionDaysSource: 'env',
      configSources: [
        'docker-compose.yml',
        'config/agentx.env',
        '.env',
        'config/secrets.json',
        'http://private/config'
      ]
    }, {}, { enabled: false });

    expect(config).toMatchObject({
      storage: {
        kind: 'docker-named-volume',
        lifecycle: 'preserved-by-ordinary-down',
        hostLossProtection: 'separate-export-required'
      },
      configBackup: {
        sourceCount: 2,
        sourceIds: ['base-compose', 'product-defaults'],
        excludesRuntimeEnvironment: true,
        excludesSecrets: true
      },
      restorePolicy: {
        enabled: false,
        code: 'OFFLINE_RESTORE_REQUIRED',
        coherentRecoverySetVerified: false
      }
    });
    expectNoPrivateTopology(config);
  });
});
