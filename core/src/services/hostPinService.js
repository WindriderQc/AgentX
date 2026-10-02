'use strict';

const HostPreference = require('../../models/HostPreference');
const { getPinnedEntries, pinNamesMatch } = require('./hostPinPrimitives');

function pinError(message, code = 'HOST_PIN_INVALID', statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function normalizeEntry(entry) {
  if (!entry || typeof entry.model !== 'string' || !entry.model.trim()) {
    throw pinError('Each pin must name a model');
  }
  const normalized = {
    model: entry.model.trim(),
    keepAlive: entry.keepAlive ?? -1,
    contextSize: entry.contextSize ?? 0,
    autoRestore: entry.autoRestore ?? true
  };
  if (!Number.isSafeInteger(normalized.keepAlive) || normalized.keepAlive < -1
    || !Number.isSafeInteger(normalized.contextSize) || normalized.contextSize < 0
    || typeof normalized.autoRestore !== 'boolean') {
    throw pinError('Pins require keepAlive >= -1, contextSize >= 0 (integers), and boolean autoRestore');
  }
  if (entry.numThread !== undefined && entry.numThread !== null && entry.numThread !== 0) {
    if (!Number.isSafeInteger(entry.numThread) || entry.numThread < 1 || entry.numThread > 256) {
      throw pinError('numThread is a whole number of CPU threads between 1 and 256');
    }
    normalized.numThread = entry.numThread;
  }
  return normalized;
}

// Adding a resident declares the slots it needs. An explicit lower limit must
// never silently discard pins. This is AgentX intent, not an Ollama env update.
function normalizePinUpdate(pref, updates) {
  if (updates.pinnedModels === undefined && updates.maxConcurrentModels === undefined) return updates;
  const result = { ...updates };
  const entries = updates.pinnedModels === undefined ? getPinnedEntries(pref) : updates.pinnedModels;
  if (!Array.isArray(entries)) throw pinError('pinnedModels must be an array');
  const normalized = entries.map(normalizeEntry);
  const names = [];
  for (const entry of normalized) {
    if (names.some(name => pinNamesMatch(name, entry.model))) throw pinError('Duplicate pinned model');
    names.push(entry.model);
  }
  if (updates.maxConcurrentModels !== undefined) {
    if (!Number.isSafeInteger(updates.maxConcurrentModels) || updates.maxConcurrentModels < 1) {
      throw pinError('maxConcurrentModels must be a positive integer');
    }
    if (updates.maxConcurrentModels < normalized.length) {
      throw pinError('Resident slots cannot be lower than the number of pinned models', 'HOST_PIN_CAPACITY');
    }
  } else {
    result.maxConcurrentModels = Math.max(pref?.maxConcurrentModels || 1, normalized.length);
  }
  if (updates.pinnedModels !== undefined) result.pinnedModels = normalized;
  return result;
}

async function mutatePins(hostUrl, transform) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const pref = await HostPreference.findOne({ hostUrl }).lean();
    if (!pref) return null;
    const updates = normalizePinUpdate(pref, transform(getPinnedEntries(pref), pref));
    const result = await HostPreference.findOneAndUpdate(
      { hostUrl, pinnedModels: pref.pinnedModels, maxConcurrentModels: pref.maxConcurrentModels },
      {
        $set: updates,
        $unset: { pinnedModel: '', defaultModels: '', keepAlive: '', contextSize: '', autoRestore: '' }
      },
      { new: true, runValidators: true }
    ).lean();
    if (result) return result;
  }
  throw pinError('Pins changed concurrently; reload and retry', 'HOST_PIN_CONFLICT', 409);
}

async function getPinStatus(hostUrl) {
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  return {
    pinnedModels: getPinnedEntries(pref),
    loadedModel: pref?.loadedModel || null,
    loadedModels: pref?.loadedModels?.length ? pref.loadedModels : (pref?.loadedModel ? [pref.loadedModel] : []),
    maxConcurrentModels: pref?.maxConcurrentModels || 1,
    status: pref?.status || 'idle'
  };
}

async function setPinnedModel(hostUrl, model) {
  const requested = normalizeEntry({ model });
  return mutatePins(hostUrl, (entries, pref) => {
    const match = entries.find(entry => pinNamesMatch(entry.model, requested.model));
    const pinnedModels = [match || requested, ...entries.filter(entry => !pinNamesMatch(entry.model, requested.model))];
    const loaded = pref.loadedModels?.length ? pref.loadedModels : [pref.loadedModel];
    return { pinnedModels, status: pinnedModels.every(entry => loaded.some(name => pinNamesMatch(name, entry.model))) ? 'ready' : 'restoring' };
  });
}

async function addPinnedModel(hostUrl, model, opts = {}) {
  const requested = normalizeEntry({ ...opts, model });
  return mutatePins(hostUrl, entries => ({
    pinnedModels: entries.some(entry => pinNamesMatch(entry.model, requested.model)) ? entries : [...entries, requested]
  }));
}

async function updatePinnedModel(hostUrl, model, opts = {}) {
  return mutatePins(hostUrl, entries => {
    const found = entries.find(entry => pinNamesMatch(entry.model, model));
    if (!found) throw pinError('Pinned model not found', 'HOST_PIN_NOT_FOUND', 404);
    const changes = Object.fromEntries(['keepAlive', 'contextSize', 'autoRestore', 'numThread']
      .filter(key => opts[key] !== undefined).map(key => [key, opts[key]]));
    return { pinnedModels: entries.map(entry => entry === found ? normalizeEntry({ ...entry, ...changes }) : entry) };
  });
}

async function removePinnedModel(hostUrl, model) {
  normalizeEntry({ model });
  return mutatePins(hostUrl, (entries, pref) => {
    const pinnedModels = entries.filter(entry => !pinNamesMatch(entry.model, model));
    return { pinnedModels, status: pinnedModels.length ? pref.status : 'idle' };
  });
}

async function clearPinnedModel(hostUrl) {
  return mutatePins(hostUrl, () => ({ pinnedModels: [], status: 'idle' }));
}

module.exports = {
  normalizePinUpdate, getPinStatus, setPinnedModel, addPinnedModel,
  updatePinnedModel, removePinnedModel, clearPinnedModel
};
