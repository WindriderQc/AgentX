'use strict';

const MAX_DRAIN_WAIT_MS = 12 * 60_000;

function drainError(message, code) {
  return Object.assign(new Error(message), { code, retainAdmission: true });
}

// Each request keeps the existing bounded Core transport. Only an exact,
// explicit pending-drain receipt permits waiting before the next request.
async function requestReleaseWithDrain(request, expected, {
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(), maxWaitMs = MAX_DRAIN_WAIT_MS
} = {}) {
  const until = now() + maxWaitMs;
  while (true) {
    const result = await request();
    if (result?.callerAbortRecoveryPending !== true) return result;
    const exact = result.released === false
      && result.contract === 'agentx.benchmark-caller-abort-drain/v1'
      && ['hostUrl', 'batchId', 'claimGeneration', 'admissionId', 'admissionGeneration']
        .every(key => typeof expected[key] === 'string' && expected[key] && result[key] === expected[key])
      && Number.isSafeInteger(result.retryAfterMs) && result.retryAfterMs > 0 && result.retryAfterMs <= 5_000;
    if (!exact) throw drainError('Core returned an invalid caller-abort drain receipt', 'BENCHMARK_DRAIN_RECEIPT_INVALID');
    const remaining = until - now();
    if (remaining <= 0) throw drainError('Core caller-abort drain exceeded its bounded wait', 'BENCHMARK_DRAIN_TIMEOUT');
    await sleep(Math.min(result.retryAfterMs, remaining));
    if (now() >= until) throw drainError('Core caller-abort drain exceeded its bounded wait', 'BENCHMARK_DRAIN_TIMEOUT');
  }
}

module.exports = { requestReleaseWithDrain, MAX_DRAIN_WAIT_MS };
