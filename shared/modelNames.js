'use strict';

/** Normalize an Ollama tag for storage/lookups without changing namespaces. */
function normalizeModelTag(value) {
  return String(value || '').trim().replace(/:latest$/i, '');
}

/** Case-insensitive identity of a model tag, `:latest` folded. */
function modelIdentityKey(value) {
  return normalizeModelTag(value).toLowerCase();
}

module.exports = { modelIdentityKey, normalizeModelTag };
