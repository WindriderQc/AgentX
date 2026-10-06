'use strict';

/** Classify explicit input refusals and dependency availability failures. */
function classifyRagAvailabilityError(err) {
  if (['EMBEDDING_INPUT_TOO_LARGE', 'RAG_CHUNK_LIMIT_EXCEEDED'].includes(err.code)) {
    return { status: 413, code: err.code, detail: err.message,
      meta: { limit: err.limit, unit: err.code === 'EMBEDDING_INPUT_TOO_LARGE' ? 'characters' : 'chunks',
        ...(err.inputLength != null && { inputLength: err.inputLength }), overflow: 'reject' } };
  }
  if (err.code === 'EMBEDDING_INPUT_REJECTED') {
    return { status: err.statusCode || 400, code: err.code, detail: err.message, meta: { overflow: 'reject' } };
  }
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
