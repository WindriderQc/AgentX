'use strict';

/** Map a RAG dependency failure to a 503 availability error, or null. */
function classifyRagAvailabilityError(err) {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('econnrefused') || msg.includes('fetch failed')) {
    return { status: 503, code: 'VECTOR_STORE_UNAVAILABLE', detail: 'Vector store is not reachable' };
  }
  if (msg.includes('embedding') || msg.includes('core proxy') || msg.includes('502') || msg.includes('503')) {
    return { status: 503, code: 'EMBEDDING_SERVICE_UNAVAILABLE', detail: 'Embedding service (core proxy) is not reachable' };
  }
  return null;
}

module.exports = { classifyRagAvailabilityError };
