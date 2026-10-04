'use strict';

/**
 * Per-model request parallelism as Ollama's scheduler applies it.
 *
 * Ollama reads OLLAMA_NUM_PARALLEL once per server, then gives a model a single
 * request slot when the model cannot complete text (embeddings) or when its
 * family is in the scheduler's sequential list (server/sched.go, load()). The
 * HTTP API exposes neither the configured value nor the slots a runner got, so
 * the family and capabilities are read from /api/show and the list below
 * mirrors the scheduler's. It is that list at the time of writing, not a probe
 * of the running server: a newer Ollama may add or remove families.
 *
 * Only the forced cases are certain. Any other model follows the server's
 * OLLAMA_NUM_PARALLEL, which the caller knows from the GPU collector or a
 * recorded observation.
 */

const logger = require('../../config/logger');
const { modelsMatch } = require('../helpers/modelNameNormalization');

const SEQUENTIAL_FAMILIES = Object.freeze([
  'mllama', 'qwen3vl', 'qwen3vlmoe', 'qwen35', 'qwen35moe', 'qwen3next',
  'lfm2', 'lfm2moe', 'nemotron_h', 'nemotron_h_moe', 'nemotron_h_omni'
]);
const CACHE_TTL_MS = 10 * 60 * 1000;
const SHOW_TIMEOUT_MS = 3000;
const cache = new Map(); // `${hostUrl}::${model}` → { value, expiresAt }

/**
 * @param {object|null} show an /api/show response body
 * @returns {{family:string|null, architecture:string|null, requestSlots:number|null, reason:string}}
 *   requestSlots is 1 when Ollama forces it, null when the server setting applies.
 */
function describeModelParallelism(show) {
  const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
  // The scheduler checks the model family Ollama recorded at create time;
  // /api/show returns it as details.family.
  const family = text(show?.details?.family);
  const architecture = text(show?.model_info?.['general.architecture']) || family;
  const capabilities = Array.isArray(show?.capabilities) ? show.capabilities : null;
  if (!show || (!family && !capabilities)) {
    return { family: null, architecture: null, requestSlots: null, reason: 'unknown' };
  }
  if (capabilities && !capabilities.includes('completion')) {
    return { family, architecture, requestSlots: 1, reason: 'no_completion' };
  }
  if (family && SEQUENTIAL_FAMILIES.includes(family)) {
    return { family, architecture, requestSlots: 1, reason: 'architecture' };
  }
  return { family, architecture, requestSlots: null, reason: 'server_setting' };
}

async function showModel(hostUrl, model, fetchImpl) {
  const response = await fetchImpl(`${hostUrl.replace(/\/+$/, '')}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(SHOW_TIMEOUT_MS),
    redirect: 'error'
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  return response.json();
}

/**
 * Describe each model's request parallelism on one host. A model whose
 * metadata cannot be read is reported as unknown; the read never throws.
 *
 * @param {string} hostUrl
 * @param {string[]} models model names; matching names are read once
 * @returns {Promise<Array<{model:string, family, architecture, requestSlots, reason}>>}
 */
async function readModelParallelism(hostUrl, models, { fetchImpl = fetch, now = Date.now } = {}) {
  const unique = [];
  for (const model of models || []) {
    if (typeof model === 'string' && model && !unique.some(existing => modelsMatch(existing, model))) unique.push(model);
  }
  return Promise.all(unique.map(async (model) => {
    const key = `${hostUrl}::${model}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return { model, ...cached.value };
    try {
      const value = describeModelParallelism(await showModel(hostUrl, model, fetchImpl));
      // An unreadable answer is retried on the next read instead of kept.
      if (value.reason !== 'unknown') cache.set(key, { value, expiresAt: now() + CACHE_TTL_MS });
      return { model, ...value };
    } catch (error) {
      logger.debug('[ollamaModelParallelism] /api/show failed', { hostUrl, model, error: error.message });
      return { model, family: null, architecture: null, requestSlots: null, reason: 'unknown' };
    }
  }));
}

function _clearCache() {
  cache.clear();
}

module.exports = { SEQUENTIAL_FAMILIES, describeModelParallelism, readModelParallelism, _clearCache };
