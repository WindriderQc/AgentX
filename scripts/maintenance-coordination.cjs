'use strict';

// A GET snapshot grants no effects. A dropped transport may be read once more
// within the original probe budget; mutation requests never pass this helper.
async function readCoordination({ coreUrl, read, now = Date.now,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), budgetMs = 10_000 } = {}) {
  const deadline = now() + budgetMs;
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await read(`${coreUrl}/api/nerve-center/runtime-coordination/active`, {
        timeoutMs: Math.max(1, deadline - now())
      });
      break;
    } catch (error) {
      const retryable = error instanceof TypeError && error.message === 'fetch failed';
      const remaining = deadline - now();
      if (!retryable || attempt !== 0 || remaining <= 200) throw error;
      await pause(200);
      if (now() >= deadline) throw error;
    }
  }
  const data = response?.json?.data;
  // Missing/invalid JSON is unknown. It must not become empty arrays that
  // would let the launcher recreate a service during unobserved work.
  if (!response?.ok || response.json?.status !== 'success' || !data || typeof data !== 'object'
    || !Object.hasOwn(data, 'maintenance')
    || !(data.maintenance === null || (typeof data.maintenance === 'object' && !Array.isArray(data.maintenance)))
    || !Array.isArray(data.workloads) || !Array.isArray(data.inferences)) {
    throw new Error('Core runtime coordination snapshot is unavailable or incomplete');
  }
  return { maintenance: data.maintenance, workloads: data.workloads, inferences: data.inferences };
}

module.exports = { readCoordination };
