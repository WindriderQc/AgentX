'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/clients/coreModelHostApi', () => ({ getDedicationStatuses: jest.fn() }));
jest.mock('../../src/clients/coreCoverageReads', () => ({
  getRoutingConfig: jest.fn(), getRuntimeActive: jest.fn(), getHouseholdIdle: jest.fn()
}));

const { validate, DEFAULTS } = require('../../src/services/measurementCoverage/coverageSettings');
const { checkIdle, quietWindow } = require('../../src/services/measurementCoverage/coverageIdle');
const { launchBite, executionConfigFor } = require('../../src/services/measurementCoverage/coverageLauncher');
const { createCoverageJob, orderCells, cellKey, MAX_FAILURES } = require('../../src/services/measurementCoverage/coverageJob');

const settings = { ...DEFAULTS, enabled: true, timeZone: 'UTC', quietStart: '01:00', quietEnd: '06:00', idleMinutes: 10, bitePrompts: 3 };
const at = time => new Date(`2030-01-01T${time}:00Z`);
const cell = (over = {}) => ({
  hostId: 'cpu-a', hostUrl: 'http://cpu-a:11435', hostName: 'CPU A', residency: 'cpu', model: 'small:26b', pinContext: 32768,
  profile: { state: 'current' }, artifact: { digest: 'aaa', runtimeFingerprint: 'rt' },
  catalog: { total: 10, covered: 4 }, missingPromptIds: ['p5', 'p6', 'p7', 'p8', 'p9', 'p10'], next: 'benchmark', ...over
});

describe('coverage settings', () => {
  it('is off by default and refuses values out of range', () => {
    expect(DEFAULTS).toMatchObject({ enabled: false, quietStart: '01:00', quietEnd: '06:00', idleMinutes: 10, bitePrompts: 8 });
    expect(validate({ enabled: true, quietStart: '23:30', timeZone: 'America/Toronto', bitePrompts: 12 }))
      .toMatchObject({ enabled: true, quietStart: '23:30', quietEnd: '06:00', timeZone: 'America/Toronto', bitePrompts: 12 });
    for (const bad of [{ enabled: 'yes' }, { quietStart: '25:00' }, { quietEnd: '01:00' }, { timeZone: 'Mars/Base' },
      { idleMinutes: -1 }, { bitePrompts: 0 }, { bitePrompts: 2.5 }]) {
      expect(() => validate(bad)).toThrow(expect.objectContaining({ code: 'COVERAGE_SETTINGS_INVALID' }));
    }
  });
});

describe('quiet period', () => {
  const calm = {
    now: () => at('02:00'),
    getRuntimeActive: async () => ({ maintenance: null, drain: null, workloads: [], inferences: [] }),
    getHouseholdIdle: async () => ({ activeTurns: 0, idleMs: 3600000 }),
    getActiveBatch: async () => false,
    getActiveProfiles: async () => false
  };

  it('knows the quiet hours, across midnight too', () => {
    expect(quietWindow(settings, at('00:59')).inside).toBe(false);
    expect(quietWindow(settings, at('01:00'))).toEqual({ inside: true, remainingMinutes: 300 });
    expect(quietWindow(settings, at('06:00')).inside).toBe(false);
    const night = { ...settings, quietStart: '23:00', quietEnd: '05:00' };
    expect(quietWindow(night, at('23:30')).inside).toBe(true);
    expect(quietWindow(night, at('04:59')).remainingMinutes).toBe(1);
    expect(quietWindow(night, at('12:00')).inside).toBe(false);
    expect(quietWindow({ ...settings, timeZone: 'America/Toronto' }, at('06:30')).inside).toBe(true);
  });

  it('starts only inside the quiet hours with nothing else going on', async () => {
    await expect(checkIdle(settings, calm)).resolves.toEqual({ idle: true, reasons: [] });
    const outside = { ...calm, now: () => at('12:00'), getRuntimeActive: jest.fn() };
    expect((await checkIdle(settings, outside)).reasons[0]).toContain('outside quiet hours');
    expect(outside.getRuntimeActive).not.toHaveBeenCalled();
    expect((await checkIdle(settings, { ...calm, now: () => at('05:50') })).reasons).toEqual(['quiet hours end too soon to start a measurement']);
  });

  it.each([
    [{ getRuntimeActive: async () => ({ maintenance: { leaseId: 'x' }, workloads: [], inferences: [] }) }, 'maintenance in progress'],
    [{ getRuntimeActive: async () => ({ drain: { scope: 'core' }, workloads: [], inferences: [] }) }, 'a service recreate is announced'],
    [{ getRuntimeActive: async () => ({ workloads: [{ admissionId: 'w' }], inferences: [] }) }, 'another workload holds a host'],
    [{ getRuntimeActive: async () => ({ workloads: [], inferences: [{ state: 'UNKNOWN' }] }) }, 'an inference with unknown outcome blocks a host'],
    [{ getActiveBatch: async () => true }, 'a benchmark batch is running'],
    [{ getActiveProfiles: async () => true }, 'a profile is running'],
    [{ getHouseholdIdle: async () => ({ activeTurns: 0, idleMs: 60000 }) }, 'household active in the last 10 minutes'],
    [{ getHouseholdIdle: async () => ({ activeTurns: 1, idleMs: 0 }) }, 'household active in the last 10 minutes']
  ])('waits when %j', async (override, reason) => {
    await expect(checkIdle(settings, { ...calm, ...override })).resolves.toEqual({ idle: false, reasons: [reason] });
  });
});

describe('one bite', () => {
  it('profiles first, through the same route an operator uses', async () => {
    const post = jest.fn(async () => ({ profileId: 'abc' }));
    await expect(launchBite(cell({ next: 'profile' }), settings, { post })).resolves.toEqual({ kind: 'profile', id: 'abc' });
    expect(post).toHaveBeenCalledWith('/api/profiler/pipeline/profile', { modelName: 'small:26b', hostId: 'cpu-a', depth: 'standard' });
  });

  it('then runs a few missing prompts, at a context the Profiler verified', async () => {
    const post = jest.fn(async () => ({ batch_id: 'b1' }));
    const findContextProfile = jest.fn(async () => ({ maxVerifiedContext: 16384 }));
    const started = await launchBite(cell(), settings, { post, findContextProfile, now: () => at('02:00') });
    expect(started).toEqual({ kind: 'benchmark', id: 'b1', prompts: 3 });
    expect(post).toHaveBeenCalledWith('/api/benchmark/batch', {
      targets: [{ host: 'http://cpu-a:11435', model: 'small:26b' }], levels: [1, 2, 3, 4, 5],
      prompt_ids: ['p5', 'p6', 'p7'], tags: ['coverage'],
      run_name: 'coverage 2030-01-01T02:00Z - CPU A - small:26b - 3 prompts',
      execution_config: { think: false, force_num_ctx: 16384, response_max_tokens: 4096, per_test_timeout_ms: 1200000 }
    });
  });

  it('leaves a wide GPU pin at its own context and default budget', async () => {
    const gpu = cell({ residency: 'gpu', pinContext: 196608 });
    await expect(executionConfigFor(gpu, { findContextProfile: async () => ({ maxVerifiedContext: 196608 }) }))
      .resolves.toEqual({ think: false });
    await expect(executionConfigFor({ ...gpu, artifact: null })).resolves.toEqual({ think: false });
  });
});

describe('coverage job', () => {
  function harness({ cells, state = { last: null, cells: {} }, idle = true, launch } = {}) {
    const store = {
      getSettings: jest.fn(async () => settings),
      getState: jest.fn(async () => state),
      saveState: jest.fn(async value => value)
    };
    const launchBiteMock = launch || jest.fn(async () => ({ kind: 'benchmark', id: 'b1', prompts: 3 }));
    const job = createCoverageJob({
      now: () => at('02:00').getTime(), store, launchBite: launchBiteMock,
      buildCoverage: async () => ({ cells }),
      idleDeps: {
        getRuntimeActive: async () => ({ workloads: idle ? [] : [{ admissionId: 'w' }], inferences: [] }),
        getHouseholdIdle: async () => ({ activeTurns: 0, idleMs: 3600000 }),
        getActiveBatch: async () => false, getActiveProfiles: async () => false
      }
    });
    return { job, store, launch: launchBiteMock, state };
  }

  it('orders the work: profiles first, then the least covered pair', () => {
    const a = cell({ hostUrl: 'http://a:1', model: 'm', catalog: { total: 10, covered: 8 } });
    const b = cell({ hostUrl: 'http://b:1', model: 'm', catalog: { total: 10, covered: 2 } });
    const c = cell({ hostUrl: 'http://c:1', model: 'm', next: 'profile', profile: { state: 'missing' }, catalog: { total: 10, covered: 9 } });
    const done = cell({ hostUrl: 'http://d:1', model: 'm', next: null });
    const unknown = cell({ hostUrl: 'http://e:1', model: 'm', hostId: null });
    expect(orderCells([a, b, c, done, unknown], { cells: {} }, 0).map(item => item.hostUrl)).toEqual(['http://c:1', 'http://b:1', 'http://a:1']);
  });

  it('does nothing while switched off or while the runtime is busy', async () => {
    const off = harness({ cells: [cell()] });
    off.store.getSettings.mockResolvedValue({ ...settings, enabled: false });
    expect((await off.job.tick()).reasons).toEqual(['switched off']);
    const busy = harness({ cells: [cell()], idle: false });
    expect((await busy.job.tick()).idle).toBe(false);
    expect(off.launch).not.toHaveBeenCalled();
    expect(busy.launch).not.toHaveBeenCalled();
  });

  it('launches one bite and remembers it', async () => {
    const { job, store, launch } = harness({ cells: [cell()] });
    const result = await job.tick();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(result.started).toMatchObject({ cell: 'http://cpu-a:11435::small:26b', kind: 'benchmark', id: 'b1', progressBefore: 'current:4' });
    expect(store.saveState.mock.calls[0][0].last).toMatchObject({ id: 'b1' });
  });

  it('counts a bite that changed nothing, and leaves the pair alone after three', async () => {
    const key = cellKey(cell());
    const state = { last: { cell: key, at: at('01:30').toISOString(), progressBefore: 'current:4' }, cells: { [key]: { failures: MAX_FAILURES - 1 } } };
    const { job, launch, store } = harness({ cells: [cell()], state });
    const result = await job.tick();
    expect(state.cells[key]).toMatchObject({ failures: MAX_FAILURES, lastError: 'The measurement ended without progress' });
    expect(state.last.outcome).toBe('no_progress');
    expect(launch).not.toHaveBeenCalled();
    expect(result.reasons).toEqual(['nothing left to measure']);
    expect(store.saveState).toHaveBeenCalledTimes(1);
  });

  it('clears the count when the pair moved forward, and does not count a refusal', async () => {
    const key = cellKey(cell());
    const state = { last: { cell: key, at: at('01:30').toISOString(), progressBefore: 'current:1' }, cells: { [key]: { failures: 2 } } };
    const refused = jest.fn(async () => { throw Object.assign(new Error('host is claimed'), { statusCode: 409 }); });
    const { job } = harness({ cells: [cell()], state, launch: refused });
    const result = await job.tick();
    expect(state.cells[key].failures).toBe(0);
    expect(result.started).toMatchObject({ outcome: 'not_started', error: 'host is claimed' });
  });
});
