'use strict';

/**
 * One context-probe sample: a filled prompt sent at a requested context, then
 * the VRAM and residency observed once it ended.
 */

const ollamaVramService = require('./ollamaVramService');
const { generateFillPrompt } = require('./contextProbePayload');
const { snapshotGpuOffload } = require('./probeResidency');

// Decode length per probe step. The old value (16) only exercised prefill, so a
// context could pass the probe yet stall during a real (longer) generation —
// the "detected big context but hangs in use" gap. 64 exercises sustained
// decode at the tested fill without making the probe crawl. Env-overridable.
const PROBE_NUM_PREDICT = parseInt(process.env.CONTEXT_PROBE_NUM_PREDICT, 10) || 64;
const MIN_PROBE_COMPLETION_TOKENS = Math.min(
  PROBE_NUM_PREDICT,
  parseInt(process.env.CONTEXT_PROBE_MIN_COMPLETION_TOKENS, 10)
    || Math.max(4, Math.floor(PROBE_NUM_PREDICT * 0.5))
);

/**
 * Reject only structurally impossible/corrupt throughput readings. Hardware,
 * quantization, and active-weight estimates are not measured context evidence
 * and must not decide whether a successful probe is persisted.
 * @returns {{ plausible: boolean, detail: string|null }}
 */
function validateThroughput(tokensPerSec) {
  const value = Number(tokensPerSec);
  if (tokensPerSec === null || tokensPerSec === undefined || !Number.isFinite(value) || value < 0) {
    return { plausible: false, detail: `${tokensPerSec} tok/s is not a non-negative finite measurement` };
  }
  return { plausible: true, detail: null };
}

const sendProbeRequest = (hostUrl, modelName, prompt, numCtx, timeoutMs, signal = null) =>
  require('./contextProbeRequest').sendProbeRequest(hostUrl, modelName, prompt, numCtx, timeoutMs, signal, PROBE_NUM_PREDICT);

async function snapshotVram(hostUrl, signal = null) {
  try {
    const result = await ollamaVramService.getHostVram(hostUrl, { signal });
    if (result.ok) {
      return { usedMiB: result.memoryUsedMiBTotal, totalMiB: result.memoryTotalMiBTotal };
    }
  } catch (error) {
    if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : error);
    // best effort
  }
  return { usedMiB: null, totalMiB: null };
}

async function runStep(hostUrl, modelName, numCtx, timeoutMs, promptFillPct = 80, modelContext = {}, options = {}) {
  const fillRatio = Math.min(100, Math.max(5, Number(promptFillPct) || 80)) / 100;
  const { prompt, estimatedTokens } = generateFillPrompt(Math.floor(numCtx * fillRatio));
  const probeResult = await sendProbeRequest(hostUrl, modelName, prompt, numCtx, timeoutMs, options.signal);
  options.assertClaimActive?.();
  const shortCompletion = probeResult.ok && probeResult.completionTokens < MIN_PROBE_COMPLETION_TOKENS;
  const plausibility = probeResult.ok
    ? validateThroughput(probeResult.tokensPerSec)
    : { plausible: true, detail: null };
  const invalidThroughput = probeResult.ok && !plausibility.plausible;
  const zeroThroughputBoundary = probeResult.ok && probeResult.tokensPerSec === 0;
  const [vram, offload] = await Promise.all([
    snapshotVram(hostUrl, options.signal),
    snapshotGpuOffload(hostUrl, modelName, options.signal)
  ]);

  return {
    numCtx,
    requestSucceeded: probeResult.ok,
    transportFailure: probeResult.ok ? false : probeResult.transportFailure === true,
    failureCode: probeResult.ok ? null : (probeResult.errorCode || null),
    tokensPerSec: probeResult.tokensPerSec,
    promptTokens: probeResult.promptTokens,
    estimatedPromptTokens: estimatedTokens,
    promptCoveragePct: probeResult.promptTokens > 0 && estimatedTokens > 0
      ? Number(((probeResult.promptTokens / estimatedTokens) * 100).toFixed(1))
      : null,
    minimumPromptCoveragePct: options.minimumPromptCoveragePct || 70,
    completionTokens: probeResult.completionTokens,
    vramUsedMiB: vram.usedMiB,
    vramTotalMiB: vram.totalMiB,
    gpuPercent: offload.gpuPercent,
    gpuSizeTotal: offload.sizeTotal,
    gpuSizeVram: offload.sizeVram,
    ollamaContextLength: offload.contextLength, residency: offload.residency || 'gpu',
    coResidents: offload.coResidents,
    latencyMs: probeResult.latencyMs,
    promptFillPct: Math.round(fillRatio * 100),
    requestedCompletionTokens: PROBE_NUM_PREDICT,
    minCompletionTokens: MIN_PROBE_COMPLETION_TOKENS,
    passed: probeResult.ok && !shortCompletion && !invalidThroughput && !zeroThroughputBoundary,
    reason: invalidThroughput
      ? `Invalid throughput: ${plausibility.detail}`
      : zeroThroughputBoundary
      ? 'Context ceiling: 0 tok/s'
      : shortCompletion
      ? `Short completion: ${probeResult.completionTokens}/${PROBE_NUM_PREDICT} tokens generated; probe decode sample is invalid`
      : (probeResult.ok ? null : probeResult.error)
  };
}

module.exports = {
  runStep,
  sendProbeRequest,
  snapshotVram,
  validateThroughput,
  PROBE_NUM_PREDICT,
  MIN_PROBE_COMPLETION_TOKENS
};
