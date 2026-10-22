'use strict';
/**
 * JSON for Qdrant request bodies with no lone UTF-16 surrogate.
 *
 * JSON.stringify writes a lone surrogate as a `\udXXX` escape, which Qdrant
 * rejects ("lone leading surrogate in hex escape") and fails the whole batch.
 * Each string is made well formed first: a lone surrogate becomes U+FFFD and
 * complete surrogate pairs (emoji and other characters beyond the basic
 * plane) are kept unchanged.
 */
function wellFormedJson(value) {
  return JSON.stringify(value, (_key, item) => (typeof item === 'string' ? item.toWellFormed() : item));
}

module.exports = wellFormedJson;
