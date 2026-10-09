'use strict';

/**
 * Requests whose duration is model or stream time, not server time.
 *
 * Server performance measures how fast Core answers HTTP requests. A chat,
 * generation, embedding or classification call lasts as long as the model
 * takes, and an event stream stays open for minutes; averaging them with page
 * and API requests made the server latency meaningless. Their timing is
 * measured per model in the inference ledger (AI activity) instead.
 */
const MODEL_BOUND_PATHS = new Set([
  '/api/chat',
  '/api/chat/stream',
  '/api/inference/generate',
  '/api/inference/embed',
  '/api/models/classify',
  '/api/consumers/v1/inference',
  '/api/consumers/nestor/v1/inference'
]);

function isModelBoundRequest({ path, contentType } = {}) {
  if (String(contentType || '').toLowerCase().includes('text/event-stream')) return true;
  const normalized = String(path || '').replace(/\/+$/, '') || '/';
  return MODEL_BOUND_PATHS.has(normalized);
}

module.exports = { isModelBoundRequest, MODEL_BOUND_PATHS };
