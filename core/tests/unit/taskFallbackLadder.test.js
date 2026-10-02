'use strict';

process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_SECONDARY = 'http://secondary:11434';
process.env.OLLAMA_HOST_TERTIARY = 'http://tertiary:11434';

const ladder = require('../../src/services/routing/taskFallbackLadder');

const HOST_URLS = {
  primary: 'http://primary:11434',
  secondary: 'http://secondary:11434',
  tertiary: 'http://tertiary:11434',
};
const FALLBACK_MODEL = 'gemma4:12b-it-qat';
const PRIMARY_MODEL = 'qwen3.6:27b';

function primaryRecommendation(overrides = {}) {
  return {
    model: PRIMARY_MODEL,
    host: 'primary',
    url: HOST_URLS.primary,
    source: 'fallback',
    reason: 'Static task routing fallback',
    claimId: null,
    claimExpiresAt: null,
    recommendation: null,
    readiness: null,
    ...overrides,
  };
}

function claimError() {
  return Object.assign(new Error('claimed'), { code: 'BENCHMARK_CLAIM_ACTIVE' });
}

// A fake world: per-host state, and a clock the ladder's short wait advances.
function world({ offline = [], claimed = [], models = {}, runtime = null, spilled = {}, onSleep } = {}) {
  let clock = 1_000_000;
  const deps = {
    now: () => clock,
    sleep: jest.fn(async (ms) => { clock += ms; onSleep?.(deps); }),
    readCoordination: jest.fn(async () => deps.runtime),
    assertHostAvailable: jest.fn(async (hostUrl) => {
      if (deps.claimed.includes(hostUrl)) throw claimError();
      return null;
    }),
    checkHostHealth: jest.fn(async (hostUrl) => ({
      online: !deps.offline.includes(hostUrl),
      models: models[hostUrl] || [FALLBACK_MODEL, PRIMARY_MODEL],
    })),
    readPinVramSpill: jest.fn(async (hostUrl) => spilled[hostUrl] || []),
    offline: offline.map(key => HOST_URLS[key]),
    claimed: claimed.map(key => HOST_URLS[key]),
    runtime,
  };
  return deps;
}

function setLadder(value) {
  process.env.AGENTX_TASK_FALLBACKS_JSON = typeof value === 'string' ? value : JSON.stringify(value);
}

describe('task fallback ladder configuration', () => {
  test('a proven GPU-degraded primary is skipped through the ordinary guarded ladder', async () => {
    setLadder({ quick_chat: [{ model: FALLBACK_MODEL, host: 'tertiary' }] });
    const deps = world();
    deps.checkHostHealth.mockImplementation(async host => ({ online: true,
      degraded: host === HOST_URLS.primary, models: [PRIMARY_MODEL, FALLBACK_MODEL] }));
    const result = await ladder.applyTaskFallbackLadder('quick_chat', primaryRecommendation(), deps);
    expect(result).toMatchObject({ model: FALLBACK_MODEL, degraded: { reason: 'host_gpu_degraded' } });
    expect(deps.assertHostAvailable).toHaveBeenCalledWith(HOST_URLS.tertiary, FALLBACK_MODEL);
  });
  test('fresh spill evidence only skips the model that spilled, preserving a healthy co-resident', async () => {
    const deps = world();
    deps.checkHostHealth.mockResolvedValue({ online: true, models: [PRIMARY_MODEL, FALLBACK_MODEL],
      spilledModels: [{ model: PRIMARY_MODEL }] });
    expect(await ladder._internal.probeTarget({ model: PRIMARY_MODEL, host: 'primary' }, deps))
      .toMatchObject({ available: false, reason: 'vram_spill' });
    expect(await ladder._internal.probeTarget({ model: FALLBACK_MODEL, host: 'primary' }, deps))
      .toMatchObject({ available: true });
  });
  beforeEach(() => {
    delete process.env.AGENTX_TASK_FALLBACKS_JSON;
    ladder._internal.resetForTests();
  });

  it('is empty by default', () => {
    const parsed = ladder.parseTaskFallbacks('');
    expect(parsed.ladders.size).toBe(0);
    expect(parsed.errors).toEqual([]);
    expect(ladder.getTaskFallbackLadder('quick_chat')).toEqual([]);
    expect(ladder.validateTaskFallbackConfig({ log: { error: jest.fn(), info: jest.fn() } }))
      .toEqual({ valid: true, errors: [], tasks: [] });
  });

  it('accepts ordered fallbacks for degradable tasks', () => {
    const parsed = ladder.parseTaskFallbacks(JSON.stringify({
      quick_chat: [{ model: FALLBACK_MODEL, host: 'tertiary' }, { model: 'gemma4:e4b', host: 'secondary' }],
      nestor_answer_light: [{ model: FALLBACK_MODEL, host: 'tertiary' }],
    }), { hosts: HOST_URLS });
    expect(parsed.errors).toEqual([]);
    expect(parsed.ladders.get('quick_chat')).toEqual([
      { model: FALLBACK_MODEL, host: 'tertiary' },
      { model: 'gemma4:e4b', host: 'secondary' },
    ]);
  });

  it.each(['code_generation', 'code_review', 'deep_reasoning', 'master_brain', 'analysis', 'general_chat', 'embeddings'])(
    'rejects the whole configuration when strict task %s has a fallback',
    (taskType) => {
      setLadder({ quick_chat: [{ model: FALLBACK_MODEL, host: 'tertiary' }], [taskType]: [{ model: FALLBACK_MODEL, host: 'tertiary' }] });
      const log = { error: jest.fn(), info: jest.fn() };
      const result = ladder.validateTaskFallbackConfig({ log });
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toContain(`"${taskType}" is strict and never degrades`);
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('AGENTX_TASK_FALLBACKS_JSON rejected'),
        expect.objectContaining({ errors: expect.any(Array) })
      );
      expect(ladder.getTaskFallbackLadder('quick_chat')).toEqual([]);
      expect(ladder.getTaskFallbackLadder(taskType)).toEqual([]);
    }
  );

  it('rejects malformed JSON, unknown tasks and unknown or unconfigured hosts', () => {
    expect(ladder.parseTaskFallbacks('{not json').errors[0]).toMatch(/not valid JSON/);
    expect(ladder.parseTaskFallbacks('[]').errors[0]).toMatch(/object keyed by task type/);
    expect(ladder.parseTaskFallbacks('{"made_up":[{"model":"m","host":"tertiary"}]}', { hosts: HOST_URLS }).errors[0])
      .toMatch(/unknown task type "made_up"/);
    expect(ladder.parseTaskFallbacks('{"quick_chat":[{"model":"m","host":"nas"}]}', { hosts: HOST_URLS }).errors[0])
      .toMatch(/unknown host "nas"/);
    expect(ladder.parseTaskFallbacks('{"quick_chat":[{"model":"m","host":"tertiary"}]}',
      { hosts: { ...HOST_URLS, tertiary: null } }).errors[0]).toMatch(/no configured URL/);
    expect(ladder.parseTaskFallbacks('{"quick_chat":[]}', { hosts: HOST_URLS }).errors[0]).toMatch(/array of 1 to 4/);
    expect(ladder.parseTaskFallbacks('{"quick_chat":[{"host":"tertiary"}]}', { hosts: HOST_URLS }).errors[0])
      .toMatch(/needs a model and a host/);
  });
});

describe('task fallback ladder routing', () => {
  beforeEach(() => {
    delete process.env.AGENTX_TASK_FALLBACK_WAIT_MS;
    ladder._internal.resetForTests();
    setLadder({
      quick_chat: [{ model: FALLBACK_MODEL, host: 'tertiary' }],
      nestor_answer_light: [{ model: FALLBACK_MODEL, host: 'secondary' }, { model: FALLBACK_MODEL, host: 'tertiary' }],
    });
  });

  afterAll(() => {
    delete process.env.AGENTX_TASK_FALLBACKS_JSON;
    ladder._internal.resetForTests();
  });

  it('returns the recommendation untouched without configuration', async () => {
    delete process.env.AGENTX_TASK_FALLBACKS_JSON;
    ladder._internal.resetForTests();
    const deps = world({ offline: ['primary'] });
    const primary = primaryRecommendation();
    await expect(ladder.applyTaskFallbackLadder('quick_chat', primary, deps)).resolves.toBe(primary);
    expect(deps.checkHostHealth).not.toHaveBeenCalled();
  });

  it('keeps an available primary', async () => {
    const deps = world();
    const primary = primaryRecommendation();
    await expect(ladder.applyTaskFallbackLadder('quick_chat', primary, deps)).resolves.toBe(primary);
  });

  it('falls back when the primary pin runs on CPU, without waiting', async () => {
    const deps = world({
      spilled: { [HOST_URLS.primary]: [{ model: PRIMARY_MODEL, size: 100, sizeVram: 0 }] },
    });
    const result = await ladder.applyTaskFallbackLadder('quick_chat', primaryRecommendation(), deps);
    expect(result).toMatchObject({ model: FALLBACK_MODEL, host: 'tertiary', source: 'task_fallback_ladder' });
    expect(ladder.fallbackReasonCode(result.degraded)).toBe('task_fallback_vram_spill');
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('keeps the primary when only another pin on its host spilled', async () => {
    const deps = world({
      spilled: { [HOST_URLS.primary]: [{ model: 'qllama/bge-m3:f16', size: 100, sizeVram: 40 }] },
    });
    const primary = primaryRecommendation();
    await expect(ladder.applyTaskFallbackLadder('quick_chat', primary, deps)).resolves.toBe(primary);
  });

  it('skips a rung whose model spilled out of VRAM', async () => {
    const deps = world({
      offline: ['primary'],
      spilled: { [HOST_URLS.secondary]: [{ model: FALLBACK_MODEL, size: 100, sizeVram: 0 }] },
    });
    const result = await ladder.applyTaskFallbackLadder('nestor_answer_light', primaryRecommendation(), deps);
    expect(result).toMatchObject({ model: FALLBACK_MODEL, host: 'tertiary' });
  });

  it('falls back when the primary host is down and marks the result degraded', async () => {
    const deps = world({ offline: ['primary'] });
    const result = await ladder.applyTaskFallbackLadder('quick_chat', primaryRecommendation(), deps);
    expect(result).toMatchObject({
      model: FALLBACK_MODEL,
      host: 'tertiary',
      url: HOST_URLS.tertiary,
      source: 'task_fallback_ladder',
      claimId: null,
    });
    expect(ladder.publicDegradedMarker(result.degraded)).toEqual({
      degraded: true,
      fallbackFrom: { model: PRIMARY_MODEL, host: 'primary' },
      fallbackTo: { model: FALLBACK_MODEL, host: 'tertiary' },
      reason: 'host_down',
    });
    expect(ladder.fallbackReasonCode(result.degraded)).toBe('task_fallback_host_down');
    expect(ladder.getTaskFallbackStats()).toMatchObject({
      configuredTasks: ['quick_chat', 'nestor_answer_light'],
      served: { quick_chat: 1 },
      byReason: { host_down: 1 },
      exhausted: 0,
    });
  });

  it('probes the primary at its routed URL when the scheduler names no host key', async () => {
    const deps = world({ offline: ['primary'] });
    const result = await ladder.applyTaskFallbackLadder('quick_chat', primaryRecommendation({ host: null }), deps);
    expect(deps.checkHostHealth).toHaveBeenCalledWith(HOST_URLS.primary);
    expect(result.degraded).toMatchObject({ reason: 'host_down' });
  });

  it('never degrades a strict task, even when its primary is down', async () => {
    const deps = world({ offline: ['primary'] });
    for (const taskType of ['code_generation', 'deep_reasoning', 'master_brain', 'analysis', 'general_chat']) {
      const primary = primaryRecommendation();
      await expect(ladder.applyTaskFallbackLadder(taskType, primary, deps)).resolves.toBe(primary);
    }
    expect(deps.checkHostHealth).not.toHaveBeenCalled();
  });

  it('falls back when the scheduler reports every host claimed for the primary model', async () => {
    const deps = world();
    const result = await ladder.applyTaskFallbackLadder('quick_chat', primaryRecommendation({
      source: 'scheduler-blocked', host: 'primary', url: null,
    }), deps);
    expect(result.degraded).toMatchObject({ reason: 'benchmark_claim' });
    expect(result.url).toBe(HOST_URLS.tertiary);
  });

  it('falls back from a quarantined primary', async () => {
    const deps = world({ runtime: { maintenance: null, workloads: [], inferences: [
      { host: HOST_URLS.primary, model: PRIMARY_MODEL, state: 'UNKNOWN', mode: 'shared' },
    ] } });
    const result = await ladder.applyTaskFallbackLadder('quick_chat', primaryRecommendation(), deps);
    expect(result.degraded).toMatchObject({ reason: 'quarantined', fallbackTo: { host: 'tertiary' } });
  });

  it('waits briefly for a blocked primary before degrading', async () => {
    process.env.AGENTX_TASK_FALLBACK_WAIT_MS = '1500';
    const workload = { hosts: [HOST_URLS.primary], yieldedAt: null };
    const deps = world({ runtime: { maintenance: null, inferences: [], workloads: [workload] } });
    const result = await ladder.applyTaskFallbackLadder('quick_chat', primaryRecommendation(), deps);
    expect(deps.sleep).toHaveBeenCalledTimes(3);
    expect(result.degraded).toMatchObject({ reason: 'admission_blocked' });
  });

  it('keeps the primary when its block clears within the short wait', async () => {
    const workload = { hosts: [HOST_URLS.primary], yieldedAt: null };
    const deps = world({
      runtime: { maintenance: null, inferences: [], workloads: [workload] },
      onSleep: (self) => { self.runtime = { maintenance: null, inferences: [], workloads: [] }; },
    });
    const primary = primaryRecommendation();
    await expect(ladder.applyTaskFallbackLadder('quick_chat', primary, deps)).resolves.toBe(primary);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it('respects a benchmark claim on the fallback host and tries the next rung', async () => {
    const deps = world({ offline: ['primary'], claimed: ['secondary'] });
    const result = await ladder.applyTaskFallbackLadder('nestor_answer_light', primaryRecommendation(), deps);
    expect(result.host).toBe('tertiary');
    expect(deps.assertHostAvailable).toHaveBeenCalledWith(HOST_URLS.secondary, FALLBACK_MODEL);
  });

  it('returns the primary when every rung is claimed, quarantined or missing the model', async () => {
    const deps = world({
      offline: ['primary'],
      claimed: ['secondary'],
      runtime: { maintenance: null, workloads: [], inferences: [
        { host: HOST_URLS.tertiary, model: FALLBACK_MODEL, state: 'UNKNOWN', mode: 'shared' },
      ] },
    });
    const primary = primaryRecommendation();
    await expect(ladder.applyTaskFallbackLadder('nestor_answer_light', primary, deps)).resolves.toBe(primary);
    expect(ladder.getTaskFallbackStats().exhausted).toBe(1);

    const missing = world({ offline: ['primary'], models: { [HOST_URLS.tertiary]: ['other:1b'] } });
    await expect(ladder.applyTaskFallbackLadder('quick_chat', primary, missing)).resolves.toBe(primary);
  });

  it('waits for a busy primary, then degrades with primary_busy', async () => {
    process.env.AGENTX_TASK_FALLBACK_WAIT_MS = '1000';
    const busy = { host: HOST_URLS.primary, model: PRIMARY_MODEL, state: 'ACTIVE', mode: 'shared', expiresAt: new Date(9e12) };
    const deps = world({ runtime: { maintenance: null, workloads: [], inferences: [busy] } });
    const result = await ladder.applyTaskFallbackLadder('quick_chat', primaryRecommendation(), deps);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(result.degraded).toMatchObject({ reason: 'primary_busy', fallbackTo: { host: 'tertiary' } });
    expect(ladder.fallbackReasonCode(result.degraded)).toBe('task_fallback_primary_busy');
  });

  it('keeps a primary whose request finishes within the wait', async () => {
    const busy = { host: HOST_URLS.primary, state: 'ACTIVE', mode: 'shared', expiresAt: new Date(9e12) };
    const deps = world({
      runtime: { maintenance: null, workloads: [], inferences: [busy] },
      onSleep: (self) => { self.runtime = { maintenance: null, workloads: [], inferences: [] }; },
    });
    const primary = primaryRecommendation();
    await expect(ladder.applyTaskFallbackLadder('quick_chat', primary, deps)).resolves.toBe(primary);
  });

  it('never treats a strict task or a busy fallback rung as unavailable for being busy', async () => {
    const busyEverywhere = ['primary', 'secondary', 'tertiary'].map(key => (
      { host: HOST_URLS[key], state: 'ACTIVE', mode: 'shared', expiresAt: new Date(9e12) }));
    const deps = world({ offline: ['primary'], runtime: { maintenance: null, workloads: [], inferences: busyEverywhere } });
    const primary = primaryRecommendation();
    await expect(ladder.applyTaskFallbackLadder('code_generation', primary, deps)).resolves.toBe(primary);
    const light = await ladder.applyTaskFallbackLadder('quick_chat', primary, deps);
    expect(light.degraded).toMatchObject({ reason: 'primary_busy', fallbackTo: { host: 'tertiary' } });
  });

  it('picks the next rung once after a pre-dispatch refusal', async () => {
    const deps = world();
    const fromPrimary = await ladder.fallbackAfterRefusal('nestor_answer_light',
      { model: PRIMARY_MODEL, host: 'primary', url: HOST_URLS.primary, degraded: null }, deps);
    expect(fromPrimary).toMatchObject({ host: 'secondary', source: 'task_fallback_ladder' });
    expect(fromPrimary.degraded).toMatchObject({
      reason: 'dispatch_refused', fallbackFrom: { model: PRIMARY_MODEL, host: 'primary' }, rung: 1,
    });

    const fromRung = await ladder.fallbackAfterRefusal('nestor_answer_light', {
      model: FALLBACK_MODEL, host: 'secondary', url: HOST_URLS.secondary, degraded: fromPrimary.degraded,
    }, deps);
    expect(fromRung).toMatchObject({ host: 'tertiary' });
    expect(fromRung.degraded).toMatchObject({ reason: 'dispatch_refused', fallbackFrom: { host: 'primary' }, rung: 2 });

    const exhausted = await ladder.fallbackAfterRefusal('nestor_answer_light', {
      model: FALLBACK_MODEL, host: 'tertiary', url: HOST_URLS.tertiary, degraded: fromRung.degraded,
    }, deps);
    expect(exhausted).toBeNull();
    await expect(ladder.fallbackAfterRefusal('code_generation',
      { model: PRIMARY_MODEL, host: 'primary', url: HOST_URLS.primary }, deps)).resolves.toBeNull();
  });

  it('recognizes only refusals that happened before dispatch', () => {
    expect(ladder.refusedBeforeDispatch({ code: 'RUNTIME_INFERENCE_ADMISSION_DENIED' })).toBe(true);
    expect(ladder.refusedBeforeDispatch({ code: 'BENCHMARK_CLAIM_ACTIVE' })).toBe(true);
    expect(ladder.refusedBeforeDispatch({ code: 'X', cause: { ollamaRequestNotSent: true } })).toBe(true);
    expect(ladder.refusedBeforeDispatch({ code: 'OLLAMA_TIMEOUT' })).toBe(false);
    expect(ladder.refusedBeforeDispatch({ code: 'ECONNRESET', ollamaRequestNotSent: false })).toBe(false);
  });

  it('treats a recovery quarantine and maintenance as unavailable', () => {
    const { coordinationBlock } = ladder._internal;
    expect(coordinationBlock({ maintenance: { state: 'ACTIVE' } }, HOST_URLS.primary, 0)).toBe('admission_blocked');
    expect(coordinationBlock({ maintenance: { state: 'UNKNOWN' } }, HOST_URLS.primary, 0)).toBe('quarantined');
    expect(coordinationBlock({ maintenance: null, inferences: [], workloads: [
      { hosts: [HOST_URLS.primary], recoveryRequired: true, yieldedAt: new Date() },
    ] }, HOST_URLS.primary, 0)).toBe('quarantined');
    expect(coordinationBlock({ maintenance: null, inferences: [], workloads: [
      { hosts: [HOST_URLS.primary], yieldedAt: new Date() },
    ] }, HOST_URLS.primary, 0)).toBeNull();
    expect(coordinationBlock({ maintenance: null, workloads: [], inferences: [
      { host: HOST_URLS.primary, mode: 'exclusive', state: 'ACTIVE', expiresAt: new Date(10_000) },
    ] }, HOST_URLS.primary, 0)).toBe('admission_blocked');
    expect(coordinationBlock({ maintenance: null, workloads: [], inferences: [
      { host: HOST_URLS.secondary, state: 'UNKNOWN' },
    ] }, HOST_URLS.primary, 0)).toBeNull();
  });
});
