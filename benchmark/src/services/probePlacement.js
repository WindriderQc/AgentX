'use strict';

/**
 * Placement rule for profiler evidence on a host's declared residency.
 *
 * A GPU host proves a measurement only with the model wholly in VRAM. A CPU
 * host (a second Ollama instance with its GPU hidden) proves it with no VRAM
 * share at all. A partial placement never proves anything.
 */

const { placementMatches } = require('../../../shared/gpuResidency');
const hostConfig = require('../helpers/ollamaHostConfig');

const DEFAULT_CPU_MAX_CTX = 32768;
const DEFAULT_CPU_TIMEOUT_MS = 1_200_000;

function residencyOf(hostUrl) {
  return typeof hostConfig.getHostResidency === 'function' ? hostConfig.getHostResidency(hostUrl) : 'gpu';
}

function placementVerified(sizeTotal, sizeVram, residency = 'gpu') {
  const size = Number(sizeTotal);
  const vram = Number(sizeVram);
  if (sizeTotal == null || sizeVram == null || !Number.isFinite(size) || size <= 0 || !Number.isFinite(vram)) return false;
  return placementMatches({ size, size_vram: vram }, residency);
}

/** Observed placement contradicts the host's residency (a spill on GPU, VRAM use on CPU). */
function placementMismatch(hostUrl, sizeTotal, sizeVram) {
  return !placementVerified(sizeTotal, sizeVram, residencyOf(hostUrl));
}

/**
 * A CPU probe stops at a bounded context and waits longer per step: CPU
 * prefill takes minutes where a GPU takes seconds. Explicit options win.
 */
function cpuProbeLimits(hostUrl) {
  if (residencyOf(hostUrl) !== 'cpu') return {};
  return {
    maxCtx: parseInt(process.env.CONTEXT_PROBE_CPU_MAX_CTX, 10) || DEFAULT_CPU_MAX_CTX,
    timeoutMs: parseInt(process.env.CONTEXT_PROBE_CPU_TIMEOUT_MS, 10) || DEFAULT_CPU_TIMEOUT_MS
  };
}

/**
 * A profiler request on a CPU host decodes at a few tokens per second, so a
 * GPU-sized bound (60 s) cuts it mid-answer and leaves no terminal receipt.
 * On a CPU host every profiler request gets at least the CPU probe timeout.
 */
function residencyTimeoutMs(hostUrl, timeoutMs) {
  const requested = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
  return Math.max(requested, cpuProbeLimits(hostUrl).timeoutMs || 0) || timeoutMs;
}

module.exports = { residencyOf, placementVerified, placementMismatch, cpuProbeLimits, residencyTimeoutMs };
