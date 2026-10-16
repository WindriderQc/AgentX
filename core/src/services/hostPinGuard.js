'use strict';

// The HostPreference pin is the one owner of what Ollama loads on its host.
// Ollama schedules a runner by model name and load options, so a request that
// names another model, or the pinned model with other load options, evicts and
// reloads the resident weights. On a pinned host a request therefore names a
// pinned model and either omits the load options (it inherits the pin's) or
// repeats them. A claim holder (Benchmark/Profiler workload claim, session
// hold on its model) keeps its exact options: the claim owns the host.

const { getPinnedEntries, pinNamesMatch, positiveInteger } = require('./hostPinPrimitives');

// Options that change the loaded runner. The pin stores num_ctx and
// num_thread; the others are Ollama's defaults on a pinned runner.
const LOAD_OPTION_KEYS = Object.freeze(['num_ctx', 'num_gpu', 'num_batch', 'num_thread', 'use_mmap', 'main_gpu']);

function pinLoadOptions(entry) {
  const contextSize = positiveInteger(entry.contextSize);
  const numThread = positiveInteger(entry.numThread);
  return {
    ...(contextSize && { num_ctx: contextSize }),
    ...(numThread && { num_thread: numThread })
  };
}

function pinMismatch(hostUrl, model, field, requested, pinned, pinnedModel) {
  const shown = field === 'model' ? `model ${model}` : `${field} ${requested}`;
  return Object.assign(new Error(
    `The host pin owns ${hostUrl}: ${shown} differs from the pin (${field === 'model'
      ? pinnedModel : `${field} ${pinned ?? 'Ollama default'}`}). Omit it or hold a claim.`
  ), {
    code: 'HOST_PIN_MISMATCH', statusCode: 409,
    pin: { hostUrl, field, requested: requested ?? null, pinned: pinned ?? null, model: pinnedModel }
  });
}

function sameValue(requested, pinned) {
  if (pinned === undefined) return false;
  if (typeof pinned === 'number') return Number(requested) === pinned;
  return requested === pinned;
}

function holdCovers(pref, model, now) {
  const hold = pref?.sessionHold;
  if (!hold?.holdId || !hold.model || !model) return false;
  const expiresAt = new Date(hold.expiresAt || 0).getTime();
  return expiresAt > now && pinNamesMatch(String(hold.model), String(model));
}

/**
 * Apply the pin to one request. `onDiffer` is 'refuse' for API callers and
 * 'ignore' for the chat UI, which shows the pin's values instead of failing an
 * ordinary user's turn. A different model is refused either way.
 *
 * Returns the options and keep-alive to send, or `{ unpinned: true }` when the
 * pin does not govern this request (no pin on the host, or a claim holder).
 */
function enforceHostPin(pref, { hostUrl, model, options = {}, claimed = false, onDiffer = 'refuse', now = Date.now() } = {}) {
  const entries = getPinnedEntries(pref);
  if (entries.length === 0 || claimed || holdCovers(pref, model, now)) return { unpinned: true };
  const entry = entries.find(item => pinNamesMatch(item.model, model));
  if (!entry) {
    throw pinMismatch(hostUrl, model, 'model', model, entries[0].model, entries.map(item => item.model).join(', '));
  }
  const pinned = pinLoadOptions(entry);
  // Residency is the pin's too: keep_alive 0 or 10m would let the pin expire.
  const { keep_alive: _keepAlive, ...resolved } = options || {};
  const ignored = [];
  for (const key of LOAD_OPTION_KEYS) {
    if (resolved[key] == null) {
      if (pinned[key] !== undefined) resolved[key] = pinned[key];
      continue;
    }
    if (sameValue(resolved[key], pinned[key])) {
      resolved[key] = pinned[key];
      continue;
    }
    if (onDiffer !== 'ignore') throw pinMismatch(hostUrl, model, key, resolved[key], pinned[key], entry.model);
    ignored.push(key);
    if (pinned[key] !== undefined) resolved[key] = pinned[key];
    else delete resolved[key];
  }
  return { options: resolved, keepAlive: entry.keepAlive ?? -1, pinnedEntry: entry, ignored };
}

function stripLoadOptions(options = {}) {
  const rest = { ...options };
  for (const key of LOAD_OPTION_KEYS) delete rest[key];
  return rest;
}

module.exports = { LOAD_OPTION_KEYS, enforceHostPin, pinLoadOptions, stripLoadOptions };
