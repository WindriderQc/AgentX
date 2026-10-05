'use strict';

jest.mock('../../../src/clients/ollamaClient', () => ({ generate: jest.fn(), listRunning: jest.fn() }));

const { generate, listRunning } = require('../../../src/clients/ollamaClient');
const {
  RETRIEVAL_DEPTHS, buildQualityPrompt, plantFacts, scoreQualityResponse,
} = require('../../../src/services/profiler/longContextQualityPayload');
const { qualitySizes, runLongContextQualityProbe } = require('../../../src/services/profiler/longContextQualityProbe');

const perfect = built => built.expected.map((value, index) => `${index + 1}: ${value}`).join('\n');

describe('long-context quality payload', () => {
  test('the same size and seed always build the same document and answers', () => {
    const a = buildQualityPrompt(20_000, 32768);
    const b = buildQualityPrompt(20_000, 32768);
    expect(a.prompt).toBe(b.prompt);
    expect(a.expected).toEqual(b.expected);
    expect(buildQualityPrompt(20_000, 65536).expected).not.toEqual(a.expected);
    expect(new Set(a.expected).size).toBe(6);
  });

  test('facts sit at their depths and the chain needs both hops', () => {
    const built = buildQualityPrompt(100_000, 7);
    const document = built.prompt.slice(0, built.prompt.indexOf('\nAnswer from the document'));
    for (const [index, fact] of built.facts.retrieval.entries()) {
      const at = document.indexOf(fact.sentence) / document.length;
      expect(Math.abs(at - RETRIEVAL_DEPTHS[index])).toBeLessThan(0.02);
    }
    const { chain, expected, distractor } = built.facts.multiHop;
    expect(chain).toHaveLength(4);
    expect(document.indexOf(chain[0].sentence)).toBeLessThan(document.indexOf(chain[3].sentence));
    // The question names only the shipment; the cabinet appears beside the courier's name alone.
    expect(built.facts.multiHop.question).not.toContain(expected);
    expect(distractor).not.toBe(expected);
    expect(document.length).toBeGreaterThanOrEqual(100_000);
  });

  test('scores exact values per line, in several answer styles', () => {
    const built = buildQualityPrompt(10_000, 11);
    expect(scoreQualityResponse(perfect(built), built)).toMatchObject({ passed: true, score: 1, retrievalCorrect: 5, multiHopCorrect: true });
    const decorated = built.expected.map((value, index) => `**${index + 1}.** The value is ${value.replace(/-/g, '‑')}.`).join('\n');
    expect(scoreQualityResponse(`Here are the answers:\n${decorated}`, built)).toMatchObject({ passed: true });
    expect(scoreQualityResponse(built.expected.join('\n'), built)).toMatchObject({ passed: true });
  });

  test('a wrong, missing or hedged line fails it, and the distractor is named', () => {
    const built = buildQualityPrompt(10_000, 13);
    const lines = perfect(built).split('\n');
    lines[2] = '3: I could not find it';
    lines[5] = `6: ${built.facts.multiHop.distractor}`;
    const scored = scoreQualityResponse(lines.join('\n'), built);
    expect(scored).toMatchObject({ passed: false, retrievalCorrect: 4, multiHopCorrect: false, multiHopDistractor: true, score: 0.667 });
    expect(scored.retrieval[2]).toEqual({ depthPct: 50, correct: false });
    // Listing every value on every line scores nothing.
    const everything = built.expected.join(' ');
    const shotgun = built.expected.map((_, index) => `${index + 1}: ${everything}`).join('\n');
    expect(scoreQualityResponse(shotgun, built)).toMatchObject({ score: 0, passed: false });
    expect(scoreQualityResponse('', built)).toMatchObject({ score: 0 });
  });

  test('plantFacts is deterministic', () => {
    expect(plantFacts(5)).toEqual(plantFacts(5));
  });
});

describe('long-context quality probe', () => {
  beforeEach(() => {
    generate.mockReset();
    listRunning.mockReset();
  });

  test('sizes fit the verified window and add it when larger', () => {
    const sizes = [32768, 65536, 131072, 196608];
    expect(qualitySizes(262144, sizes)).toEqual([...sizes, 262144]);
    expect(qualitySizes(100_000, sizes)).toEqual([32768, 65536, 100_000]);
    expect(qualitySizes(131072, sizes)).toEqual([32768, 65536, 131072]);
    expect(qualitySizes(16384, sizes)).toEqual([]);
    expect(qualitySizes(null, sizes)).toEqual([]);
  });

  // A model whose recall fails past 64k, on a tokenizer at 3 characters per token.
  function fakeModel({ failAbove = Infinity, charsPerToken = 3, contextFor = numCtx => numCtx } = {}) {
    let lastCtx = null;
    generate.mockImplementation(async (_host, body) => {
      lastCtx = body.options.num_ctx;
      const promptTokens = Math.round(body.prompt.length / charsPerToken);
      const seed = body.options.num_ctx;
      const built = buildQualityPrompt(1000, seed);
      const answer = lastCtx > failAbove ? '1: unknown\n2: unknown' : perfect(built);
      return { response: answer, prompt_eval_count: promptTokens, eval_count: 40, done_reason: 'stop',
        load_duration: 2e9, prompt_eval_duration: 5e9 };
    });
    listRunning.mockImplementation(async () => ({ models: [{ name: 'model-a', context_length: contextFor(lastCtx) }] }));
  }

  test('verifies the largest size whose every smaller size passed, recalibrating the fill', async () => {
    fakeModel({ failAbove: 65536 });
    const evidence = await runLongContextQualityProbe('http://gpu:11434', 'model-a', {
      maxVerifiedContext: 196608, sizes: [32768, 65536, 131072, 196608],
    });
    expect(evidence.results.map(result => [result.numCtx, result.status])).toEqual([
      [32768, 'pass'], [65536, 'pass'], [131072, 'fail'], [196608, 'fail'],
    ]);
    expect(evidence).toMatchObject({ qualityVerifiedContext: 65536, firstMiss: { numCtx: 131072, status: 'fail' } });
    // The first size overflowed at 4 characters per token, then refilled to ~80 %.
    expect(evidence.results[0].attempt).toBe(2);
    for (const result of evidence.results) {
      expect(result.promptCoveragePct).toBeGreaterThan(70);
      expect(result.promptCoveragePct).toBeLessThan(90);
    }
    expect(evidence.results[0]).toMatchObject({ loadDurationMs: 2000, promptEvalDurationMs: 5000, runtimeContextLength: 32768 });
  });

  test('a clamped runtime context or a request error is not scored', async () => {
    fakeModel({ contextFor: () => 8192 });
    let evidence = await runLongContextQualityProbe('http://gpu:11434', 'model-a', { maxVerifiedContext: 65536, sizes: [32768, 65536] });
    expect(evidence.results.map(result => result.status)).toEqual(['context_mismatch', 'context_mismatch']);
    expect(evidence.qualityVerifiedContext).toBeNull();

    generate.mockReset();
    generate.mockRejectedValue(new Error('socket hang up'));
    evidence = await runLongContextQualityProbe('http://gpu:11434', 'model-a', { maxVerifiedContext: 65536, sizes: [32768, 65536] });
    expect(evidence.results).toHaveLength(1);
    expect(evidence.results[0]).toMatchObject({ status: 'error', error: 'socket hang up' });
  });

  test('an empty answer reads no_answer', async () => {
    generate.mockImplementation(async (_host, body) => ({
      response: '', thinking: 'long thoughts', prompt_eval_count: Math.round(body.prompt.length / 4),
      eval_count: 256, done_reason: 'length',
    }));
    listRunning.mockResolvedValue({ models: [{ name: 'model-a', context_length: 32768 }] });
    const evidence = await runLongContextQualityProbe('http://gpu:11434', 'model-a', { maxVerifiedContext: 32768, sizes: [32768] });
    expect(evidence.results[0]).toMatchObject({ status: 'no_answer', doneReason: 'length' });
    expect(evidence.qualityVerifiedContext).toBeNull();
  });
});
