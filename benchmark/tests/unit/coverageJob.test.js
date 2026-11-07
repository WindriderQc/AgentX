'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/clients/coreModelHostApi', () => ({ getDedicationStatuses: jest.fn() }));
jest.mock('../../src/clients/coreCoverageReads', () => ({
  getRoutingConfig: jest.fn(), getRuntimeActive: jest.fn(), getHouseholdIdle: jest.fn()
}));

const { validate, DEFAULTS } = require('../../src/services/measurementCoverage/coverageSettings');
const { checkIdle, quietWindow } = require('../../src/services/measurementCoverage/coverageIdle');
const { prepareBite, executionConfigFor } = require('../../src/services/measurementCoverage/coverageLauncher');
const { createCoverageJob, orderCells, cellKey, MAX_FAILURES, REFUSAL_COOLDOWN_MS } = require('../../src/services/measurementCoverage/coverageJob');

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
      { idleMinutes: -1 }, { idleMinutes: null }, { idleMinutes: '' }, { idleMinutes: '5' }, { bitePrompts: 0 }, { bitePrompts: 2.5 }]) {
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
  const requestId = '11111111-1111-4111-8111-111111111111';
  const persist = { create: jest.fn(async (_id, intent) => ({ _id, intent })) };

  it('persists the exact native host-queue intent before Core can launch', async () => {
    const result = await prepareBite(cell({ next: 'profile' }), settings, { requestId, attempts: persist, now: () => at('02:00') });
    expect(result.intent.manifest).toMatchObject({ key: `coverage:${requestId}`, kind: 'profiler',
      hosts: ['http://cpu-a:11435'], executor: { hostId: 'cpu-a', depth: 'standard', skipRecentDays: 0, modelNames: ['small:26b'] } });
  });

  it('freezes missing prompts, their versions, the judge and verified execution settings', async () => {
    const result = await prepareBite(cell(), settings, {
      requestId, attempts: persist, now: () => at('02:00'),
      resolveJudge: async () => ({ ready: true, target: { host: 'http://judge:11434', model: 'judge:fixture' } }),
      freezeJudgeConfig: async config => config,
      findContextProfile: async () => ({ maxVerifiedContext: 16384 }),
      loadCatalogPrompts: async () => new Map(['p5', 'p6', 'p7'].map(id => [`hash-${id}`, { id }]))
    });
    expect(result.intent.manifest).toMatchObject({ kind: 'benchmark', hosts: ['http://cpu-a:11435', 'http://judge:11434'],
      executor: { mode: 'coverage', requestId } });
    expect(result.intent.body).toMatchObject({ requestId, prompt_ids: ['p5', 'p6', 'p7'], tags: ['coverage', `coverage-${requestId}`],
      judge_config: { host: 'http://judge:11434', model: 'judge:fixture' },
      execution_config: { think: false, force_num_ctx: 16384, response_max_tokens: 4096, per_test_timeout_ms: 1200000 } });
    expect(result.intent.promptVersions).toEqual([['p5', 'hash-p5'], ['p6', 'hash-p6'], ['p7', 'hash-p7']]);
  });

  it('leaves a wide GPU pin at its own context and default budget', async () => {
    const gpu = cell({ residency: 'gpu', pinContext: 196608 });
    await expect(executionConfigFor(gpu, { findContextProfile: async () => ({ maxVerifiedContext: 196608 }) }))
      .resolves.toEqual({ think: false });
    await expect(executionConfigFor({ ...gpu, artifact: null })).resolves.toEqual({ think: false });
  });
});

describe('coverage job', () => {
  function harness({ cells = [cell()], state = { last: null, cells: {} }, pending = null, idle = true, follow } = {}) {
    const store = {
      getSettings: jest.fn(async () => settings), getState: jest.fn(async () => state), saveState: jest.fn(async value => value)
    };
    const attempts = { active: jest.fn(async () => pending) };
    const attempt = pending || { _id: 'intent-1', intent: { cell: cells[0], kind: cells[0]?.next, at: at('02:00').toISOString() } };
    const prepare = jest.fn(async () => { pending = attempt; return attempt; });
    const followMock = follow || jest.fn(async () => ({ requestId: attempt._id, queueId: 'queue-1', kind: 'benchmark',
      id: 'b1', state: 'running', terminal: false }));
    const job = createCoverageJob({
      now: () => at('02:00').getTime(), store, attempts, prepareBite: prepare, followBite: followMock,
      buildCoverage: async () => ({ cells }),
      idleDeps: {
        getRuntimeActive: async () => ({ workloads: idle ? [] : [{ admissionId: 'w' }], inferences: [] }),
        getHouseholdIdle: async () => ({ activeTurns: 0, idleMs: 3600000 }),
        getActiveBatch: async () => false, getActiveProfiles: async () => false
      }
    });
    return { job, store, prepare, follow: followMock, state };
  }
  const pending = () => ({ _id: 'intent-1', intent: { cell: cell(), kind: 'benchmark', at: at('01:30').toISOString() } });

  it('orders profiles first, then the least covered pair', () => {
    const a = cell({ hostUrl: 'http://a:1', catalog: { total: 10, covered: 8 } });
    const b = cell({ hostUrl: 'http://b:1', catalog: { total: 10, covered: 2 } });
    const c = cell({ hostUrl: 'http://c:1', next: 'profile', profile: { state: 'missing' } });
    expect(orderCells([a, b, c, cell({ next: null }), cell({ hostId: null })], { cells: {} }, 0).map(item => item.hostUrl))
      .toEqual(['http://c:1', 'http://b:1', 'http://a:1']);
  });

  it('does nothing while switched off or the runtime is busy', async () => {
    const off = harness();
    off.store.getSettings.mockResolvedValue({ ...settings, enabled: false });
    expect((await off.job.tick()).reasons).toEqual(['switched off']);
    const busy = harness({ idle: false });
    expect((await busy.job.tick()).idle).toBe(false);
    expect(off.prepare).not.toHaveBeenCalled();
    expect(busy.prepare).not.toHaveBeenCalled();
  });

  it('persists one intent and follows it rather than creating a replacement', async () => {
    const { job, prepare, follow, state } = harness();
    expect((await job.tick()).started).toMatchObject({ requestId: 'intent-1', id: 'b1', state: 'running' });
    await job.tick();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(follow).toHaveBeenLastCalledWith(expect.objectContaining({ _id: 'intent-1' }), expect.objectContaining({ allowStart: false }));
    expect(state.last.settledAt).toBeUndefined();
  });

  it('observes unknown work outside quiet hours, even while switched off and busy', async () => {
    const h = harness({ pending: pending(), idle: false, follow: jest.fn(async () => ({ state: 'uncertain', terminal: false })) });
    h.store.getSettings.mockResolvedValue({ ...settings, enabled: false });
    expect((await h.job.tick()).started).toMatchObject({ state: 'uncertain' });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.state.cells).toEqual({});
  });

  it('counts no progress only after a native terminal result, and exposes failure', async () => {
    const key = cellKey(cell());
    const state = { cells: { [key]: { failures: MAX_FAILURES - 1 } } };
    const h = harness({ state, pending: pending(), follow: async () => ({ state: 'failed', terminal: true, error: 'native failure' }) });
    expect((await h.job.tick()).started).toMatchObject({ state: 'failed', outcome: 'failed', error: 'native failure' });
    expect(state.cells[key].failures).toBe(MAX_FAILURES);
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it('records proven refusal without incrementing measurement failures', async () => {
    const h = harness({ pending: pending(), follow: async () => ({ state: 'failed', terminal: true, notStarted: true, error: 'judge busy' }) });
    expect((await h.job.tick()).started).toMatchObject({ outcome: 'not_started' });
    expect(h.state.cells[cellKey(cell())]).toMatchObject({ failures: 0, lastError: 'judge busy' });
    const now = at('02:00').getTime();
    expect(orderCells([cell()], h.state, now + REFUSAL_COOLDOWN_MS - 1)).toEqual([]);
    expect(orderCells([cell()], h.state, now + REFUSAL_COOLDOWN_MS + 1)).toEqual([cell()]);
  });

  it('keeps a lost launch reply unresolved and does not label it a refusal', async () => {
    const h = harness({ pending: pending(), follow: async () => { throw new Error('response lost'); } });
    expect((await h.job.tick()).reasons).toEqual(['check failed: response lost']);
    expect(h.state.cells).toEqual({});
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it('does not replace a pre-identity legacy launch merely because the runtime is idle', async () => {
    const h = harness({ state: { cells: {}, last: { at: at('01:00').toISOString() } } });
    expect((await h.job.tick()).reasons).toEqual(['legacy measurement needs native reconciliation']);
    expect(h.prepare).not.toHaveBeenCalled();
  });
});
