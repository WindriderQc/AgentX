'use strict';

// #143: an exact-model conversation borrows a light task's ladder.
process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_SECONDARY = 'http://secondary:11434';
process.env.OLLAMA_HOST_TERTIARY = 'http://tertiary:11434';

const ladder = require('../../src/services/routing/taskFallbackLadder');

const PRIMARY = 'http://primary:11434';
const TERTIARY = 'http://tertiary:11434';
const FALLBACK_MODEL = 'gemma4:12b-it-qat';
const PRIMARY_MODEL = 'qwen3.8:27b';

function world({ offline = [], claimed = [], runtime = null, models } = {}) {
  let clock = 1_000_000;
  return {
    now: () => clock,
    sleep: jest.fn(async (ms) => { clock += ms; }),
    readCoordination: jest.fn(async () => runtime),
    assertHostAvailable: jest.fn(async (hostUrl) => {
      if (claimed.includes(hostUrl)) throw Object.assign(new Error('claimed'), { code: 'BENCHMARK_CLAIM_ACTIVE' });
    }),
    checkHostHealth: jest.fn(async (hostUrl) => ({
      online: !offline.includes(hostUrl), models: models || [PRIMARY_MODEL, FALLBACK_MODEL],
    })),
    readPinVramSpill: jest.fn(async () => []),
    targetForModel: jest.fn(() => PRIMARY),
  };
}

const busyPrimary = () => ({ maintenance: null, workloads: [],
  inferences: [{ host: PRIMARY, model: PRIMARY_MODEL, state: 'ACTIVE', mode: 'shared', expiresAt: new Date(9e12) }] });

describe('exact-model fallback planning', () => {
  beforeEach(() => {
    process.env.AGENTX_TASK_FALLBACK_WAIT_MS = '0';
    ladder._internal.resetForTests();
    process.env.AGENTX_TASK_FALLBACKS_JSON = JSON.stringify({ nestor_answer_light: [{ model: FALLBACK_MODEL, host: 'tertiary' }] });
  });
  afterAll(() => {
    delete process.env.AGENTX_TASK_FALLBACKS_JSON;
    delete process.env.AGENTX_TASK_FALLBACK_WAIT_MS;
    ladder._internal.resetForTests();
  });

  it('keeps an available primary', async () => {
    const deps = world();
    await expect(ladder.planExactModelFallback({ model: PRIMARY_MODEL, taskType: 'nestor_answer_light' }, deps)).resolves.toBeNull();
    expect(deps.targetForModel).toHaveBeenCalledWith(PRIMARY_MODEL);
  });

  it('degrades a busy primary to the always-on rung with an explicit marker', async () => {
    const plan = await ladder.planExactModelFallback({ model: PRIMARY_MODEL, taskType: 'nestor_answer_light' },
      world({ runtime: busyPrimary() }));
    expect(plan).toEqual({
      model: FALLBACK_MODEL, hostUrl: TERTIARY, hostKey: 'tertiary',
      routing: { degraded: true, reason: 'primary_busy',
        fallbackFrom: { model: PRIMARY_MODEL, host: 'primary' }, fallbackTo: { model: FALLBACK_MODEL, host: 'tertiary' } },
    });
    expect(ladder.getTaskFallbackStats().served).toEqual({ nestor_answer_light: 1 });
  });

  it('degrades an unreachable primary', async () => {
    const plan = await ladder.planExactModelFallback({ model: PRIMARY_MODEL, taskType: 'nestor_answer_light' },
      world({ offline: [PRIMARY] }));
    expect(plan.routing.reason).toBe('host_down');
  });

  it('lets a benchmark reservation be asked to yield first', async () => {
    const plan = await ladder.planExactModelFallback({ model: PRIMARY_MODEL, taskType: 'nestor_answer_light' },
      world({ claimed: [PRIMARY] }));
    expect(plan).toBeNull();
  });

  it('picks a rung once after a refusal before output', async () => {
    const plan = await ladder.planExactModelFallback({ model: PRIMARY_MODEL, taskType: 'nestor_answer_light', afterRefusal: true }, world());
    expect(plan).toMatchObject({ model: FALLBACK_MODEL, hostUrl: TERTIARY, routing: { reason: 'dispatch_refused' } });
  });

  it('keeps the observed refusal cause instead of a generic dispatch refusal', async () => {
    const request = { model: PRIMARY_MODEL, taskType: 'nestor_answer_light', afterRefusal: true };
    const benchmark = await ladder.planExactModelFallback({ ...request, refusalReason: 'benchmark_claim' }, world());
    expect(benchmark.routing.reason).toBe('benchmark_claim');
    const down = await ladder.planExactModelFallback({ ...request, refusalReason: 'host_down' }, world());
    expect(down.routing.reason).toBe('host_down');
    const unknown = await ladder.planExactModelFallback({ ...request, refusalReason: 'http://secret-host' }, world());
    expect(unknown.routing.reason).toBe('dispatch_refused');
  });

  it('returns null when the rung is unavailable too', async () => {
    const deps = world({ offline: [PRIMARY, TERTIARY] });
    await expect(ladder.planExactModelFallback({ model: PRIMARY_MODEL, taskType: 'nestor_answer_light' }, deps)).resolves.toBeNull();
    expect(ladder.getTaskFallbackStats().exhausted).toBe(1);
  });

  it('never plans for a strict task, a task without ladder or a missing model', async () => {
    const deps = world({ offline: [PRIMARY] });
    await expect(ladder.planExactModelFallback({ model: PRIMARY_MODEL, taskType: 'deep_reasoning' }, deps)).resolves.toBeNull();
    await expect(ladder.planExactModelFallback({ model: PRIMARY_MODEL, taskType: 'quick_chat' }, deps)).resolves.toBeNull();
    await expect(ladder.planExactModelFallback({ model: '', taskType: 'nestor_answer_light' }, deps)).resolves.toBeNull();
    expect(deps.checkHostHealth).not.toHaveBeenCalled();
  });
});
