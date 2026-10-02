'use strict';

// A casual spoken topic is not a request to retrieve unrelated personal history.
// Explicit memory requests can still find a note by one distinctive term.
function voiceRecallOptions(text, personalVoice, normalLimit) {
  if (!personalVoice) return { limit: normalLimit };
  const normalized = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const explicit = /\b(?:souvenirs?|rappelle\w*|memoire|notes?|remember|recall)\b/.test(normalized)
    || /\b(?:quel(?:le)?|quand|combien|ou|qui)\b.{0,80}\b(?:mon|ma|mes|notre|nos)\b/.test(normalized);
  return { limit: Math.min(normalLimit, 4), minMatchedTerms: explicit ? 1 : 2 };
}

module.exports = { voiceRecallOptions };
