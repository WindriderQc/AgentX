'use strict';

// Reject delays that Node would turn into a 1 ms timer. The authenticated
// Benchmark caller owns its deadline; model size supplies no fixed ceiling.
const MAX_BENCHMARK_TIMEOUT_MS = 2_147_483_647;

function resolveInferenceTimeout({ requestedTimeoutMs, benchmarkAuthorized, defaultTimeoutMs, stream }) {
  if (requestedTimeoutMs === undefined) return { timeoutMs: defaultTimeoutMs };
  if (!benchmarkAuthorized) {
    return { error: {
      status: 403, code: 'INFERENCE_TIMEOUT_FORBIDDEN',
      message: 'A request timeout override requires the Benchmark direct lane and workload proof.',
    } };
  }
  if (stream === true || !Number.isSafeInteger(requestedTimeoutMs)
    || requestedTimeoutMs <= 0 || requestedTimeoutMs > MAX_BENCHMARK_TIMEOUT_MS) {
    return { error: {
      status: 400, code: 'INFERENCE_TIMEOUT_INVALID',
      message: `Non-streamed timeoutMs must be a positive integer no greater than ${MAX_BENCHMARK_TIMEOUT_MS} (Node timer limit).`,
    } };
  }
  return { timeoutMs: requestedTimeoutMs };
}

module.exports = { resolveInferenceTimeout };
