'use strict';

// Names of embedding-only models: anything with `embed`/`embedding`, the nomic
// family, the BAAI bge family (bare or org-prefixed, e.g. `qllama/bge-m3:f16`)
// and MiniLM sentence embedders. `bge` must start a name segment so it never
// matches inside an unrelated word.
const EMBEDDING_MODEL_NAME_PATTERN = /embed|nomic|(?:^|[^a-z0-9])bge(?:[^a-z]|$)|minilm/i;

/**
 * True when an Ollama tag names an embedding-only model. Such models answer
 * `/api/embed` only: they are routed to the embedding host, kept resident by
 * warm-ups and never offered as chat candidates.
 */
function isEmbeddingModelName(model) {
  const name = String(model || '').trim();
  return Boolean(name) && EMBEDDING_MODEL_NAME_PATTERN.test(name);
}

module.exports = { isEmbeddingModelName };
