'use strict';

// A JSON-safe, deeply frozen copy: callers receive values they cannot mutate
// and that share no references with live documents.
function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function frozenCopy(value) {
  return deepFreeze(clone(value));
}

module.exports = { frozenCopy };
