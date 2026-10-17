'use strict';

jest.mock('../../../src/clients/ollamaClient', () => ({ generate: jest.fn(), listRunning: jest.fn() }));

const { generate, listRunning } = require('../../../src/clients/ollamaClient');
const { runConcurrencyProbe } = require('../../../src/services/profiler/concurrencyProbe');

const HOST = 'http://gpu:11434';
const ps = models => ({ models: models.map(([name, ctx]) => ({ name, model: name, context_length: ctx })) });
// Solo speed per model; two concurrent calls each run at `shared` of it.
function ollama({ solo = { coder: 50, chat: 80 }, shared = 0.6, reloadModel = null } = {}) {
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
});
