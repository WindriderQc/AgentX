'use strict';

/**
 * Concurrency probe (#833): how much a model and each model already resident
 * beside it slow each other when both answer at once. On one endpoint this is
 * the cost of serving two lanes from one pool. Across endpoints of the same
 * machine (a GPU service and a CPU-only service) it is the cost of the two
 * lanes sharing cores, RAM bandwidth and the GPU feeder thread.
 *
 * It never loads, evicts or resizes a model: both are called at the context
 * they are resident with, and a call that reloads either model invalidates
 * the pair. Sibling endpoints are probed only when the caller passes them,
 * which it does only when the Core reservation covers them; otherwise they are
 * reported as not measured.
 */

const { generate, listRunning } = require('../../clients/ollamaClient');
const { isSameOllamaModel } = require('../../helpers/ollamaModelIdentity');
const { isEmbeddingModelName } = require('../../../../shared/embeddingModels');

const PROBE_VERSION = 2;
const REPEATS = 3;
const MAX_PAIRS = 3;
const NUM_PREDICT = 128;
const RELOAD_MS = 1000;
const NOT_COVERED = 'not_measured: needs a Core reservation covering both endpoints';
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
const worst = (pairs, key) => (pairs.length ? Math.max(...pairs.map(pair => pair[key] ?? 0)) : null);

function residents(running, modelName) {
  const models = Array.isArray(running?.models) ? running.models : [];
  const self = modelName ? models.find(item => isSameOllamaModel(item.name || item.model, modelName)) || null : null;
  const others = models
    .filter(item => item !== self && !isEmbeddingModelName(item.name || item.model || ''))
    .map(item => ({ model: item.name || item.model, contextLength: Number(item.context_length) || null }));
  return { self, others };
}

async function call(hostUrl, model, numCtx, { timeoutMs, signal }) {
  return generate(hostUrl, { model, prompt: PROMPT, stream: false, think: false,
    options: { num_ctx: numCtx, num_predict: NUM_PREDICT, temperature: 0, seed: 7 } }, { timeoutMs, signal });
}

/** `other.hostUrl` is the endpoint the other model is resident on (this one or a sibling). */
async function measurePair(hostUrl, modelName, selfCtx, other, { timeoutFor, signal, checkpoint }) {
  const otherUrl = other.hostUrl || hostUrl;
  const selfOpts = { timeoutMs: timeoutFor(hostUrl), signal };
  const otherOpts = { timeoutMs: timeoutFor(otherUrl), signal };
  const selfSolo = []; const otherSolo = []; const selfTogether = []; const otherTogether = [];
  let reload = false;
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    checkpoint();
    const a = await call(hostUrl, modelName, selfCtx, selfOpts);
    const b = await call(otherUrl, other.model, other.contextLength, otherOpts);
    checkpoint();
    const [c, d] = await Promise.all([
      call(hostUrl, modelName, selfCtx, selfOpts),
      call(otherUrl, other.model, other.contextLength, otherOpts)
    ]);
    reload = reload || [a, b, c, d].some(reloaded);
    selfSolo.push(rate(a)); otherSolo.push(rate(b)); selfTogether.push(rate(c)); otherTogether.push(rate(d));
  }
  const result = {
    model: other.model,
    contextLength: other.contextLength,
    endpoint: otherUrl === hostUrl ? 'same' : 'sibling',
    hostUrl: otherUrl,
    selfSoloTokensPerSec: median(selfSolo),
    selfTogetherTokensPerSec: median(selfTogether),
    otherSoloTokensPerSec: median(otherSolo),
    otherTogetherTokensPerSec: median(otherTogether)
  };
  result.selfSlowdownPct = slowdown(result.selfSoloTokensPerSec, result.selfTogetherTokensPerSec);
  // On a much slower sibling the faster call ends first, so this covers only the overlap.
  result.otherSlowdownPct = slowdown(result.otherSoloTokensPerSec, result.otherTogetherTokensPerSec);
  result.status = reload ? 'reloaded' : 'measured';
  return result;
}

async function readResidents(hostUrl, modelName, signal) {
  return residents(await listRunning(hostUrl, { timeoutMs: 30000, signal }), modelName);
}

function rethrowAbort(signal, error) {
  if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : error);
}

/**
 * siblingEndpoints: other Ollama endpoints of the same machine that the
 * caller's Core reservation covers. Their resident chat models are paired too.
 *
 * @returns {Promise<object>} evidence stored as profile.concurrency
 */
async function runConcurrencyProbe(hostUrl, modelName, {
  timeoutMs = 420000, timeoutFor = () => timeoutMs, siblingEndpoints = [], signal,
  checkpoint = () => {}, onProgress = () => {}
} = {}) {
  const siblings = [...new Set(siblingEndpoints.filter(url => url && url !== hostUrl))];
  const base = { version: PROBE_VERSION, measuredAt: new Date(), scope: siblings.length ? 'same_machine' : 'same_endpoint',
    pairs: [], separateEndpoints: siblings.length ? 'unmeasured' : NOT_COVERED, siblingEndpoints: siblings };
  let before;
  try {
    before = await readResidents(hostUrl, modelName, signal);
  } catch (error) {
    rethrowAbort(signal, error);
    return { ...base, status: 'inventory_unavailable' };
  }
  const selfCtx = Number(before.self?.context_length) || null;
  if (!selfCtx) return { ...base, status: 'not_resident' };

  const candidates = before.others.filter(other => other.contextLength).slice(0, MAX_PAIRS)
    .map(other => ({ ...other, hostUrl }));
  let siblingStatus = base.separateEndpoints;
  const siblingCandidates = [];
  for (const sibling of siblings) {
    try {
      const found = await readResidents(sibling, null, signal);
      siblingCandidates.push(...found.others.filter(other => other.contextLength).map(other => ({ ...other, hostUrl: sibling })));
    } catch (error) {
      rethrowAbort(signal, error);
      siblingStatus = 'inventory_unavailable';
    }
  }
  if (siblings.length && siblingStatus === 'unmeasured' && !siblingCandidates.length) siblingStatus = 'no_co_resident';
  candidates.push(...siblingCandidates.slice(0, MAX_PAIRS));
  if (!candidates.length) return { ...base, status: 'no_co_resident', separateEndpoints: siblingStatus };

  const pairs = [];
  for (const [index, other] of candidates.entries()) {
    let pair;
    try {
      pair = await measurePair(hostUrl, modelName, selfCtx, other, { timeoutFor, signal, checkpoint });
    } catch (error) {
      rethrowAbort(signal, error);
      pair = { model: other.model, endpoint: other.hostUrl === hostUrl ? 'same' : 'sibling', hostUrl: other.hostUrl,
        status: 'error', error: error.message };
    }
    // Two models that do not fit together evict one another: that is the
    // finding, and the speeds measured meanwhile mean nothing.
    const empty = { self: null, others: [] };
    const selfAfter = await readResidents(hostUrl, modelName, signal).catch(() => empty);
    const otherAfter = other.hostUrl === hostUrl ? selfAfter
      : await readResidents(other.hostUrl, null, signal).catch(() => empty);
    if (pair.status !== 'error' && (!selfAfter.self || !otherAfter.others.some(item => isSameOllamaModel(item.model, other.model)))) {
      pair = { ...pair, status: 'evicted' };
    }
    pairs.push(pair);
    onProgress({ index: index + 1, total: candidates.length, pair });
    if (pair.status === 'evicted') break;
  }
  const statusOf = list => (list.some(pair => pair.status === 'measured') ? 'measured'
    : list.some(pair => pair.status === 'evicted') ? 'evicted' : 'unmeasured');
  const measured = pairs.filter(pair => pair.status === 'measured');
  const siblingPairs = pairs.filter(pair => pair.endpoint === 'sibling');
  const siblingMeasured = siblingPairs.filter(pair => pair.status === 'measured');
  if (siblingPairs.length) siblingStatus = statusOf(siblingPairs);
  return {
    ...base,
    status: statusOf(pairs),
    separateEndpoints: siblingStatus,
    selfContextLength: selfCtx,
    pairs,
    worstSelfSlowdownPct: worst(measured, 'selfSlowdownPct'),
    worstOtherSlowdownPct: worst(measured, 'otherSlowdownPct'),
    worstSiblingSelfSlowdownPct: worst(siblingMeasured, 'selfSlowdownPct'),
    worstSiblingOtherSlowdownPct: worst(siblingMeasured, 'otherSlowdownPct')
  };
}

module.exports = { PROBE_VERSION, REPEATS, runConcurrencyProbe, _internal: { residents, measurePair, rate, slowdown } };
