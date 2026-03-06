/**
 * Context Probe Service
 *
 * Empirically tests the maximum usable context window for a model on its host.
 * Uses binary search over num_ctx values, measuring tokens/sec at each step.
 * Detects the VRAM→CPU spill cliff where performance degrades beyond a threshold.
 *
 * Configuration (env vars):
 *   CONTEXT_PROBE_DEGRADATION_PCT  - Speed drop % that marks the limit (default 50)
 *   CONTEXT_PROBE_ON_SYNC          - Auto-probe new models on sync (default false)
 *   CONTEXT_PROBE_TIMEOUT_MS       - Per-step timeout (default 120000)
 *   CONTEXT_PROBE_MIN_CTX          - Baseline context size (default 2048)
 */

const ModelRegistry = require('../../../models/ModelRegistry');
const ollamaVramService = require('../ollamaVramService');
const { getFetchOptions } = require('../../helpers/httpAgent');
const { generateFillPrompt } = require('./contextProbePayload');
const logger = require('../../../config/logger');

// ── Configuration ──────────────────────────────────────────────────────────────

const DEFAULT_DEGRADATION_PCT = 50;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MIN_CTX = 2048;
const CANDIDATE_CTX_SIZES = [2048, 4096, 8192, 16384, 32768, 65536, 131072];

function getConfig() {
  return {
    degradationPct: parseInt(process.env.CONTEXT_PROBE_DEGRADATION_PCT, 10) || DEFAULT_DEGRADATION_PCT,
    timeoutMs: parseInt(process.env.CONTEXT_PROBE_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
    minCtx: parseInt(process.env.CONTEXT_PROBE_MIN_CTX, 10) || DEFAULT_MIN_CTX,
    autoProbeOnSync: (process.env.CONTEXT_PROBE_ON_SYNC || 'false').toLowerCase() === 'true'
  };
}

// ── Ollama helpers ─────────────────────────────────────────────────────────────

/**
 * Query Ollama /api/show for model metadata (theoretical max context).
 * @param {string} hostUrl
 * @param {string} modelName
 * @returns {Promise<number|null>} context_length or null
 */
async function fetchModelTheoreticalMax(hostUrl, modelName) {
  try {
    const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
    const res = await fetch(`${hostUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      timeout: 15_000,
      ...getFetchOptions(hostUrl)
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Ollama returns model_info with context_length key (varies by model family)
    const info = data.model_info || {};
    // Search for any key containing 'context_length'
    for (const key of Object.keys(info)) {
      if (key.includes('context_length') && typeof info[key] === 'number') {
        return info[key];
      }
    }
    return null;
  } catch (err) {
    logger.warn('Failed to fetch model theoretical max', { hostUrl, modelName, error: err.message });
    return null;
  }
}

/**
 * Send a single probe request to Ollama /api/generate.
 * @param {string} hostUrl
 * @param {string} modelName
 * @param {string} prompt
 * @param {number} numCtx
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, tokensPerSec: number, promptTokens: number, completionTokens: number, latencyMs: number, error?: string }>}
 */
async function sendProbeRequest(hostUrl, modelName, prompt, numCtx, timeoutMs) {
  const start = Date.now();
  try {
    const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
    const res = await fetch(`${hostUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        prompt,
        stream: false,
        options: {
          num_ctx: numCtx,
          num_predict: 16,       // Short output — we only care about prompt processing
          temperature: 0.1
        }
      }),
      timeout: timeoutMs,
      ...getFetchOptions(hostUrl)
    });

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, tokensPerSec: 0, promptTokens: 0, completionTokens: 0, latencyMs, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = await res.json();
    const evalCount = data.eval_count || 0;
    const evalDuration = data.eval_duration || 0;        // nanoseconds
    const promptTokens = data.prompt_eval_count || 0;

    const durationSec = evalDuration / 1e9;
    const tokensPerSec = durationSec > 0 ? evalCount / durationSec : 0;

    return {
      ok: true,
      tokensPerSec: Number(tokensPerSec.toFixed(2)),
      promptTokens,
      completionTokens: evalCount,
      latencyMs
    };
  } catch (err) {
    return {
      ok: false,
      tokensPerSec: 0,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - start,
      error: err.message
    };
  }
}

/**
 * Snapshot VRAM usage for a host (best-effort, returns nulls if unavailable).
 * @param {string} hostUrl
 * @returns {Promise<{ usedMiB: number|null, totalMiB: number|null }>}
 */
async function snapshotVram(hostUrl) {
  try {
    const result = await ollamaVramService.getHostVram(hostUrl);
    if (result.ok) {
      return { usedMiB: result.memoryUsedMiBTotal, totalMiB: result.memoryTotalMiBTotal };
    }
  } catch (_) { /* VRAM monitoring is optional */ }
  return { usedMiB: null, totalMiB: null };
}

/**
 * Check GPU offload percentage via Ollama /api/ps.
 * Returns the ratio of size_vram / size for the target model.
 * A ratio < 1.0 means some layers are on CPU (spill).
 *
 * @param {string} hostUrl
 * @param {string} modelName
 * @returns {Promise<{ gpuPercent: number|null, sizeTotal: number|null, sizeVram: number|null, contextLength: number|null }>}
 */
async function snapshotGpuOffload(hostUrl, modelName) {
  try {
    const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
    const res = await fetch(`${hostUrl}/api/ps`, {
      method: 'GET',
      timeout: 5000,
      ...getFetchOptions(hostUrl)
    });
    if (!res.ok) return { gpuPercent: null, sizeTotal: null, sizeVram: null, contextLength: null };

    const data = await res.json();
    const model = (data.models || []).find(m =>
      m.name === modelName || m.model === modelName ||
      m.name.split(':')[0] === modelName.split(':')[0]
    );
    if (!model) return { gpuPercent: null, sizeTotal: null, sizeVram: null, contextLength: null };

    const sizeTotal = model.size || 0;
    const sizeVram = model.size_vram || 0;
    const gpuPercent = sizeTotal > 0 ? Number(((sizeVram / sizeTotal) * 100).toFixed(1)) : null;

    return {
      gpuPercent,
      sizeTotal,
      sizeVram,
      contextLength: model.context_length || null
    };
  } catch (_) {
    return { gpuPercent: null, sizeTotal: null, sizeVram: null, contextLength: null };
  }
}

// ── Core probe logic ───────────────────────────────────────────────────────────

/**
 * Run a single probe step at a given num_ctx.
 * @returns {Promise<object>} Step result
 */
async function runStep(hostUrl, modelName, numCtx, timeoutMs) {
  // Fill ~80% of context with prompt tokens
  const targetPromptTokens = Math.floor(numCtx * 0.8);
  const { prompt } = generateFillPrompt(targetPromptTokens);

  // Run generation first (this loads the model at the target num_ctx)
  const probeResult = await sendProbeRequest(hostUrl, modelName, prompt, numCtx, timeoutMs);

  // Snapshot VRAM and GPU offload after generation (model is loaded at target ctx)
  const [vram, offload] = await Promise.all([
    snapshotVram(hostUrl),
    snapshotGpuOffload(hostUrl, modelName)
  ]);

  return {
    numCtx,
    tokensPerSec: probeResult.tokensPerSec,
    promptTokens: probeResult.promptTokens,
    completionTokens: probeResult.completionTokens,
    vramUsedMiB: vram.usedMiB,
    vramTotalMiB: vram.totalMiB,
    gpuPercent: offload.gpuPercent,
    gpuSizeTotal: offload.sizeTotal,
    gpuSizeVram: offload.sizeVram,
    ollamaContextLength: offload.contextLength,
    latencyMs: probeResult.latencyMs,
    passed: probeResult.ok,
    reason: probeResult.ok ? null : probeResult.error
  };
}

/**
 * Probe a model's maximum usable context window using binary search.
 *
 * @param {string} modelName - Registry model name
 * @param {object} [options]
 * @param {number} [options.degradationPct] - Override degradation threshold
 * @param {number} [options.timeoutMs] - Override per-step timeout
 * @param {boolean} [options.force] - Re-test even if already tested
 * @returns {Promise<{ status: string, testedNumCtx: number|null, steps: object[], durationMs: number }>}
 */
async function probeModelContext(modelName, options = {}) {
  const cfg = getConfig();
  const degradationPct = options.degradationPct ?? cfg.degradationPct;
  const timeoutMs = options.timeoutMs ?? cfg.timeoutMs;
  const minCtx = cfg.minCtx;

  // 1. Resolve model & host
  const model = await ModelRegistry.findOne({ modelName });
  if (!model) throw new Error(`Model not found in registry: ${modelName}`);

  const hostUrl = model.sourceHost || model.host;
  if (!hostUrl) throw new Error(`No host URL for model: ${modelName}`);

  // Guard against concurrent probes
  if (model.contextTest?.status === 'running' && !options.force) {
    throw new Error(`Context probe already running for ${modelName}`);
  }

  // Mark as running
  await ModelRegistry.updateOne(
    { modelName },
    { $set: { 'contextTest.status': 'running', 'contextTest.error': null } }
  );

  const probeStart = Date.now();
  const steps = [];

  try {
    // 2. Get theoretical max from /api/show
    const theoreticalMax = await fetchModelTheoreticalMax(hostUrl, modelName);
    logger.info('Context probe: theoretical max', { modelName, theoreticalMax });

    // 3. Build candidate list
    const upperBound = theoreticalMax || 131072;
    const candidates = CANDIDATE_CTX_SIZES.filter(c => c <= upperBound);
    if (candidates.length === 0) {
      throw new Error(`No valid candidates: upperBound=${upperBound}`);
    }

    // Ensure minCtx is in the list
    if (!candidates.includes(minCtx) && minCtx < candidates[0]) {
      candidates.unshift(minCtx);
    }

    // 4. Run baseline at minimum context
    logger.info('Context probe: running baseline', { modelName, numCtx: candidates[0] });
    const baseline = await runStep(hostUrl, modelName, candidates[0], timeoutMs);
    steps.push(baseline);

    if (!baseline.passed) {
      throw new Error(`Baseline failed at num_ctx=${candidates[0]}: ${baseline.reason}`);
    }

    const baselineSpeed = baseline.tokensPerSec;
    if (baselineSpeed <= 0) {
      throw new Error('Baseline produced 0 tokens/sec — cannot calculate degradation');
    }

    baseline.passed = true;
    baseline.reason = `Baseline: ${baselineSpeed} tok/s`;

    // 5. Binary search for max passing context
    let low = 1;                          // Start above baseline (index 0)
    let high = candidates.length - 1;
    let bestPassingIdx = 0;               // Baseline always passes

    const speedThreshold = baselineSpeed * (1 - degradationPct / 100);

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const testCtx = candidates[mid];

      logger.info('Context probe: testing', { modelName, numCtx: testCtx, low, high, mid });

      const step = await runStep(hostUrl, modelName, testCtx, timeoutMs);

      // Determine pass/fail — check both speed degradation AND GPU spill
      const hasGpuSpill = step.gpuPercent !== null && step.gpuPercent < 100;
      const speedOk = step.passed && step.tokensPerSec >= speedThreshold;

      if (speedOk && !hasGpuSpill) {
        const drop = ((1 - step.tokensPerSec / baselineSpeed) * 100).toFixed(1);
        step.passed = true;
        step.reason = `${step.tokensPerSec} tok/s (${drop}% drop) GPU=${step.gpuPercent ?? '?'}%`;
        bestPassingIdx = mid;
        low = mid + 1;
      } else {
        let failReason;
        if (hasGpuSpill) {
          failReason = `GPU spill: ${step.gpuPercent}% on GPU (${step.tokensPerSec} tok/s)`;
        } else if (!step.passed) {
          failReason = step.reason || 'Request failed';
        } else {
          failReason = `${step.tokensPerSec} tok/s < threshold ${speedThreshold.toFixed(1)} tok/s`;
        }
        step.passed = false;
        step.reason = failReason;
        high = mid - 1;
      }

      steps.push(step);
    }

    // 6. Build final result
    const testedNumCtx = candidates[bestPassingIdx];
    const bestStep = steps.find(s => s.numCtx === testedNumCtx && s.passed);
    const degradation = bestStep
      ? Number(((1 - bestStep.tokensPerSec / baselineSpeed) * 100).toFixed(1))
      : 0;

    const result = {
      testedNumCtx,
      baselineTokensPerSec: baselineSpeed,
      atLimitTokensPerSec: bestStep?.tokensPerSec ?? baselineSpeed,
      degradationPct: degradation,
      vramAtLimitMiB: bestStep?.vramUsedMiB ?? null,
      gpuPercentAtLimit: bestStep?.gpuPercent ?? null,
      modelTheoreticalMax: theoreticalMax,
      degradationThreshold: degradationPct,
      testedAt: new Date(),
      testDurationMs: Date.now() - probeStart,
      hostUrl,
      status: 'completed',
      error: null,
      steps
    };

    // 7. Persist
    await ModelRegistry.updateOne(
      { modelName },
      {
        $set: {
          contextTest: result,
          'capabilities.maxContext': testedNumCtx,
          lastUpdated: new Date()
        }
      }
    );

    logger.info('Context probe completed', { modelName, testedNumCtx, steps: steps.length, durationMs: result.testDurationMs });
    return { status: 'completed', testedNumCtx, steps, durationMs: result.testDurationMs };

  } catch (err) {
    const durationMs = Date.now() - probeStart;
    await ModelRegistry.updateOne(
      { modelName },
      {
        $set: {
          'contextTest.status': 'failed',
          'contextTest.error': err.message,
          'contextTest.testedAt': new Date(),
          'contextTest.testDurationMs': durationMs,
          'contextTest.steps': steps
        }
      }
    );
    logger.error('Context probe failed', { modelName, error: err.message, durationMs });
    throw err;
  }
}

// ── Query helpers ──────────────────────────────────────────────────────────────

/**
 * Get the current context probe status for a model.
 * @param {string} modelName
 * @returns {Promise<object|null>}
 */
async function getProbeStatus(modelName) {
  const model = await ModelRegistry.findOne({ modelName }, { contextTest: 1 }).lean();
  return model?.contextTest || null;
}

/**
 * Get the best-known available context for a model.
 * Priority: user override → tested → auto-detected → system default.
 *
 * @param {object} registryDoc - A ModelRegistry document (or lean object)
 * @returns {{ numCtx: number, source: string, confidence: string }}
 */
function getAvailableContext(registryDoc) {
  if (registryDoc.executionOverrides?.num_ctx != null) {
    return { numCtx: registryDoc.executionOverrides.num_ctx, source: 'user', confidence: 'high' };
  }
  if (registryDoc.contextTest?.testedNumCtx != null && registryDoc.contextTest.status === 'completed') {
    return { numCtx: registryDoc.contextTest.testedNumCtx, source: 'tested', confidence: 'high' };
  }
  if (registryDoc.executionDefaults?.num_ctx != null) {
    return { numCtx: registryDoc.executionDefaults.num_ctx, source: 'auto', confidence: 'medium' };
  }
  return { numCtx: 8192, source: 'system', confidence: 'low' };
}

module.exports = {
  probeModelContext,
  getProbeStatus,
  getAvailableContext,
  getConfig,
  // Exported for testing
  _internal: { fetchModelTheoreticalMax, sendProbeRequest, snapshotVram, snapshotGpuOffload, runStep }
};
