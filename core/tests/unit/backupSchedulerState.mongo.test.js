'use strict';

// Mongo-backed contract of the persisted backup occurrence state: the atomic
// take, the guarded completion, and the singleton document lifecycle. The
// shared Jest setup provides the in-memory MongoDB connection.

const BackupSchedulerState = require('../../models/BackupSchedulerState');
const { createMongoStateStore } = require('../../src/services/backupSchedulerState');

const DUE = new Date('2026-09-23T07:00:00.000Z');
const NEXT_DUE = new Date('2026-09-24T07:00:00.000Z');
const NOW = new Date('2026-09-23T07:00:00.250Z');
const CONFIG = { anchor: 'cron', cron: '0 3 * * *', timezone: 'America/Toronto' };

describe('backupSchedulerState Mongo store', () => {
  const store = createMongoStateStore();

  beforeEach(async () => {
    await BackupSchedulerState.deleteMany({});
  });

  afterAll(async () => {
    await BackupSchedulerState.deleteMany({});
  });

  test('load returns null on a fresh installation and the document is a singleton', async () => {
    expect(await store.load()).toBeNull();
    await store.recordManualCycle({ attemptedAt: NOW, succeededAt: NOW });
    await store.recordManualCycle({ attemptedAt: NOW, succeededAt: null });
    expect(await BackupSchedulerState.countDocuments({})).toBe(1);
    const loaded = await store.load();
    expect(loaded).toMatchObject({ lastAttemptAt: NOW, lastSuccessAt: NOW, lastSuccessSource: 'recorded', version: 2 });
    expect(loaded.occurrence.dueAt).toBeNull();
    expect((await BackupSchedulerState.findById('backup-scheduler').lean())._id).toBe('backup-scheduler');
  });

  test('two executors taking the same new occurrence: exactly one wins, even on the upsert path', async () => {
    const [alpha, beta] = await Promise.all([
      store.takeOccurrence({ dueAt: DUE, mode: 'new', reason: 'cron', owner: 'alpha', now: NOW, config: CONFIG }),
      store.takeOccurrence({ dueAt: DUE, mode: 'new', reason: 'cron', owner: 'beta', now: NOW, config: CONFIG })
    ]);
    const winners = [alpha, beta].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0].occurrence).toMatchObject({ dueAt: DUE, state: 'running', attempts: 1, cycleMode: 'full' });
    expect(['alpha', 'beta']).toContain(winners[0].occurrence.owner);
    expect(await BackupSchedulerState.countDocuments({})).toBe(1);

    // A later executor with the same occurrence cannot take it again.
    expect(await store.takeOccurrence({ dueAt: DUE, mode: 'new', reason: 'cron', owner: 'gamma', now: NOW, config: CONFIG })).toBeNull();
    // A newer occurrence can be taken once the previous one is complete.
    await store.completeOccurrence({ dueAt: DUE, state: 'success', cycleMode: 'full', results: [{ name: 'mongo', status: 'success' }], finishedAt: NOW, retry: {} });
    const next = await store.takeOccurrence({ dueAt: NEXT_DUE, mode: 'new', reason: 'cron', owner: 'gamma', now: NEXT_DUE, config: CONFIG });
    expect(next.occurrence).toMatchObject({ dueAt: NEXT_DUE, state: 'running', owner: 'gamma', attempts: 1 });
    expect(next.lastSuccessAt).toEqual(NOW);
  });

  test('completion is guarded on the running occurrence and keeps lastSuccessAt apart from lastAttemptAt', async () => {
    await store.takeOccurrence({ dueAt: DUE, mode: 'new', reason: 'cron', owner: 'alpha', now: NOW, config: CONFIG });
    const finishedAt = new Date('2026-09-23T07:04:00.000Z');
    const partial = await store.completeOccurrence({
      dueAt: DUE,
      state: 'partial',
      cycleMode: 'full',
      results: [
        { name: 'mongo', status: 'success', artifact: 'agentx-a.tar.gz' },
        { name: 'config', status: 'success', artifact: 'config-a.tar.gz' },
        { name: 'qdrant', status: 'error', error: 'rag unreachable', retryable: true }
      ],
      finishedAt,
      retry: { nextAt: new Date('2026-09-23T09:00:00.000Z'), only: ['qdrant'] }
    });
    expect(partial.occurrence).toMatchObject({ state: 'partial', finishedAt, attempts: 1 });
    expect(partial.occurrence.retry).toMatchObject({ nextAt: new Date('2026-09-23T09:00:00.000Z'), only: ['qdrant'], dropped: false });
    expect(partial.lastAttemptAt).toEqual(NOW);
    expect(partial.lastSuccessAt).toBeNull();

    // Completing again (no longer running) is refused.
    expect(await store.completeOccurrence({ dueAt: DUE, state: 'success', results: [], finishedAt, retry: {} })).toBeNull();
  });

  test('a retry take is guarded by the expected attempt count so only one executor retries', async () => {
    await store.takeOccurrence({ dueAt: DUE, mode: 'new', reason: 'cron', owner: 'alpha', now: NOW, config: CONFIG });
    await store.completeOccurrence({
      dueAt: DUE, state: 'partial', cycleMode: 'full',
      results: [{ name: 'mongo', status: 'success' }, { name: 'config', status: 'success' }, { name: 'qdrant', status: 'error', error: 'x', retryable: true }],
      finishedAt: NOW,
      retry: { nextAt: new Date('2026-09-23T09:00:00.000Z'), only: ['qdrant'] }
    });
    const retryAt = new Date('2026-09-23T09:00:00.000Z');
    const [alpha, beta] = await Promise.all([
      store.takeOccurrence({ dueAt: DUE, mode: 'retry', expectedAttempts: 1, owner: 'alpha', now: retryAt, config: CONFIG }),
      store.takeOccurrence({ dueAt: DUE, mode: 'retry', expectedAttempts: 1, owner: 'beta', now: retryAt, config: CONFIG })
    ]);
    const winners = [alpha, beta].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0].occurrence).toMatchObject({ state: 'running', cycleMode: 'retry', attempts: 2 });
    expect(winners[0].occurrence.results.map(result => result.name)).toEqual(['mongo', 'config', 'qdrant']);
    expect(winners[0].occurrence.retry.nextAt).toBeNull();

    const done = await store.completeOccurrence({
      dueAt: DUE, state: 'success', cycleMode: 'retry',
      results: [{ name: 'mongo', status: 'success', carriedForward: true }, { name: 'config', status: 'success', carriedForward: true }, { name: 'qdrant', status: 'success' }],
      finishedAt: retryAt,
      retry: {}
    });
    expect(done.occurrence).toMatchObject({ state: 'success', attempts: 2 });
    expect(done.lastSuccessAt).toEqual(retryAt);
    expect(done.lastSuccessSource).toBe('recorded');
    // A dropped retry can no longer be taken.
    await store.completeOccurrence({ dueAt: NEXT_DUE, state: 'failed', results: [], finishedAt: retryAt, retry: {} });
  });

  test('a dropped retry cannot be taken and settle reconciles an interrupted occurrence', async () => {
    await store.takeOccurrence({ dueAt: DUE, mode: 'new', reason: 'cron', owner: 'alpha', now: NOW, config: CONFIG });
    await store.completeOccurrence({
      dueAt: DUE, state: 'failed', cycleMode: 'full',
      results: [{ name: 'mongo', status: 'error', error: 'x', retryable: true }],
      finishedAt: NOW,
      retry: { nextAt: null, only: ['mongo'], dropped: true, droppedReason: 'overlaps the next occurrence' }
    });
    expect(await store.takeOccurrence({ dueAt: DUE, mode: 'retry', expectedAttempts: 1, owner: 'alpha', now: NOW, config: CONFIG })).toBeNull();

    const taken = await store.takeOccurrence({ dueAt: NEXT_DUE, mode: 'new', reason: 'cron', owner: 'alpha', now: NEXT_DUE, config: CONFIG });
    expect(taken.occurrence.state).toBe('running');
    const artifactAt = new Date('2026-09-24T07:02:00.000Z');
    const settled = await store.settleOccurrence({
      dueAt: NEXT_DUE,
      expectedState: 'running',
      state: 'success',
      results: [{ name: 'mongo', status: 'success', artifact: 'agentx-crashed.tar.gz', reconciled: true }],
      finishedAt: artifactAt,
      reason: 'reconciled_from_artifact',
      retry: { nextAt: null, only: [], dropped: false, droppedReason: '' },
      lastSuccessAt: artifactAt,
      lastSuccessSource: 'reconciled_from_artifact'
    });
    expect(settled.occurrence).toMatchObject({ state: 'success', reason: 'reconciled_from_artifact', finishedAt: artifactAt });
    expect(settled.occurrence.results[0]).toMatchObject({ name: 'mongo', reconciled: true });
    expect(settled.lastSuccessAt).toEqual(artifactAt);
    expect(settled.lastSuccessSource).toBe('reconciled_from_artifact');
    // Settling requires the expected state.
    expect(await store.settleOccurrence({ dueAt: NEXT_DUE, expectedState: 'running', state: 'failed' })).toBeNull();
  });

  test('planOccurrence records a due occurrence only when none exists', async () => {
    const planned = await store.planOccurrence({ dueAt: DUE, reason: 'interval', config: { anchor: 'interval', cron: '', timezone: 'UTC' } });
    expect(planned.occurrence).toMatchObject({ dueAt: DUE, state: 'due', attempts: 0 });
    expect(planned.anchor).toBe('interval');
    const again = await store.planOccurrence({ dueAt: NEXT_DUE, reason: 'interval', config: { anchor: 'interval' } });
    expect(again.occurrence.dueAt).toEqual(DUE);
    // The planned occurrence can be taken as a new one.
    const taken = await store.takeOccurrence({ dueAt: DUE, mode: 'new', reason: 'interval', owner: 'alpha', now: DUE, config: { anchor: 'interval' } });
    expect(taken.occurrence).toMatchObject({ dueAt: DUE, state: 'running', attempts: 1 });
  });
});
