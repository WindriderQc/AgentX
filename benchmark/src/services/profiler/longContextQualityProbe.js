'use strict';

/**
 * Long-context quality probe (#367): does the model still find planted facts
 * and follow a two-hop chain when its window is filled to agent sizes?
 *
 * Runs in the Full profile, under the profiler's Core workload reservation,
 * after the context probe has verified the largest window. Each size gets one
 * document filled to about 80 % of its window (longContextQualityPayload.js).
 * The prompt is recalibrated from Ollama's prompt_eval_count when it underfills
 * or would not leave room for the answer, so a size is scored only at its real
 * fill. The quality-verified context is the largest size that passed with
 * every smaller size passing too.
 */

const { generate, listRunning } = require('../../clients/ollamaClient');
const { buildQualityPrompt, scoreQualityResponse, PAYLOAD_VERSION } = require('./longContextQualityPayload');

const PROBE_VERSION = 1;
const DEFAULT_SIZES = Object.freeze([32768, 65536, 131072, 196608]);
const FILL_RATIO = 0.8;
const MIN_FILL_RATIO = 0.6;
const NUM_PREDICT = 256;
const MAX_ATTEMPTS = 3;
const INITIAL_CHARS_PER_TOKEN = 4;

const normalizeModelName = value => String(value || '').trim().replace(/:latest$/i, '').toLowerCase();

function parseSizes(raw) {
  if (!raw) return [...DEFAULT_SIZES];
  const values = String(raw).split(',').map(part => Number.parseInt(part.trim(), 10))
    .filter(value => Number.isInteger(value) && value >= 4096);
  return values.length ? [...new Set(values)].sort((a, b) => a - b) : [...DEFAULT_SIZES];
}

/**
 * The sizes to test: the configured ones that fit the verified window, then
 * the verified window itself when it is larger (the model maximum that fits).
 */
function qualitySizes(maxVerifiedContext, sizes = parseSizes(process.env.PROFILER_LONG_CONTEXT_QUALITY_TOKENS)) {
  const max = Number(maxVerifiedContext);
  if (!Number.isInteger(max) || max <= 0) return [];
  const fitting = sizes.filter(size => size <= max);
  if (!fitting.length || max > fitting[fitting.length - 1]) fitting.push(max);
  return fitting.filter(size => size >= sizes[0]);
}

async function attestContext(hostUrl, modelName, numCtx, { timeoutMs, signal }) {
  const running = await listRunning(hostUrl, { timeoutMs: Math.min(timeoutMs, 30_000), signal });
  const resident = (running?.models || []).find(entry =>
    normalizeModelName(entry?.name || entry?.model) === normalizeModelName(modelName));
  const observed = Number(resident?.context_length ?? resident?.contextLength);
  return Number.isInteger(observed) ? observed : null;
}

const ms = ns => (Number(ns) > 0 ? Number((Number(ns) / 1e6).toFixed(1)) : null);

/**
 * Probe one size. Returns its scored result, or a status naming why it could
 * not be scored (underfill, overflow, context mismatch, no answer, error).
 */
async function probeSize(hostUrl, modelName, numCtx, { timeoutMs, signal, checkpoint = () => {}, charsPerToken }) {
  const seed = numCtx;
  const answerRoom = NUM_PREDICT + 64;
  let ratio = charsPerToken || INITIAL_CHARS_PER_TOKEN;
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    checkpoint();
    const targetTokens = Math.floor(numCtx * FILL_RATIO);
    const built = buildQualityPrompt(Math.floor(targetTokens * ratio), seed);
    const startedAt = Date.now();
    let data;
    try {
      data = await generate(hostUrl, {
        model: modelName,
        prompt: built.prompt,
        stream: false,
        think: false,
        options: { num_ctx: numCtx, num_predict: NUM_PREDICT, temperature: 0, seed: 7 },
      }, { timeoutMs, signal });
    } catch (error) {
      if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : error);
      return { numCtx, status: 'error', attempt, error: error.message, latencyMs: Date.now() - startedAt, charsPerToken: ratio };
    }
    checkpoint();
    const runtimeContextLength = await attestContext(hostUrl, modelName, numCtx, { timeoutMs, signal }).catch(() => null);
    const promptTokens = Number(data?.prompt_eval_count) || 0;
    if (promptTokens > 0) ratio = built.prompt.length / promptTokens;
    const measured = {
      numCtx,
      attempt,
      promptTokens,
      promptCoveragePct: Number(((promptTokens / numCtx) * 100).toFixed(1)),
      completionTokens: Number(data?.eval_count) || 0,
      doneReason: data?.done_reason || null,
      loadDurationMs: ms(data?.load_duration),
      promptEvalDurationMs: ms(data?.prompt_eval_duration),
      latencyMs: Date.now() - startedAt,
      runtimeContextLength,
      charsPerToken: Number(ratio.toFixed(3)),
    };
    if (runtimeContextLength !== numCtx) {
      return { ...measured, status: 'context_mismatch', error: `Ollama ran the request at ${runtimeContextLength ?? 'an unknown'} context, not ${numCtx}` };
    }
    // Ollama drops the start of a prompt that does not fit: a facts-at-5 % miss
    // would then say nothing about the model.
    if (promptTokens + answerRoom > numCtx) {
      last = { ...measured, status: 'overflow', error: `Prompt ${promptTokens} tokens leaves no room for the answer in ${numCtx}` };
      continue;
    }
    if (promptTokens < numCtx * MIN_FILL_RATIO) {
      last = { ...measured, status: 'underfill', error: `Prompt ${promptTokens} tokens fills under ${MIN_FILL_RATIO * 100} % of ${numCtx}` };
      continue;
    }
    const response = String(data?.response || '');
    if (!response.trim()) {
      return { ...measured, status: 'no_answer', error: 'The model returned no visible answer' };
    }
    const score = scoreQualityResponse(response, built);
    return { ...measured, status: score.passed ? 'pass' : 'fail', ...score };
  }
  return last;
}

/**
 * Run the probe over the sizes that fit. Stops after a request error (a larger
 * window will not answer either); a wrong answer does not stop it, so the
 * scores show how recall changes with size.
 *
 * @returns {Promise<object>} evidence stored as profile.longContextQuality
 */
async function runLongContextQualityProbe(hostUrl, modelName, {
  maxVerifiedContext, timeoutMs = 420000, signal, checkpoint = () => {}, onProgress = () => {}, sizes,
} = {}) {
  const planned = qualitySizes(maxVerifiedContext, sizes);
  const results = [];
  let charsPerToken = INITIAL_CHARS_PER_TOKEN;
  for (const [index, numCtx] of planned.entries()) {
    const result = await probeSize(hostUrl, modelName, numCtx, { timeoutMs, signal, checkpoint, charsPerToken });
    if (result.charsPerToken > 0) charsPerToken = result.charsPerToken;
    results.push(result);
    onProgress({ index: index + 1, total: planned.length, result });
    if (result.status === 'error') break;
  }
  let qualityVerifiedContext = null;
  for (const result of results) {
    if (result.status !== 'pass') break;
    qualityVerifiedContext = result.numCtx;
  }
  const firstMiss = results.find(result => result.status !== 'pass') || null;
  return {
    version: PROBE_VERSION,
    payloadVersion: PAYLOAD_VERSION,
    measuredAt: new Date(),
    fillRatio: FILL_RATIO,
    passCriterion: 'all five planted facts and the two-hop answer exact',
    plannedSizes: planned,
    results,
    qualityVerifiedContext,
    firstMiss: firstMiss ? { numCtx: firstMiss.numCtx, status: firstMiss.status } : null,
  };
}

module.exports = {
  DEFAULT_SIZES,
  PROBE_VERSION,
  qualitySizes,
  runLongContextQualityProbe,
  _internal: { parseSizes, probeSize },
};
