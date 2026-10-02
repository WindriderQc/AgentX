'use strict';

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

const { createBackupScheduler } = require('../../src/services/backupSchedulerService');
const { createMemoryStateStore } = require('../../src/services/backupSchedulerState');
const { projectBackupPolicy } = require('../../src/services/backupEvidenceService');
const { projectPolicyEvidence } = require('../../src/services/backupPublicProjection');

const TZ = 'America/Toronto';

function fakeBackupService(overrides = {}) {
  return {
    createBackup: jest.fn(async () => ({ name: 'agentx-new.tar.gz' })),
    createConfigBackup: jest.fn(async () => ({ name: 'config-new.tar.gz' })),
    createQdrantBackup: jest.fn(async () => ({ name: 'qdrant.snapshot' })),
    listBackups: jest.fn(() => []),
    listConfigBackups: jest.fn(() => []),
    ...overrides
  };
}

function localClock(date, timeZone = TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date(date));
}

/**
 * Deterministic harness: injected env, backup service, timers, clock and
 * state store. `fireNext()` advances the clock to the pending timer and runs it.
 */
function createHarness({ env = {}, service = fakeBackupService(), store = createMemoryStateStore(), startAt = '2026-09-22T12:00:00Z', instanceId } = {}) {
  const clock = { at: new Date(startAt) };
  const timers = [];
  const scheduler = createBackupScheduler({
    env: {
      BACKUP_SCHEDULE_ENABLED: 'true',
      BACKUP_SCHEDULE_TZ: TZ,
      BACKUP_STARTUP_DELAY_MS: '1000',
      BACKUP_RETRY_DELAY_MS: '7200000',
      ...env
    },
    backupService: service,
    stateStore: store,
    instanceId,
    now: () => new Date(clock.at.getTime()),
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false, fired: false, unref: jest.fn() };
      timers.push(timer);
      return timer;
    },
    clearTimeout: timer => { if (timer) timer.cleared = true; }
  });
  const pending = () => timers.filter(timer => !timer.cleared && !timer.fired);
  async function fireNext() {
    const [timer] = pending();
    if (!timer) throw new Error('no pending backup timer');
    timer.fired = true;
    clock.at = new Date(clock.at.getTime() + timer.delay);
    await timer.callback();
  }
  async function start() {
    expect(scheduler.start()).toBe(true);
    await scheduler.whenReady();
  }
  const totalCycles = () => service.createBackup.mock.calls.length;
  return { scheduler, clock, timers, pending, fireNext, start, service, store, totalCycles };
}

function seededStore(overrides = {}) {
  return createMemoryStateStore({
    anchor: 'cron',
    cron: '0 3 * * *',
    timezone: TZ,
    occurrence: {
      dueAt: '2026-09-22T07:00:00.000Z',
      state: 'success',
      reason: 'cron',
      attempts: 1,
      cycleMode: 'full',
      startedAt: '2026-09-22T07:00:00.000Z',
      finishedAt: '2026-09-22T07:04:00.000Z',
      results: [
        { name: 'mongo', status: 'success', artifact: 'agentx-a.tar.gz' },
        { name: 'config', status: 'success', artifact: 'config-a.tar.gz' },
        { name: 'qdrant', status: 'success', artifact: 'q.snapshot' }
      ],
      retry: { nextAt: null, only: [], dropped: false, droppedReason: '' }
    },
    lastAttemptAt: '2026-09-22T07:00:00.000Z',
    lastSuccessAt: '2026-09-22T07:04:00.000Z',
    lastSuccessSource: 'recorded',
    ...overrides
  });
}

describe('backupSchedulerService configuration', () => {
  test('stays disabled unless explicitly enabled and reports the cron defaults', () => {
    const setTimeout = jest.fn();
    const scheduler = createBackupScheduler({ env: {}, setTimeout, stateStore: createMemoryStateStore() });

    expect(scheduler.start()).toBe(false);
    expect(setTimeout).not.toHaveBeenCalled();
    expect(scheduler.getStatus()).toMatchObject({
      enabled: false,
      lastStatus: 'never',
      enabledSource: 'default',
      intervalMsSource: 'default',
      retryDelayMsSource: 'default',
      anchor: 'cron',
      cron: '0 3 * * *',
      cronSource: 'default',
      timezone: 'UTC',
      timezoneSource: 'default',
      cadenceLabel: 'daily at 03:00 UTC',
      scheduleValid: true,
      occurrence: { dueAt: null, state: 'due', attempts: 0 }
    });
  });

  test('uses PLANNING_TIME_ZONE when BACKUP_SCHEDULE_TZ is not set', () => {
    const scheduler = createBackupScheduler({ env: { PLANNING_TIME_ZONE: TZ }, stateStore: createMemoryStateStore() });
    expect(scheduler.getStatus()).toMatchObject({ timezone: TZ, timezoneSource: 'env', cadenceLabel: `daily at 03:00 ${TZ}` });
  });

  test('an invalid cron expression disables scheduling with a clear reason instead of throwing', async () => {
    const harness = createHarness({ env: { BACKUP_SCHEDULE_CRON: '99 99 * * *' } });

    expect(harness.scheduler.start()).toBe(false);
    await harness.scheduler.whenReady();
    const status = harness.scheduler.getStatus();
    expect(harness.pending()).toHaveLength(0);
    expect(status.enabled).toBe(true);
    expect(status.scheduleValid).toBe(false);
    expect(status.nextRunAt).toBeNull();
    expect(status.nextRunReason).toBe('invalid-cron');
    expect(status.scheduleError).toMatch(/Invalid cron expression "99 99 \* \* \*"/);
    expect(status.reasons.join(' ')).toMatch(/not scheduled until the configuration is fixed/);
    expect(harness.totalCycles()).toBe(0);
  });

  test('an invalid time zone disables scheduling with its own reason', () => {
    const harness = createHarness({ env: { BACKUP_SCHEDULE_TZ: 'Mars/Olympus' } });
    expect(harness.scheduler.start()).toBe(false);
    expect(harness.scheduler.getStatus()).toMatchObject({ nextRunReason: 'invalid-timezone', scheduleValid: false });
  });

  test('runNow runs Mongo, config, and Qdrant as one cycle and records the success apart from the attempt', async () => {
    const harness = createHarness();
    const result = await harness.scheduler.runNow();

    expect(harness.service.createBackup).toHaveBeenCalledTimes(1);
    expect(harness.service.createConfigBackup).toHaveBeenCalledTimes(1);
    expect(harness.service.createQdrantBackup).toHaveBeenCalledTimes(1);
    expect(result.lastStatus).toBe('success');
    expect(result.results.map(entry => entry.name)).toEqual(['mongo', 'config', 'qdrant']);
    expect(result.lastAttemptAt).toBe('2026-09-22T12:00:00.000Z');
    expect(result.lastSuccessAt).toBe('2026-09-22T12:00:00.000Z');
    expect(harness.store.peek().lastSuccessSource).toBe('recorded');
  });
});

describe('backupSchedulerService cron anchor', () => {
  test('a fresh installation waits for the next cron occurrence instead of running at startup', async () => {
    const harness = createHarness();
    await harness.start();

    const status = harness.scheduler.getStatus();
    expect(harness.totalCycles()).toBe(0);
    expect(status.nextRunAt).toBe('2026-09-23T07:00:00.000Z');
    expect(localClock(status.nextRunAt)).toBe('03:00');
    expect(status.nextRunReason).toBe('cron');
    expect(status.anchor).toBe('cron');
    expect(status.reasons.join(' ')).toMatch(/not at startup/);
    expect(harness.pending()[0].delay).toBe(19 * 60 * 60 * 1000);

    await harness.fireNext();

    expect(harness.totalCycles()).toBe(1);
    expect(harness.scheduler.getStatus()).toMatchObject({
      lastStatus: 'success',
      lastCycleMode: 'full',
      lastSuccessAt: '2026-09-23T07:00:00.000Z',
      lastSuccessSource: 'recorded',
      occurrence: { dueAt: '2026-09-23T07:00:00.000Z', state: 'success', attempts: 1, reason: 'cron' },
      nextRunAt: '2026-09-24T07:00:00.000Z',
      nextRunReason: 'cron'
    });
    expect(harness.store.peek().occurrence.results.map(entry => entry.name)).toEqual(['mongo', 'config', 'qdrant']);
  });

  test('five scheduler rebuilds within one hour cause zero extra cycles', async () => {
    const store = seededStore();
    let cycles = 0;
    let previousNext = null;
    for (let rebuild = 0; rebuild < 5; rebuild += 1) {
      const harness = createHarness({ store, startAt: new Date(Date.parse('2026-09-22T12:00:00Z') + rebuild * 12 * 60 * 1000).toISOString() });
      await harness.start();
      cycles += harness.totalCycles();
      const status = harness.scheduler.getStatus();
      expect(status.nextRunReason).toBe('cron');
      expect(status.nextRunAt).toBe('2026-09-23T07:00:00.000Z');
      expect(status.lastStatus).toBe('success');
      expect(status.lastSuccessAt).toBe('2026-09-22T07:04:00.000Z');
      if (previousNext) expect(status.nextRunAt).toBe(previousNext);
      previousNext = status.nextRunAt;
      harness.scheduler.stop();
    }
    expect(cycles).toBe(0);
  });

  test('several missed occurrences cause exactly one catch-up, then the cron anchor resumes', async () => {
    const store = seededStore({
      occurrence: {
        dueAt: '2026-09-18T07:00:00.000Z', state: 'success', reason: 'cron', attempts: 1, cycleMode: 'full',
        startedAt: '2026-09-18T07:00:00.000Z', finishedAt: '2026-09-18T07:03:00.000Z',
        results: [{ name: 'mongo', status: 'success' }, { name: 'config', status: 'success' }, { name: 'qdrant', status: 'success' }],
        retry: { nextAt: null, only: [], dropped: false, droppedReason: '' }
      },
      lastSuccessAt: '2026-09-18T07:03:00.000Z'
    });
    const harness = createHarness({ store });
    await harness.start();

    expect(harness.scheduler.getStatus()).toMatchObject({ nextRunReason: 'catch-up', nextRunAt: '2026-09-22T12:00:01.000Z' });
    expect(harness.scheduler.getStatus().reasons.join(' ')).toMatch(/running one catch-up/);
    expect(harness.pending()[0].delay).toBe(1000);

    await harness.fireNext();

    expect(harness.totalCycles()).toBe(1);
    expect(harness.scheduler.getStatus()).toMatchObject({
      occurrence: { dueAt: '2026-09-22T07:00:00.000Z', state: 'success', reason: 'catch-up' },
      nextRunAt: '2026-09-23T07:00:00.000Z',
      nextRunReason: 'cron'
    });
    expect(harness.pending()).toHaveLength(1);
  });

  test('the next occurrence stays at 03:00 local across both DST changes in America/Toronto', async () => {
    const spring = createHarness({ startAt: '2026-03-07T12:00:00Z' });
    await spring.start();
    expect(spring.scheduler.getStatus().nextRunAt).toBe('2026-03-08T07:00:00.000Z');
    expect(localClock('2026-03-08T07:00:00.000Z')).toBe('03:00');
    await spring.fireNext();
    expect(spring.scheduler.getStatus().nextRunAt).toBe('2026-03-09T07:00:00.000Z');
    expect(localClock('2026-03-09T07:00:00.000Z')).toBe('03:00');
    expect(spring.totalCycles()).toBe(1);

    const fall = createHarness({ startAt: '2026-10-31T12:00:00Z' });
    await fall.start();
    expect(fall.scheduler.getStatus().nextRunAt).toBe('2026-11-01T08:00:00.000Z');
    expect(localClock('2026-11-01T08:00:00.000Z')).toBe('03:00');
    await fall.fireNext();
    expect(fall.scheduler.getStatus().nextRunAt).toBe('2026-11-02T08:00:00.000Z');
    expect(localClock('2026-11-02T08:00:00.000Z')).toBe('03:00');
  });

  test('a stale plan runs the latest occurrence that became due instead of an older one', async () => {
    const store = seededStore({
      occurrence: {
        dueAt: '2026-09-20T07:00:00.000Z', state: 'success', reason: 'cron', attempts: 1, cycleMode: 'full',
        startedAt: '2026-09-20T07:00:00.000Z', finishedAt: '2026-09-20T07:03:00.000Z',
        results: [{ name: 'mongo', status: 'success' }, { name: 'config', status: 'success' }, { name: 'qdrant', status: 'success' }],
        retry: { nextAt: null, only: [], dropped: false, droppedReason: '' }
      },
      lastSuccessAt: '2026-09-20T07:03:00.000Z'
    });
    // Start just before an occurrence with a long startup grace: the catch-up
    // planned for 09-21 fires after 09-22 03:00 local has also passed.
    const harness = createHarness({ store, startAt: '2026-09-22T06:59:00Z', env: { BACKUP_STARTUP_DELAY_MS: '120000' } });
    await harness.start();
    expect(harness.scheduler.getStatus().nextRunReason).toBe('catch-up');

    await harness.fireNext();

    expect(harness.totalCycles()).toBe(1);
    expect(harness.scheduler.getStatus().occurrence.dueAt).toBe('2026-09-22T07:00:00.000Z');
    expect(harness.scheduler.getStatus().nextRunAt).toBe('2026-09-23T07:00:00.000Z');
  });
});

describe('backupSchedulerService retry discipline', () => {
  test('a retry re-runs only the failed layer, survives a restart, and never moves the anchor', async () => {
    let qdrantAttempts = 0;
    const store = createMemoryStateStore();
    const service = fakeBackupService({
      createQdrantBackup: jest.fn(async () => {
        qdrantAttempts += 1;
        if (qdrantAttempts === 1) throw new Error('rag unreachable');
        return { name: 'qdrant.snapshot' };
      })
    });
    const first = createHarness({ store, service });
    await first.start();
    await first.fireNext(); // 09-23 03:00 local: qdrant fails

    let status = first.scheduler.getStatus();
    expect(status.lastStatus).toBe('partial');
    expect(status.lastFailures).toEqual([{ name: 'qdrant', error: 'rag unreachable', code: null, retryable: true }]);
    expect(status.nextRunReason).toBe('retry');
    expect(status.nextRunAt).toBe('2026-09-23T09:00:00.000Z');
    expect(status.consecutiveRetries).toBe(1);
    expect(status.lastSuccessAt).toBeNull();
    expect(status.lastAttemptAt).toBe('2026-09-23T07:00:00.000Z');
    expect(store.peek().occurrence.retry).toMatchObject({ nextAt: new Date('2026-09-23T09:00:00.000Z'), only: ['qdrant'], dropped: false });
    first.scheduler.stop();

    // Core restarts ten minutes later: the persisted retry resumes; no new full cycle.
    const second = createHarness({ store, service, startAt: '2026-09-23T07:10:00Z' });
    await second.start();
    status = second.scheduler.getStatus();
    expect(status.lastStatus).toBe('partial');
    expect(status.nextRunReason).toBe('retry');
    expect(status.nextRunAt).toBe('2026-09-23T09:00:00.000Z');
    expect(status.reasons.join(' ')).toMatch(/anchor is unchanged/);
    expect(service.createBackup).toHaveBeenCalledTimes(1);

    await second.fireNext(); // retry cycle

    expect(service.createBackup).toHaveBeenCalledTimes(1);
    expect(service.createConfigBackup).toHaveBeenCalledTimes(1);
    expect(service.createQdrantBackup).toHaveBeenCalledTimes(2);
    status = second.scheduler.getStatus();
    expect(status.lastCycleMode).toBe('retry');
    expect(status.lastStatus).toBe('success');
    expect(status.results.map(r => [r.name, r.status, r.carriedForward === true])).toEqual([
      ['mongo', 'success', true],
      ['config', 'success', true],
      ['qdrant', 'success', false]
    ]);
    expect(status.occurrence).toMatchObject({ dueAt: '2026-09-23T07:00:00.000Z', state: 'success', attempts: 2 });
    expect(status.lastSuccessAt).toBe('2026-09-23T09:00:00.000Z');
    expect(status.nextRunReason).toBe('cron');
    expect(status.nextRunAt).toBe('2026-09-24T07:00:00.000Z');
    expect(status.consecutiveRetries).toBe(0);
  });

  test('a non-retryable failure (missing recovery auth) waits for the next occurrence', async () => {
    const service = fakeBackupService({
      createQdrantBackup: jest.fn(async () => {
        throw Object.assign(new Error('Recovery snapshot authorization is not configured'), { code: 'RECOVERY_AUTH_REQUIRED' });
      })
    });
    const harness = createHarness({ service });
    await harness.start();
    await harness.fireNext();

    const status = harness.scheduler.getStatus();
    expect(status.lastStatus).toBe('partial');
    expect(status.lastFailures[0]).toMatchObject({ name: 'qdrant', code: 'RECOVERY_AUTH_REQUIRED', retryable: false });
    expect(status.nextRunReason).toBe('non-retryable-failure');
    expect(status.nextRunAt).toBe('2026-09-24T07:00:00.000Z');
    expect(harness.store.peek().occurrence.retry.nextAt).toBeNull();
    expect(service.createBackup).toHaveBeenCalledTimes(1);
  });

  test('a retry preserves a different non-retryable layer failure', async () => {
    let mongoAttempts = 0;
    const service = fakeBackupService({
      createBackup: jest.fn(async () => {
        mongoAttempts += 1;
        if (mongoAttempts === 1) throw new Error('temporary mongo outage');
        return { name: 'agentx-new.tar.gz' };
      }),
      createQdrantBackup: jest.fn(async () => {
        throw Object.assign(new Error('Recovery snapshot authorization is not configured'), { code: 'RECOVERY_AUTH_REQUIRED' });
      })
    });
    const harness = createHarness({ service });
    await harness.start();
    await harness.fireNext(); // full cycle: Mongo retryable, Qdrant blocked
    expect(harness.scheduler.getStatus().lastFailures.map(entry => entry.name)).toEqual(['mongo', 'qdrant']);
    expect(harness.scheduler.getStatus().nextRunReason).toBe('retry');

    await harness.fireNext(); // retry Mongo only
    const status = harness.scheduler.getStatus();
    expect(service.createBackup).toHaveBeenCalledTimes(2);
    expect(service.createConfigBackup).toHaveBeenCalledTimes(1);
    expect(service.createQdrantBackup).toHaveBeenCalledTimes(1);
    expect(status.lastCycleMode).toBe('retry');
    expect(status.lastStatus).toBe('partial');
    expect(status.results.map(result => [result.name, result.status, result.carriedForward === true])).toEqual([
      ['mongo', 'success', false],
      ['config', 'success', true],
      ['qdrant', 'error', true]
    ]);
    expect(status.lastFailures).toEqual([{
      name: 'qdrant',
      error: 'Recovery snapshot authorization is not configured',
      code: 'RECOVERY_AUTH_REQUIRED',
      retryable: false
    }]);
    expect(status.nextRunReason).toBe('non-retryable-failure');
    expect(status.nextRunAt).toBe('2026-09-24T07:00:00.000Z');
  });

  test('the retry budget is bounded and then falls back to the cron occurrence', async () => {
    const service = fakeBackupService({
      createQdrantBackup: jest.fn(async () => { throw new Error('rag unreachable'); })
    });
    const harness = createHarness({ service, env: { BACKUP_MAX_RETRIES: '2', BACKUP_RETRY_DELAY_MS: '600000' } });
    await harness.start();
    await harness.fireNext(); // occurrence → retry #1 scheduled
    expect(harness.scheduler.getStatus().consecutiveRetries).toBe(1);
    await harness.fireNext(); // retry #1 → retry #2 scheduled
    expect(harness.scheduler.getStatus().consecutiveRetries).toBe(2);
    await harness.fireNext(); // retry #2 → budget exhausted

    const status = harness.scheduler.getStatus();
    expect(status.nextRunReason).toBe('retry-exhausted');
    expect(status.nextRunAt).toBe('2026-09-24T07:00:00.000Z');
    expect(status.consecutiveRetries).toBe(0);
    expect(status.occurrence).toMatchObject({ dueAt: '2026-09-23T07:00:00.000Z', state: 'partial', attempts: 3 });
    expect(status.lastSuccessAt).toBeNull();
    // Mongo and config were created once, not once per retry.
    expect(service.createBackup).toHaveBeenCalledTimes(1);
    expect(service.createConfigBackup).toHaveBeenCalledTimes(1);
    expect(service.createQdrantBackup).toHaveBeenCalledTimes(3);
  });

  test('a retry that would overlap the next occurrence is dropped and the next occurrence wins', async () => {
    const service = fakeBackupService({
      createQdrantBackup: jest.fn(async () => { throw new Error('rag unreachable'); })
    });
    const harness = createHarness({ service, env: { BACKUP_RETRY_DELAY_MS: String(25 * 60 * 60 * 1000) } });
    await harness.start();
    await harness.fireNext();

    const status = harness.scheduler.getStatus();
    expect(status.lastStatus).toBe('partial');
    expect(status.nextRunReason).toBe('retry-dropped');
    expect(status.nextRunAt).toBe('2026-09-24T07:00:00.000Z');
    expect(harness.store.peek().occurrence.retry).toMatchObject({ dropped: true, nextAt: null });
    expect(harness.store.peek().occurrence.retry.droppedReason).toMatch(/overlap the next occurrence at 2026-09-24T07:00:00.000Z/);
    expect(harness.pending()).toHaveLength(1);
  });
});

describe('backupSchedulerService executors and state recovery', () => {
  test('two executors racing for one occurrence: exactly one runs it', async () => {
    const store = createMemoryStateStore();
    const alpha = createHarness({ store, instanceId: 'alpha' });
    const beta = createHarness({ store, instanceId: 'beta' });
    await alpha.start();
    await beta.start();
    expect(alpha.scheduler.getStatus().nextRunAt).toBe('2026-09-23T07:00:00.000Z');
    expect(beta.scheduler.getStatus().nextRunAt).toBe('2026-09-23T07:00:00.000Z');

    await alpha.fireNext();
    await beta.fireNext();

    expect(alpha.totalCycles()).toBe(1);
    expect(beta.totalCycles()).toBe(0);
    expect(store.peek().occurrence).toMatchObject({ dueAt: new Date('2026-09-23T07:00:00.000Z'), state: 'success', owner: 'alpha', attempts: 1 });
    expect(beta.scheduler.getStatus().reasons.join(' ')).toMatch(/already taken by another executor/);
    expect(beta.scheduler.getStatus().nextRunAt).toBe('2026-09-24T07:00:00.000Z');
    expect(beta.scheduler.getStatus().lastStatus).toBe('success');
  });

  test('Mongo state unavailable at start derives the last success from the newest artifact', async () => {
    const recent = createHarness({
      store: createMemoryStateStore(null, { unavailable: true }),
      service: fakeBackupService({
        listBackups: jest.fn(() => [
          { name: 'agentx-old.tar.gz', date: '2026-09-20T07:02:00.000Z', size: 1 },
          { name: 'agentx-latest.tar.gz', date: '2026-09-22T07:03:00.000Z', size: 1 }
        ])
      })
    });
    await recent.start();
    expect(recent.totalCycles()).toBe(0);
    expect(recent.scheduler.getStatus()).toMatchObject({
      stateStore: 'unavailable',
      lastSuccessAt: '2026-09-22T07:03:00.000Z',
      lastSuccessSource: 'artifact',
      nextRunReason: 'cron',
      nextRunAt: '2026-09-23T07:00:00.000Z'
    });
    expect(recent.scheduler.getStatus().reasons.join(' ')).toMatch(/agentx-latest\.tar\.gz/);

    const stale = createHarness({
      store: createMemoryStateStore(null, { unavailable: true }),
      service: fakeBackupService({ listBackups: jest.fn(() => [{ name: 'agentx-old.tar.gz', date: '2026-09-19T07:02:00.000Z', size: 1 }]) })
    });
    await stale.start();
    expect(stale.scheduler.getStatus()).toMatchObject({ nextRunReason: 'catch-up', lastSuccessSource: 'artifact' });
    // The catch-up is planned, but the store must witness the take: while it
    // is still unavailable nothing runs and the plan is re-attempted.
    await stale.fireNext();
    expect(stale.totalCycles()).toBe(0);
    expect(stale.scheduler.getStatus()).toMatchObject({ nextRunReason: 'catch-up', stateStore: 'unavailable' });
    stale.store.setUnavailable(false);
    await stale.fireNext();
    expect(stale.totalCycles()).toBe(1);
    expect(stale.scheduler.getStatus()).toMatchObject({ lastStatus: 'success', nextRunAt: '2026-09-23T07:00:00.000Z', nextRunReason: 'cron', stateStore: 'memory' });
    expect(stale.store.peek().occurrence).toMatchObject({ dueAt: new Date('2026-09-22T07:00:00.000Z'), state: 'success' });

    const empty = createHarness({ store: createMemoryStateStore(null, { unavailable: true }) });
    await empty.start();
    expect(empty.totalCycles()).toBe(0);
    expect(empty.scheduler.getStatus()).toMatchObject({ stateStore: 'unavailable', nextRunReason: 'cron', nextRunAt: '2026-09-23T07:00:00.000Z' });
    expect(empty.scheduler.getStatus().reasons.join(' ')).toMatch(/no artifact/);
  });

  test('a crash after the archive was written is reconciled from the artifact, not re-run', async () => {
    const store = seededStore({
      occurrence: {
        dueAt: '2026-09-22T07:00:00.000Z', state: 'running', reason: 'cron', attempts: 1, cycleMode: 'full',
        startedAt: '2026-09-22T07:00:00.000Z', finishedAt: null, results: [],
        retry: { nextAt: null, only: [], dropped: false, droppedReason: '' }
      },
      lastAttemptAt: '2026-09-22T07:00:00.000Z',
      lastSuccessAt: '2026-09-21T07:04:00.000Z'
    });
    const harness = createHarness({
      store,
      service: fakeBackupService({
        listBackups: jest.fn(() => [{ name: 'agentx-crashed.tar.gz', date: '2026-09-22T07:02:30.000Z', size: 1 }]),
        listConfigBackups: jest.fn(() => [{ name: 'config-crashed.tar.gz', date: '2026-09-22T07:02:40.000Z', size: 1 }])
      })
    });
    await harness.start();

    expect(harness.totalCycles()).toBe(0);
    const status = harness.scheduler.getStatus();
    expect(status.occurrence).toMatchObject({ dueAt: '2026-09-22T07:00:00.000Z', state: 'success', reason: 'reconciled_from_artifact' });
    expect(status.lastStatus).toBe('success');
    expect(status.lastSuccessAt).toBe('2026-09-22T07:02:30.000Z');
    expect(status.lastSuccessSource).toBe('reconciled_from_artifact');
    expect(status.results.map(result => [result.name, result.reconciled === true])).toEqual([['mongo', true], ['config', true]]);
    expect(status.nextRunReason).toBe('cron');
    expect(status.nextRunAt).toBe('2026-09-23T07:00:00.000Z');
    expect(status.reasons.join(' ')).toMatch(/reconciled from that artifact/);
  });

  test('a crash before any archive was written re-runs the occurrence once after the startup grace', async () => {
    const store = seededStore({
      occurrence: {
        dueAt: '2026-09-22T07:00:00.000Z', state: 'running', reason: 'cron', attempts: 1, cycleMode: 'full',
        startedAt: '2026-09-22T07:00:00.000Z', finishedAt: null, results: [],
        retry: { nextAt: null, only: [], dropped: false, droppedReason: '' }
      },
      lastSuccessAt: '2026-09-21T07:04:00.000Z'
    });
    const harness = createHarness({
      store,
      service: fakeBackupService({ listBackups: jest.fn(() => [{ name: 'agentx-yesterday.tar.gz', date: '2026-09-21T07:02:30.000Z', size: 1 }]) })
    });
    await harness.start();

    expect(harness.scheduler.getStatus()).toMatchObject({
      occurrence: { dueAt: '2026-09-22T07:00:00.000Z', state: 'failed', reason: 'interrupted', attempts: 1 },
      nextRunReason: 'retry',
      nextRunAt: '2026-09-22T12:00:01.000Z'
    });
    await harness.fireNext();

    expect(harness.totalCycles()).toBe(1);
    expect(harness.service.createQdrantBackup).toHaveBeenCalledTimes(1);
    expect(harness.scheduler.getStatus()).toMatchObject({
      occurrence: { dueAt: '2026-09-22T07:00:00.000Z', state: 'success', attempts: 2 },
      nextRunReason: 'cron',
      nextRunAt: '2026-09-23T07:00:00.000Z'
    });
  });
});

describe('backupSchedulerService state store outages', () => {
  const { STORE_RETRY_MS } = require('../../src/services/backupSchedulerService');

  test('a store error at take time never runs an unguarded cycle; the plan is re-attempted once the store is back', async () => {
    const harness = createHarness();
    await harness.start();
    harness.store.setUnavailable(true);

    await harness.fireNext(); // 09-23 03:00 local: the take fails

    expect(harness.totalCycles()).toBe(0);
    let status = harness.scheduler.getStatus();
    expect(status.stateStore).toBe('unavailable');
    expect(status.nextRunReason).toBe('cron');
    expect(status.nextRunAt).toBe(new Date(Date.parse('2026-09-23T07:00:00Z') + STORE_RETRY_MS).toISOString());
    expect(status.reasons.join(' ')).toMatch(/not taken: state store unavailable/);
    expect(harness.pending()).toHaveLength(1);
    expect(harness.pending()[0].delay).toBe(STORE_RETRY_MS);

    harness.store.setUnavailable(false);
    await harness.fireNext();

    expect(harness.totalCycles()).toBe(1);
    status = harness.scheduler.getStatus();
    expect(status.stateStore).toBe('memory');
    expect(status.occurrence).toMatchObject({ dueAt: '2026-09-23T07:00:00.000Z', state: 'success', attempts: 1 });
    expect(harness.store.peek().occurrence).toMatchObject({ state: 'success', attempts: 1, owner: expect.any(String) });
    expect(status.nextRunReason).toBe('cron');
    expect(status.nextRunAt).toBe('2026-09-24T07:00:00.000Z');
  });

  test('a store error after the cycle keeps the completion pending and never re-plans a catch-up for the same occurrence', async () => {
    const harness = createHarness();
    harness.service.createBackup.mockImplementation(async () => {
      harness.store.setUnavailable(true); // the store goes away during the cycle
      return { name: 'agentx-new.tar.gz' };
    });
    await harness.start();

    await harness.fireNext();

    expect(harness.totalCycles()).toBe(1);
    let status = harness.scheduler.getStatus();
    expect(status.lastStatus).toBe('success');
    expect(status.completionPending).toBe(true);
    expect(status.nextRunAt).toBeNull();
    expect(status.nextRunReason).toBeNull();
    expect(status.reasons.join(' ')).toMatch(/not recorded yet/);
    expect(harness.pending()).toHaveLength(1);
    expect(harness.pending()[0].delay).toBe(STORE_RETRY_MS);
    expect(harness.store.peek().occurrence.state).toBe('running');

    harness.store.setUnavailable(false);
    await harness.fireNext(); // completion retry, not a cycle

    expect(harness.totalCycles()).toBe(1);
    status = harness.scheduler.getStatus();
    expect(status.completionPending).toBe(false);
    expect(harness.store.peek().occurrence).toMatchObject({ dueAt: new Date('2026-09-23T07:00:00.000Z'), state: 'success' });
    expect(harness.store.peek().lastSuccessAt).toEqual(new Date('2026-09-23T07:00:00.000Z'));
    expect(status.nextRunReason).toBe('cron');
    expect(status.nextRunAt).toBe('2026-09-24T07:00:00.000Z');
    expect(status.reasons.join(' ')).not.toMatch(/catch-up/);
  });

  test('a pending completion is recorded at the next start before anything is planned', async () => {
    const harness = createHarness();
    harness.service.createBackup.mockImplementation(async () => {
      harness.store.setUnavailable(true);
      return { name: 'agentx-new.tar.gz' };
    });
    await harness.start();
    await harness.fireNext();
    expect(harness.scheduler.getStatus().completionPending).toBe(true);
    harness.scheduler.stop();
    expect(harness.pending()).toHaveLength(0);

    harness.store.setUnavailable(false);
    expect(harness.scheduler.start()).toBe(true);
    await harness.scheduler.whenReady();

    expect(harness.totalCycles()).toBe(1);
    expect(harness.store.peek().occurrence.state).toBe('success');
    expect(harness.scheduler.getStatus()).toMatchObject({ completionPending: false, nextRunReason: 'cron', nextRunAt: '2026-09-24T07:00:00.000Z' });
    expect(harness.scheduler.getStatus().reasons.join(' ')).toMatch(/kept from the previous run/);
  });

  test('a store blip cannot make two executors run the same occurrence', async () => {
    const store = createMemoryStateStore();
    const alpha = createHarness({ store, instanceId: 'alpha' });
    const beta = createHarness({ store, instanceId: 'beta' });
    await alpha.start();
    await beta.start();
    store.setUnavailable(true);

    await alpha.fireNext();
    await beta.fireNext();
    expect(alpha.totalCycles() + beta.totalCycles()).toBe(0);

    store.setUnavailable(false);
    await alpha.fireNext();
    await beta.fireNext();

    expect(alpha.totalCycles() + beta.totalCycles()).toBe(1);
    expect(store.peek().occurrence).toMatchObject({ dueAt: new Date('2026-09-23T07:00:00.000Z'), state: 'success', attempts: 1 });
  });
});

describe('backupSchedulerService stop and start while in flight', () => {
  function gatedService() {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const service = fakeBackupService({ createBackup: jest.fn(async () => { await gate; return { name: 'agentx-new.tar.gz' }; }) });
    return { service, release };
  }

  async function untilRunning(harness) {
    for (let attempt = 0; attempt < 50 && !harness.scheduler.getStatus().running; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(harness.scheduler.getStatus().running).toBe(true);
  }

  test('start() after stop() during a cycle re-arms the scheduler when the cycle ends', async () => {
    const { service, release } = gatedService();
    const harness = createHarness({ service });
    await harness.start();

    const inFlight = harness.fireNext();
    await untilRunning(harness);
    harness.scheduler.stop(); // leader demoted mid-cycle...
    expect(harness.scheduler.start()).toBe(true); // ...and re-promoted before it ends
    release();
    await inFlight;

    expect(harness.totalCycles()).toBe(1);
    expect(harness.scheduler.getStatus()).toMatchObject({ lastStatus: 'success', nextRunReason: 'cron', nextRunAt: '2026-09-24T07:00:00.000Z' });
    expect(harness.pending()).toHaveLength(1);
  });

  test('stop() alone leaves nothing armed after the in-flight cycle, and a later start() does not re-run it', async () => {
    const { service, release } = gatedService();
    const harness = createHarness({ service });
    await harness.start();

    const inFlight = harness.fireNext();
    await untilRunning(harness);
    harness.scheduler.stop();
    release();
    await inFlight;

    expect(harness.pending()).toHaveLength(0);
    expect(harness.scheduler.getStatus().nextRunAt).toBeNull();

    expect(harness.scheduler.start()).toBe(true);
    await harness.scheduler.whenReady();
    expect(harness.totalCycles()).toBe(1);
    expect(harness.scheduler.getStatus()).toMatchObject({ nextRunReason: 'cron', nextRunAt: '2026-09-24T07:00:00.000Z' });
    expect(harness.pending()).toHaveLength(1);
  });

  test('start() after stop() during the bootstrap re-arms the scheduler when the bootstrap ends', async () => {
    const base = createMemoryStateStore();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const store = { ...base, load: async () => { await gate; return base.load(); } };
    const harness = createHarness({ store });

    expect(harness.scheduler.start()).toBe(true);
    harness.scheduler.stop();
    expect(harness.scheduler.start()).toBe(true);
    release();
    await harness.scheduler.whenReady();

    expect(harness.totalCycles()).toBe(0);
    expect(harness.scheduler.getStatus()).toMatchObject({ nextRunReason: 'cron', nextRunAt: '2026-09-23T07:00:00.000Z' });
    expect(harness.pending()).toHaveLength(1);
  });
});

describe('backupSchedulerService status details', () => {
  const logger = require('../../config/logger');
  beforeEach(() => { logger.warn.mockClear(); });

  test('BACKUP_INTERVAL_MS under a cron anchor is reported as ignored and warned once', async () => {
    const harness = createHarness({ env: { BACKUP_INTERVAL_MS: '3600000' } });
    await harness.start();
    harness.scheduler.start(); // idempotent restart: no second warning
    const status = harness.scheduler.getStatus();
    expect(status).toMatchObject({ anchor: 'cron', intervalMs: 3600000, intervalMsSource: 'env', intervalMsIgnored: true, normalEveryMs: 86400000 });
    expect(status.reasons.join(' ')).toMatch(/BACKUP_INTERVAL_MS is ignored/);
    const warnings = logger.warn.mock.calls.filter(([message]) => /BACKUP_INTERVAL_MS is set but ignored/.test(message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toMatchObject({ cron: '0 3 * * *', intervalMs: 3600000 });
  });

  test('the interval anchor applies BACKUP_INTERVAL_MS without a warning', async () => {
    const harness = createHarness({ env: { BACKUP_SCHEDULE_CRON: '', BACKUP_INTERVAL_MS: '3600000' } });
    await harness.start();
    expect(harness.scheduler.getStatus()).toMatchObject({ anchor: 'interval', intervalMsIgnored: false, normalEveryMs: 3600000 });
    expect(logger.warn.mock.calls.some(([message]) => /BACKUP_INTERVAL_MS is set but ignored/.test(message))).toBe(false);
  });

  test('the reported cadence stays 24 h when the next occurrences cross a DST change', () => {
    for (const startAt of ['2026-03-07T12:00:00Z', '2026-10-31T12:00:00Z']) {
      expect(createHarness({ startAt }).scheduler.getStatus().normalEveryMs).toBe(86400000);
    }
  });

  test('a clock behind the last handled occurrence skips to the following occurrence instead of re-taking it', async () => {
    const store = seededStore({
      occurrence: {
        dueAt: '2026-09-23T07:00:00.000Z', state: 'success', reason: 'cron', attempts: 1, cycleMode: 'full',
        startedAt: '2026-09-23T07:00:00.000Z', finishedAt: '2026-09-23T07:04:00.000Z',
        results: [{ name: 'mongo', status: 'success' }, { name: 'config', status: 'success' }, { name: 'qdrant', status: 'success' }],
        retry: { nextAt: null, only: [], dropped: false, droppedReason: '' }
      },
      lastAttemptAt: '2026-09-23T07:00:00.000Z',
      lastSuccessAt: '2026-09-23T07:04:00.000Z'
    });
    const harness = createHarness({ store }); // the clock reads 09-22 12:00Z, before the handled occurrence
    await harness.start();

    expect(harness.totalCycles()).toBe(0);
    const status = harness.scheduler.getStatus();
    expect(status).toMatchObject({ nextRunReason: 'cron', nextRunAt: '2026-09-24T07:00:00.000Z' });
    expect(status.reasons.join(' ')).toMatch(/clock moved backwards/);
  });

  test('another executor\'s running occurrence is visible as the occurrence, not as this instance\'s last cycle status', async () => {
    const store = seededStore();
    const harness = createHarness({ store, instanceId: 'alpha' });
    await harness.start();
    expect(harness.scheduler.getStatus().lastStatus).toBe('success');

    await store.takeOccurrence({ dueAt: new Date('2026-09-23T07:00:00.000Z'), mode: 'new', reason: 'cron', owner: 'beta', now: new Date('2026-09-23T07:00:00.000Z'), config: {} });
    await harness.scheduler.refresh();

    const status = harness.scheduler.getStatus();
    expect(status.occurrence).toMatchObject({ dueAt: '2026-09-23T07:00:00.000Z', state: 'running' });
    expect(status.lastStatus).toBe('success');
    expect(status.running).toBe(false);
  });

  test('reasons keep the newest entries so a cycle does not erase the start provenance right away', async () => {
    const harness = createHarness({ store: seededStore({ occurrence: {
      dueAt: '2026-09-21T07:00:00.000Z', state: 'success', reason: 'cron', attempts: 1, cycleMode: 'full',
      startedAt: '2026-09-21T07:00:00.000Z', finishedAt: '2026-09-21T07:04:00.000Z',
      results: [{ name: 'mongo', status: 'success' }, { name: 'config', status: 'success' }, { name: 'qdrant', status: 'success' }],
      retry: { nextAt: null, only: [], dropped: false, droppedReason: '' }
    }, lastSuccessAt: '2026-09-21T07:04:00.000Z' }) });
    await harness.start();
    await harness.fireNext(); // catch-up
    const reasons = harness.scheduler.getStatus().reasons;
    expect(reasons.join(' ')).toMatch(/was missed/);
    expect(reasons.join(' ')).toMatch(/completed: success \(attempt 1\)/);
    expect(reasons[reasons.length - 1]).toMatch(/^Next run 2026-09-23T07:00:00.000Z/);
  });
});

describe('backupSchedulerService interval fallback', () => {
  test('an explicitly empty cron anchors the interval on the last success, never on process start', async () => {
    const store = createMemoryStateStore({ lastSuccessAt: '2026-09-22T11:59:55.000Z', lastSuccessSource: 'recorded' });
    const harness = createHarness({ store, env: { BACKUP_SCHEDULE_CRON: '', BACKUP_INTERVAL_MS: '9000' } });
    await harness.start();

    expect(harness.scheduler.getStatus()).toMatchObject({
      anchor: 'interval',
      cron: '',
      cronSource: 'env',
      nextRunReason: 'interval',
      nextRunAt: '2026-09-22T12:00:04.000Z'
    });
    expect(harness.scheduler.getStatus().cadenceLabel).toMatch(/^every .+ after the last successful cycle$/);
    expect(harness.pending()[0].delay).toBe(4000);
  });

  test('a fresh interval installation plans one occurrence and a restart keeps it', async () => {
    const store = createMemoryStateStore();
    const first = createHarness({ store, env: { BACKUP_SCHEDULE_CRON: '', BACKUP_INTERVAL_MS: '9000' } });
    await first.start();
    expect(first.totalCycles()).toBe(0);
    expect(first.scheduler.getStatus().nextRunAt).toBe('2026-09-22T12:00:09.000Z');
    expect(store.peek().occurrence).toMatchObject({ dueAt: new Date('2026-09-22T12:00:09.000Z'), state: 'due' });
    first.scheduler.stop();

    const second = createHarness({ store, env: { BACKUP_SCHEDULE_CRON: '', BACKUP_INTERVAL_MS: '9000' }, startAt: '2026-09-22T12:00:03Z' });
    await second.start();
    expect(second.scheduler.getStatus().nextRunAt).toBe('2026-09-22T12:00:09.000Z');
    expect(second.pending()[0].delay).toBe(6000);

    await second.fireNext();
    expect(second.totalCycles()).toBe(1);
    expect(second.scheduler.getStatus()).toMatchObject({
      occurrence: { dueAt: '2026-09-22T12:00:09.000Z', state: 'success' },
      nextRunAt: '2026-09-22T12:00:18.000Z',
      nextRunReason: 'interval'
    });
  });
});

describe('backupSchedulerService status projections', () => {
  test('the scheduler status, the evidence projection and the public projection agree', async () => {
    const harness = createHarness({ store: seededStore() });
    await harness.start();
    const status = harness.scheduler.getStatus();
    const policy = projectBackupPolicy({ retentionDays: 30, retentionDaysSource: 'env' }, status);
    const evidence = projectPolicyEvidence(policy);

    for (const schedule of [policy.schedule, evidence.schedule]) {
      expect(schedule).toMatchObject({
        enabled: true,
        anchor: 'cron',
        cron: '0 3 * * *',
        timezone: TZ,
        cadence: { anchor: 'cron', cron: '0 3 * * *', timezone: TZ, label: `daily at 03:00 ${TZ}` },
        scheduleValid: true,
        scheduleError: null,
        normalEveryMs: 86400000,
        normalCyclesPerDay: 1,
        nextRunAt: status.nextRunAt,
        nextRunReason: 'cron',
        lastSuccessAt: '2026-09-22T07:04:00.000Z',
        lastSuccessSource: 'recorded',
        lastAttemptAt: '2026-09-22T07:00:00.000Z',
        occurrence: { dueAt: '2026-09-22T07:00:00.000Z', state: 'success', attempts: 1, reason: 'cron' }
      });
      expect(schedule.reasons.join(' ')).toMatch(/Next run 2026-09-23T07:00:00.000Z/);
    }
  });

  test('an invalid cron is visible as a high-risk, unscheduled policy', () => {
    const harness = createHarness({ env: { BACKUP_SCHEDULE_CRON: 'nope' } });
    harness.scheduler.start();
    const policy = projectBackupPolicy({ retentionDays: 30, retentionDaysSource: 'env' }, harness.scheduler.getStatus());
    const evidence = projectPolicyEvidence(policy);
    expect(policy.schedule).toMatchObject({ scheduleValid: false, nextRunReason: 'invalid-cron', normalCyclesPerDay: 0 });
    expect(policy.schedule.scheduleError).toMatch(/Invalid cron expression/);
    expect(policy.growthRisk.level).toBe('high');
    expect(evidence.schedule).toMatchObject({ scheduleValid: false, nextRunReason: 'invalid-cron' });
    expect(evidence.growthRisk.reasons.join(' ')).toMatch(/schedule configuration is invalid/);
  });
});
