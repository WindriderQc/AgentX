'use strict';

// A conversation on the principal alias borrows the daily operator ladder
// while the principal host is held; task routing never degrades that route.
process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_SECONDARY = 'http://secondary:11434';
process.env.OLLAMA_HOST_TERTIARY = 'http://tertiary:11434';

const ladder = require('../../src/services/routing/taskFallbackLadder');

const PRIMARY = 'http://primary:11434';
const SECONDARY = 'http://secondary:11434';
const TERTIARY = 'http://tertiary:11434';
const PRINCIPAL = 'qwen3.8:27b';
const LIGHT = 'gemma4:12b-it-qat';

const PINS = {
  [PRIMARY]: [{ model: PRINCIPAL, contextSize: 65536 }],
  [SECONDARY]: [{ model: LIGHT, contextSize: 32768 }],
  [TERTIARY]: [{ model: LIGHT, contextSize: 105472 }],
};

function world({ offline = [], claimed = [], runtime = null, pins = PINS } = {}) {
  let clock = 1_000_000;
  return {
    now: () => clock,
    sleep: jest.fn(async (ms) => { clock += ms; }),
    readCoordination: jest.fn(async () => runtime),
    assertHostAvailable: jest.fn(async (hostUrl) => {
      if (claimed.includes(hostUrl)) throw Object.assign(new Error('claimed'), { code: 'BENCHMARK_CLAIM_ACTIVE' });
    }),
    checkHostHealth: jest.fn(async (hostUrl) => ({ online: !offline.includes(hostUrl), models: [PRINCIPAL, LIGHT] })),
    readPinVramSpill: jest.fn(async () => []),
    readPinnedEntries: jest.fn(async hostUrl => pins[hostUrl] || []),
    targetForModel: jest.fn(() => null),
  };
}

const plan = (extra, deps) => ladder.planExactModelFallback({ model: PRINCIPAL, taskType: 'daily_operator', hostUrl: PRIMARY, ...extra }, deps);
const held = { afterRefusal: true, refusalReason: 'benchmark_claim' };
const busyPrincipal = () => ({ maintenance: null, workloads: [],
  inferences: [{ host: PRIMARY, model: PRINCIPAL, state: 'ACTIVE', mode: 'shared', expiresAt: new Date(9e12) }] });

describe('principal conversation ladder', () => {
  beforeEach(() => {
    process.env.AGENTX_TASK_FALLBACK_WAIT_MS = '0';
    ladder._internal.resetForTests();
    process.env.AGENTX_TASK_FALLBACKS_JSON = JSON.stringify({
      daily_operator: [{ model: LIGHT, host: 'secondary' }, { model: LIGHT, host: 'tertiary' }],
    });
  });
  afterAll(() => {
    delete process.env.AGENTX_TASK_FALLBACKS_JSON;
    delete process.env.AGENTX_TASK_FALLBACK_WAIT_MS;
    ladder._internal.resetForTests();
  });

  it('accepts the daily operator ladder without letting task routing degrade it', async () => {
    const log = { error: jest.fn(), info: jest.fn() };
    expect(ladder.validateTaskFallbackConfig({ log })).toMatchObject({ valid: true, tasks: ['daily_operator'] });
    expect(ladder.getTaskFallbackLadder('daily_operator')).toEqual([]);
    expect(ladder.hasConversationLadder('daily_operator')).toBe(true);
    const primary = { model: PRINCIPAL, host: 'primary', url: PRIMARY };
    await expect(ladder.applyTaskFallbackLadder('daily_operator', primary, world({ offline: [PRIMARY] }))).resolves.toBe(primary);
    await expect(ladder.fallbackAfterRefusal('daily_operator', primary, world())).resolves.toBeNull();
  });

  it('keeps an available principal', async () => {
    const deps = world();
    await expect(plan({}, deps)).resolves.toBeNull();
    expect(deps.targetForModel).not.toHaveBeenCalled();
  });

  it('sends a held principal to Brutal with an explicit marker', async () => {
    await expect(plan(held, world())).resolves.toEqual({
      model: LIGHT, hostUrl: SECONDARY, hostKey: 'secondary',
      routing: { degraded: true, reason: 'benchmark_claim',
        fallbackFrom: { model: PRINCIPAL, host: 'primary' }, fallbackTo: { model: LIGHT, host: 'secondary' } },
    });
    expect(ladder.getTaskFallbackStats().served).toEqual({ daily_operator: 1 });
  });

  it('degrades an unreachable or quarantined principal before dispatch', async () => {
    expect((await plan({}, world({ offline: [PRIMARY] }))).routing).toMatchObject({ reason: 'host_down', fallbackTo: { host: 'secondary' } });
    const quarantine = { maintenance: null, workloads: [],
      inferences: [{ host: PRIMARY, model: PRINCIPAL, state: 'UNKNOWN', expiresAt: new Date(0) }] };
    expect((await plan({}, world({ runtime: quarantine }))).routing.reason).toBe('quarantined');
  });

  it('lets a claim or workload be asked to yield first', async () => {
    await expect(plan({}, world({ claimed: [PRIMARY] }))).resolves.toBeNull();
  });

  it('waits behind a busy principal instead of degrading', async () => {
    await expect(plan({}, world({ runtime: busyPrincipal() }))).resolves.toBeNull();
    const deps = world();
    await expect(plan({ afterRefusal: true, refusalReason: 'primary_busy' }, deps)).resolves.toBeNull();
    expect(deps.checkHostHealth).not.toHaveBeenCalled();
  });

  it('uses Frank only when Brutal is down, held or unpinned', async () => {
    expect((await plan(held, world({ offline: [SECONDARY] }))).hostKey).toBe('tertiary');
    expect((await plan(held, world({ claimed: [SECONDARY] }))).hostKey).toBe('tertiary');
    const unpinned = { ...PINS, [SECONDARY]: [{ model: 'gemma4:e4b', contextSize: 8192 }] };
    expect((await plan(held, world({ pins: unpinned }))).hostKey).toBe('tertiary');
    const noContext = { ...PINS, [SECONDARY]: [{ model: LIGHT, contextSize: null }] };
    expect((await plan(held, world({ pins: noContext }))).hostKey).toBe('tertiary');
  });

  it('returns null when neither fallback host can answer', async () => {
    await expect(plan(held, world({ offline: [SECONDARY, TERTIARY] }))).resolves.toBeNull();
    expect(ladder.getTaskFallbackStats().exhausted).toBe(1);
  });

  it('never plans the principal ladder when it is not configured', async () => {
    process.env.AGENTX_TASK_FALLBACKS_JSON = JSON.stringify({ nestor_answer_light: [{ model: LIGHT, host: 'tertiary' }] });
    expect(ladder.hasConversationLadder('daily_operator')).toBe(false);
    await expect(plan(held, world())).resolves.toBeNull();
  });

  it('keeps light-task rungs free of the pin requirement', async () => {
    process.env.AGENTX_TASK_FALLBACKS_JSON = JSON.stringify({ nestor_answer_light: [{ model: LIGHT, host: 'tertiary' }] });
    const deps = world({ pins: {} });
    const light = await ladder.planExactModelFallback({ model: PRINCIPAL, taskType: 'nestor_answer_light', ...held }, deps);
    expect(light.hostKey).toBe('tertiary');
    expect(deps.readPinnedEntries).not.toHaveBeenCalled();
  });
});
