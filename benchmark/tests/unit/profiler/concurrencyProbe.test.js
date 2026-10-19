'use strict';

jest.mock('../../../src/clients/ollamaClient', () => ({ generate: jest.fn(), listRunning: jest.fn() }));

const { generate, listRunning } = require('../../../src/clients/ollamaClient');
const { runConcurrencyProbe } = require('../../../src/services/profiler/concurrencyProbe');

const HOST = 'http://gpu:11434';
const ps = models => ({ models: models.map(([name, ctx]) => ({ name, model: name, context_length: ctx })) });
// Solo speed per model; two concurrent calls each run at `shared` of it.
function ollama({ solo = { coder: 50, chat: 80, gemma: 10 }, shared = 0.6, reloadModel = null } = {}) {
  let inFlight = 0;
  generate.mockImplementation(async (_host, body) => {
    inFlight += 1;
    await new Promise(resolve => setImmediate(resolve));
    const together = inFlight > 1;
    await new Promise(resolve => setImmediate(resolve));
    inFlight -= 1;
    const tps = solo[body.model] * (together ? shared : 1);
    return { done: true, response: 'ok', eval_count: 128, eval_duration: (128 / tps) * 1e9,
      load_duration: body.model === reloadModel ? 3e9 : 1e7, options: body.options };
  });
}

beforeEach(() => jest.clearAllMocks());

describe('concurrency probe', () => {
  it('measures each model alone and together at the context it is resident with', async () => {
    listRunning.mockResolvedValue(ps([['coder', 32768], ['chat', 16384], ['bge-m3:latest', 8192]]));
    ollama();
    const result = await runConcurrencyProbe(HOST, 'coder', {});
    expect(result.status).toBe('measured');
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ model: 'chat', selfSoloTokensPerSec: 50, selfTogetherTokensPerSec: 30,
      otherSoloTokensPerSec: 80, otherTogetherTokensPerSec: 48, selfSlowdownPct: 40, otherSlowdownPct: 40, status: 'measured' });
    expect(result.worstSelfSlowdownPct).toBe(40);
    const contexts = generate.mock.calls.map(([, body]) => [body.model, body.options.num_ctx]);
    expect(new Set(contexts.map(String))).toEqual(new Set(['coder,32768', 'chat,16384']));
    expect(result.separateEndpoints).toMatch(/not_measured/);
  });

  it('reports a pair whose models evict each other', async () => {
    listRunning.mockResolvedValueOnce(ps([['coder', 32768], ['chat', 16384]])).mockResolvedValueOnce(ps([['chat', 16384]]));
    ollama();
    const result = await runConcurrencyProbe(HOST, 'coder', {});
    expect(result.status).toBe('evicted');
    expect(result.pairs[0].status).toBe('evicted');
    expect(result.worstSelfSlowdownPct).toBeNull();
  });

  it('invalidates a pair when a call reloaded a model', async () => {
    listRunning.mockResolvedValue(ps([['coder', 32768], ['chat', 16384]]));
    ollama({ reloadModel: 'chat' });
    const result = await runConcurrencyProbe(HOST, 'coder', {});
    expect(result.pairs[0].status).toBe('reloaded');
    expect(result.status).toBe('unmeasured');
  });

  it('loads nothing when the model is alone, not resident, or the inventory is unreadable', async () => {
    listRunning.mockResolvedValueOnce(ps([['coder', 32768], ['nomic-embed-text', 8192]]));
    expect((await runConcurrencyProbe(HOST, 'coder', {})).status).toBe('no_co_resident');
    listRunning.mockResolvedValueOnce(ps([['chat', 16384]]));
    expect((await runConcurrencyProbe(HOST, 'coder', {})).status).toBe('not_resident');
    listRunning.mockRejectedValueOnce(new Error('offline'));
    expect((await runConcurrencyProbe(HOST, 'coder', {})).status).toBe('inventory_unavailable');
    expect(generate).not.toHaveBeenCalled();
  });

  describe('sibling endpoints of the same machine', () => {
    const CPU = 'http://gpu:11435';
    const byHost = (gpu, cpu) => listRunning.mockImplementation(async host => {
      const models = host === CPU ? cpu : gpu;
      if (models instanceof Error) throw models;
      return ps(models);
    });

    it('pairs the lane with the model resident on the sibling endpoint, called there', async () => {
      byHost([['coder', 32768]], [['gemma', 32768], ['bge-m3:latest', 4096]]);
      ollama({ shared: 0.9 });
      const result = await runConcurrencyProbe(HOST, 'coder', { siblingEndpoints: [CPU] });
      expect(result).toMatchObject({ status: 'measured', scope: 'same_machine', separateEndpoints: 'measured',
        siblingEndpoints: [CPU], worstSiblingSelfSlowdownPct: 10 });
      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0]).toMatchObject({ model: 'gemma', endpoint: 'sibling', hostUrl: CPU, selfSlowdownPct: 10, status: 'measured' });
      const calls = generate.mock.calls.map(([host, body]) => `${host} ${body.model} ${body.options.num_ctx}`);
      expect(new Set(calls)).toEqual(new Set([`${HOST} coder 32768`, `${CPU} gemma 32768`]));
    });

    it('keeps the same-endpoint pairs when the sibling inventory cannot be read', async () => {
      byHost([['coder', 32768], ['chat', 16384]], new Error('offline'));
      ollama();
      const result = await runConcurrencyProbe(HOST, 'coder', { siblingEndpoints: [CPU] });
      expect(result).toMatchObject({ status: 'measured', separateEndpoints: 'inventory_unavailable', worstSiblingSelfSlowdownPct: null });
      expect(result.pairs.map(pair => pair.endpoint)).toEqual(['same']);
    });

    it('says the sibling was empty, and reports a sibling model that disappeared', async () => {
      byHost([['coder', 32768]], [['bge-m3:latest', 4096]]);
      expect(await runConcurrencyProbe(HOST, 'coder', { siblingEndpoints: [CPU] }))
        .toMatchObject({ status: 'no_co_resident', separateEndpoints: 'no_co_resident' });
      let reads = 0;
      listRunning.mockImplementation(async host => {
        if (host !== CPU) return ps([['coder', 32768]]);
        reads += 1;
        return ps(reads === 1 ? [['gemma', 32768]] : []);
      });
      ollama();
      const evicted = await runConcurrencyProbe(HOST, 'coder', { siblingEndpoints: [CPU] });
      expect(evicted).toMatchObject({ status: 'evicted', separateEndpoints: 'evicted' });
    });

    it('uses each endpoint its own timeout and ignores the lane itself in the sibling list', async () => {
      byHost([['coder', 32768]], [['gemma', 32768]]);
      ollama();
      const timeoutFor = jest.fn(host => (host === CPU ? 1200000 : 60000));
      const result = await runConcurrencyProbe(HOST, 'coder', { siblingEndpoints: [HOST, CPU, CPU], timeoutFor });
      expect(result.siblingEndpoints).toEqual([CPU]);
      const byModel = Object.fromEntries(generate.mock.calls.map(([, body, opts]) => [body.model, opts.timeoutMs]));
      expect(byModel).toEqual({ coder: 60000, gemma: 1200000 });
    });
  });
});
