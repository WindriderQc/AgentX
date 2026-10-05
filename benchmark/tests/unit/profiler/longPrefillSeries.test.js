'use strict';

jest.mock('../../../src/clients/ollamaClient', () => ({ generate: jest.fn(), listRunning: jest.fn() }));

const { generate, listRunning } = require('../../../src/clients/ollamaClient');
const { runLongPrefillSeries } = require('../../../src/services/profiler/longPrefillSeries');
const { runPrefillDecodeMatrix } = require('../../../src/services/profiler/prefillDecodeMatrix');

// An Ollama that, like the real one, serves a repeated identical prompt from
// its prompt cache: prompt_eval_count still counts every token, but the
// duration covers only what was evaluated (#367).
function cachingOllama({ tokensPerSec = 1000, charsPerToken = 4.5 } = {}) {
  let previous = '';
  let numCtx = null;
  generate.mockImplementation(async (_host, body) => {
    numCtx = body.options.num_ctx;
    let shared = 0;
    while (shared < previous.length && shared < body.prompt.length && previous[shared] === body.prompt[shared]) shared += 1;
    previous = body.prompt;
    const promptTokens = Math.round(body.prompt.length / charsPerToken);
    const evaluated = Math.max(1, promptTokens - Math.round(shared / charsPerToken));
    return {
      done: true, response: '1 2 3', prompt_eval_count: promptTokens, prompt_eval_duration: (evaluated / tokensPerSec) * 1e9,
      eval_count: body.options.num_predict, eval_duration: body.options.num_predict * 2e7, load_duration: 3e9,
    };
  });
  listRunning.mockImplementation(async () => ({ models: [{ name: 'model-a', context_length: numCtx }] }));
}

beforeEach(() => {
  generate.mockReset();
  listRunning.mockReset();
});

describe('agent-sized prefill series', () => {
  test('the Full matrix runs it, or skips it on request', async () => {
    cachingOllama();
    const matrix = await runPrefillDecodeMatrix('http://gpu:11434', 'model-a', {
      prefillTokens: [512], decodeTokens: [64], repeats: 1, safeNumCtx: 4096, longPrefill: false,
    });
    expect(matrix.longPrefill).toBeNull();
    const withSeries = await runPrefillDecodeMatrix('http://gpu:11434', 'model-a', {
      prefillTokens: [512], decodeTokens: [64], repeats: 1, safeNumCtx: 4096,
    });
    expect(withSeries.longPrefill.sizes.map(size => size.status)).toEqual(['skipped', 'skipped', 'skipped']);
  });

  test('measures each window with whole-prompt prefill, reporting first-token time apart from load', async () => {
    cachingOllama();
    const series = await runLongPrefillSeries('http://gpu:11434', 'model-a', {
      safeNumCtx: 65536, windows: [32768, 65536, 131072],
    });
    expect(series).toMatchObject({ fillRatio: 0.9, decodeTokens: 32, repeats: 2 });
    const [w32, w64, w128] = series.sizes;
    expect(w128).toMatchObject({ numCtx: 131072, status: 'skipped', error: 'Requires 131072 ctx > safe 65536' });
    for (const size of [w32, w64]) {
      expect(size.status).toBe('pass');
      // Both samples evaluated their whole prompt: no cached repeat reads as 1000x.
      expect(size.prefillTokensPerSec).toBeGreaterThan(900);
      expect(size.prefillTokensPerSec).toBeLessThan(1100);
      for (const sample of size.samples) expect(sample.promptCoveragePct).toBeGreaterThan(80);
      // First token: the whole prefill plus one 20 ms decode step, never the 3 s load.
      for (const sample of size.samples) expect(sample.ttftMs).toBeCloseTo(sample.promptEvalDurationMs + 20, 0);
      const ttfts = size.samples.map(sample => sample.ttftMs);
      expect(size.ttftMs).toBeGreaterThanOrEqual(Math.min(...ttfts));
      expect(size.ttftMs).toBeLessThanOrEqual(Math.max(...ttfts));
      expect(size.loadDurationMs).toBe(3000);
    }
    const prompts = generate.mock.calls.map(([, body]) => body.prompt);
    expect(new Set(prompts.map(prompt => prompt.split('\n')[0])).size).toBe(prompts.length);
    expect(generate.mock.calls.map(([, body]) => body.options.num_ctx)).toEqual(expect.arrayContaining([32768, 65536]));
  });

  test('a clamped window is not a measurement', async () => {
    cachingOllama();
    listRunning.mockResolvedValue({ models: [{ name: 'model-a', context_length: 8192 }] });
    const series = await runLongPrefillSeries('http://gpu:11434', 'model-a', { safeNumCtx: 32768, windows: [32768] });
    expect(series.sizes[0]).toMatchObject({ status: 'context_mismatch', prefillTokensPerSec: null });
  });

  test('without a verified safe context nothing runs', async () => {
    const series = await runLongPrefillSeries('http://gpu:11434', 'model-a', { windows: [32768] });
    expect(series.sizes[0]).toMatchObject({ status: 'skipped', error: 'No verified safe context' });
    expect(generate).not.toHaveBeenCalled();
  });
});
