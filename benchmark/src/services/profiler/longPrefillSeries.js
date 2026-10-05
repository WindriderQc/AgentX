'use strict';

/**
 * Agent-sized prefill series of the Full profile's matrix (#367).
 *
 * The fixed matrix stops at 16k prompts in one shared window. Agent turns run
 * 32k to 128k prompts, where prefill dominates time to first token. Each window
 * here (32k, 64k, 128k by default) runs on its own, filled to 90 % with a short
 * decode, and is skipped above the verified safe context.
 *
 * Every sample starts with a line of its own, so Ollama's prompt cache cannot
 * reuse an earlier sample's prefix: a repeated identical prompt would be
 * served almost entirely from cache and read as an impossible prefill rate.
 * Times come from Ollama's own phases: prefill tok/s is prompt_eval_count over
 * prompt_eval_duration, and time to first token is the prompt evaluation plus
 * one generated token, without the model load, which is recorded separately.
 */

const { generate, listRunning } = require('../../clients/ollamaClient');
const { generateFillPrompt, isolatePrompt } = require('../contextProbePayload');

const DEFAULT_LONG_PREFILL_WINDOWS = Object.freeze([32768, 65536, 131072]);
const FILL_RATIO = 0.9;
const DECODE_TOKENS = 32;
const DEFAULT_REPEATS = 2;
const MIN_PROMPT_COVERAGE_RATIO = 0.8;
const MAX_CALIBRATION_RETRIES = 2;

const normalizeModelName = value => String(value || '').trim().replace(/:latest$/i, '').toLowerCase();
const ms = ns => (Number(ns) > 0 ? Number((Number(ns) / 1e6).toFixed(1)) : null);

function parseTokens(raw, fallback = DEFAULT_LONG_PREFILL_WINDOWS) {
  if (raw == null || raw === '') return [...fallback];
  const values = String(raw).split(',').map(part => Number.parseInt(part.trim(), 10))
    .filter(value => Number.isInteger(value) && value > 0);
  return values.length ? [...new Set(values)].sort((a, b) => a - b) : [...fallback];
}


function median(values) {
  const finite = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : Number(((finite[middle - 1] + finite[middle]) / 2).toFixed(2));
}

async function runSample(hostUrl, modelName, { prefillTokens, numCtx, fillScale, timeoutMs, signal }) {
  const { prompt: filler } = generateFillPrompt(Math.round(prefillTokens * fillScale), { decodeIntegers: DECODE_TOKENS * 4 });
  const prompt = isolatePrompt(filler);
  const startedAt = Date.now();
  try {
    const data = await generate(hostUrl, {
      model: modelName,
      prompt,
      stream: false,
      think: false,
      options: { num_ctx: numCtx, num_predict: DECODE_TOKENS, temperature: 0, seed: 7 },
    }, { timeoutMs, signal });
    const running = await listRunning(hostUrl, { timeoutMs: Math.min(timeoutMs, 30_000), signal });
    const resident = (running?.models || []).find(entry =>
      normalizeModelName(entry?.name || entry?.model) === normalizeModelName(modelName));
    const runtimeContextLength = Number(resident?.context_length ?? resident?.contextLength);
    const promptTokens = Number(data?.prompt_eval_count) || 0;
    const promptEvalMs = ms(data?.prompt_eval_duration);
    const evalCount = Number(data?.eval_count) || 0;
    const evalMs = ms(data?.eval_duration);
    const firstTokenMs = evalCount > 0 && evalMs ? evalMs / evalCount : null;
    const coverage = promptTokens / prefillTokens;
    const status = runtimeContextLength !== numCtx ? 'context_mismatch'
      : coverage < MIN_PROMPT_COVERAGE_RATIO ? 'prompt_underfill'
        : !(promptEvalMs > 0) ? 'invalid_timing' : 'pass';
    return {
      status,
      promptTokens,
      promptCoveragePct: Number((coverage * 100).toFixed(1)),
      prefillTokensPerSec: promptEvalMs > 0 ? Number((promptTokens / (promptEvalMs / 1000)).toFixed(2)) : null,
      promptEvalDurationMs: promptEvalMs,
      ttftMs: promptEvalMs > 0 && firstTokenMs != null ? Number((promptEvalMs + firstTokenMs).toFixed(1)) : null,
      loadDurationMs: ms(data?.load_duration),
      completionTokens: evalCount,
      runtimeContextLength: Number.isInteger(runtimeContextLength) ? runtimeContextLength : null,
      latencyMs: Date.now() - startedAt,
      fillScale: Number(fillScale.toFixed(4)),
      error: status === 'context_mismatch'
        ? `Ollama ran the request at ${Number.isFinite(runtimeContextLength) ? runtimeContextLength : 'an unknown'} context, not ${numCtx}`
        : status === 'prompt_underfill' ? `Prompt evaluation ${promptTokens}/${prefillTokens} tokens` : null,
    };
  } catch (error) {
    if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : error);
    return { status: 'error', latencyMs: Date.now() - startedAt, fillScale, error: error.message };
  }
}

/**
 * @returns {Promise<object>} the series, stored as prefillDecodeMatrix.longPrefill
 */
async function runLongPrefillSeries(hostUrl, modelName, {
  safeNumCtx, timeoutMs = 420000, signal, assertClaimActive = () => {}, onProgress = () => {},
  repeats = DEFAULT_REPEATS, windows = parseTokens(process.env.PROFILER_MATRIX_LONG_PREFILL_TOKENS),
} = {}) {
  const safe = Number(safeNumCtx) > 0 ? Math.floor(Number(safeNumCtx)) : null;
  const sizes = [];
  let fillScale = 1;
  for (const [index, numCtx] of windows.entries()) {
    assertClaimActive();
    const prefill = Math.floor(numCtx * FILL_RATIO);
    if (safe == null || numCtx > safe) {
      const skipped = { prefillTokens: prefill, numCtx, status: 'skipped', samples: [],
        error: safe == null ? 'No verified safe context' : `Requires ${numCtx} ctx > safe ${safe}` };
      sizes.push(skipped);
      onProgress({ index: index + 1, total: windows.length, size: skipped });
      continue;
    }
    const samples = [];
    let retries = 0;
    while (samples.length < repeats) {
      assertClaimActive();
      const sample = await runSample(hostUrl, modelName, { prefillTokens: prefill, numCtx, fillScale, timeoutMs, signal });
      assertClaimActive();
      if (sample.promptTokens > 0) {
        fillScale = Math.min(2, Math.max(0.5, fillScale * prefill / sample.promptTokens));
      }
      if (sample.status === 'prompt_underfill' && retries < MAX_CALIBRATION_RETRIES) {
        retries += 1;
        continue;
      }
      samples.push(sample);
      if (sample.status !== 'pass') break;
    }
    const passing = samples.filter(sample => sample.status === 'pass');
    const result = {
      prefillTokens: prefill,
      numCtx,
      status: passing.length === repeats ? 'pass' : (samples.find(sample => sample.status !== 'pass')?.status || 'error'),
      sampleCount: samples.length,
      prefillTokensPerSec: median(passing.map(sample => sample.prefillTokensPerSec)),
      ttftMs: median(passing.map(sample => sample.ttftMs)),
      // The first sample at a new window usually reloads the model.
      loadDurationMs: samples[0]?.loadDurationMs ?? null,
      samples,
      error: passing.length === repeats ? null : (samples.find(sample => sample.status !== 'pass')?.error || null),
    };
    sizes.push(result);
    onProgress({ index: index + 1, total: windows.length, size: result });
    if (result.status === 'error') break;
  }
  return { fillRatio: FILL_RATIO, decodeTokens: DECODE_TOKENS, repeats, sizes };
}

module.exports = {
  DEFAULT_LONG_PREFILL_WINDOWS,
  runLongPrefillSeries,
  _internal: { parseTokens, median },
};
