'use strict';

/**
 * Concurrency probe (#833): how much a model and each model already resident
 * beside it on the same Ollama endpoint slow each other when both answer at
 * once. On a two-GPU host this is the cost of serving two lanes from one pool.
 *
 * It never loads, evicts or resizes a model: both are called at the context
 * they are resident with, and a call that reloads either model invalidates
 * the pair. Models on another endpoint of the same machine need a Core
 * reservation covering both endpoints and are reported as not measured.
 */

const { generate, listRunning } = require('../../clients/ollamaClient');
const { isSameOllamaModel } = require('../../helpers/ollamaModelIdentity');
const { isEmbeddingModelName } = require('../../../../shared/embeddingModels');

const PROBE_VERSION = 1;
const REPEATS = 3;
const MAX_PAIRS = 3;
const NUM_PREDICT = 128;
const RELOAD_MS = 1000;
const PROMPT = 'Explain, in about one hundred words, why a code review should check documented configuration '
  + 'values against the source files, and give two concrete examples of mismatches it can catch.';

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const rate = data => (Number(data?.eval_count) > 0 && Number(data?.eval_duration) > 0
  ? Number((data.eval_count / (data.eval_duration / 1e9)).toFixed(2)) : null);
const reloaded = data => Number(data?.load_duration) / 1e6 > RELOAD_MS;
const slowdown = (solo, together) => (solo && together ? Number((((solo - together) / solo) * 100).toFixed(1)) : null);

function residents(running, modelName) {
  const models = Array.isArray(running?.models) ? running.models : [];
  const self = models.find(item => isSameOllamaModel(item.name || item.model, modelName)) || null;
  const others = models
    .filter(item => item !== self && !isEmbeddingModelName(item.name || item.model || ''))
    .map(item => ({ model: item.name || item.model, contextLength: Number(item.context_length) || null }));
  return { self, others };
}

async function call(hostUrl, model, numCtx, { timeoutMs, signal }) {
  return generate(hostUrl, { model, prompt: PROMPT, stream: false, think: false,
    options: { num_ctx: numCtx, num_predict: NUM_PREDICT, temperature: 0, seed: 7 } }, { timeoutMs, signal });
}

async function measurePair(hostUrl, modelName, selfCtx, other, { timeoutMs, signal, checkpoint }) {
  const selfSolo = []; const otherSolo = []; const selfTogether = []; const otherTogether = [];
  let reload = false;
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    checkpoint();
    const a = await call(hostUrl, modelName, selfCtx, { timeoutMs, signal });
    const b = await call(hostUrl, other.model, other.contextLength, { timeoutMs, signal });
    checkpoint();
    const [c, d] = await Promise.all([
      call(hostUrl, modelName, selfCtx, { timeoutMs, signal }),
      call(hostUrl, other.model, other.contextLength, { timeoutMs, signal })
    ]);
    reload = reload || [a, b, c, d].some(reloaded);
    selfSolo.push(rate(a)); otherSolo.push(rate(b)); selfTogether.push(rate(c)); otherTogether.push(rate(d));
  }
  const result = {
    model: other.model,
    contextLength: other.contextLength,
    selfSoloTokensPerSec: median(selfSolo),
    selfTogetherTokensPerSec: median(selfTogether),
    otherSoloTokensPerSec: median(otherSolo),
    otherTogetherTokensPerSec: median(otherTogether)
  };
  result.selfSlowdownPct = slowdown(result.selfSoloTokensPerSec, result.selfTogetherTokensPerSec);
  result.otherSlowdownPct = slowdown(result.otherSoloTokensPerSec, result.otherTogetherTokensPerSec);
  result.status = reload ? 'reloaded' : 'measured';
  return result;
}

/**
 * @returns {Promise<object>} evidence stored as profile.concurrency
 */
async function runConcurrencyProbe(hostUrl, modelName, {
  timeoutMs = 420000, signal, checkpoint = () => {}, onProgress = () => {}
} = {}) {
  const base = { version: PROBE_VERSION, measuredAt: new Date(), scope: 'same_endpoint', pairs: [],
    separateEndpoints: 'not_measured: needs a Core reservation covering both endpoints' };
  let before;
  try {
    before = residents(await listRunning(hostUrl, { timeoutMs: 30000, signal }), modelName);
  } catch (error) {
    if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : error);
    return { ...base, status: 'inventory_unavailable' };
  }
  const selfCtx = Number(before.self?.context_length) || null;
  if (!selfCtx) return { ...base, status: 'not_resident' };
  const candidates = before.others.filter(other => other.contextLength).slice(0, MAX_PAIRS);
  if (!candidates.length) return { ...base, status: 'no_co_resident' };

  const pairs = [];
  for (const [index, other] of candidates.entries()) {
    let pair;
    try {
      pair = await measurePair(hostUrl, modelName, selfCtx, other, { timeoutMs, signal, checkpoint });
    } catch (error) {
      if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : error);
      pair = { model: other.model, status: 'error', error: error.message };
    }
    // Two models that do not fit together evict one another: that is the
    // finding, and the speeds measured meanwhile mean nothing.
    const after = residents(await listRunning(hostUrl, { timeoutMs: 30000, signal }).catch(() => null), modelName);
    if (pair.status !== 'error' && (!after.self || !after.others.some(item => isSameOllamaModel(item.model, other.model)))) {
      pair = { ...pair, status: 'evicted' };
    }
    pairs.push(pair);
    onProgress({ index: index + 1, total: candidates.length, pair });
    if (pair.status === 'evicted') break;
  }
  const measured = pairs.filter(pair => pair.status === 'measured');
  return {
    ...base,
    status: measured.length ? 'measured' : pairs.some(pair => pair.status === 'evicted') ? 'evicted' : 'unmeasured',
    selfContextLength: selfCtx,
    pairs,
    worstSelfSlowdownPct: measured.length ? Math.max(...measured.map(pair => pair.selfSlowdownPct ?? 0)) : null,
    worstOtherSlowdownPct: measured.length ? Math.max(...measured.map(pair => pair.otherSlowdownPct ?? 0)) : null
  };
}

module.exports = { PROBE_VERSION, REPEATS, runConcurrencyProbe, _internal: { residents, measurePair, rate, slowdown } };
