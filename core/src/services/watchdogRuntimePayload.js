'use strict';

const { withContextRefusal } = require('./routing/contextIntegrityPolicy');
const { isEmbeddingModelName } = require('../../../shared/embeddingModels');
const { isOllamaPermanentExpiry } = require('../../../shared/ollamaResidency');

// What a host reports as loaded: each model, its context, and whether it is
// there to stay (keep_alive -1) or leaves on its own.
function residentsOf(models = [], now = Date.now()) {
  return models.map(m => ({
    model: m.name || m.model,
    contextLength: Number.isSafeInteger(m.context_length) && m.context_length > 0
      ? m.context_length : null,
    permanent: isOllamaPermanentExpiry(m.expires_at, now)
  }));
}

// The resident a probe exercises: the first one that is there to stay and
// answers /api/generate. A probe carries keep_alive -1, so exercising a model
// loaded for a while (a judge, a one-off call) would keep it on the host
// forever: that one is left to expire. An embedding model refuses generation,
// so probing it proves nothing about the conversation model resident beside it.
function probeTarget(residentModels = []) {
  return residentModels.find(resident => resident.permanent && !isEmbeddingModelName(resident.model)) || null;
}

// Maintenance must keep the same runner mode as ordinary inference. Otherwise
// a health probe reloads it solely to re-enable context shifting.
function probePayload(model, options) {
  return withContextRefusal({ model, prompt: 'ok', stream: false, think: false,
    keep_alive: -1, options });
}

function restorePayload(model) {
  return withContextRefusal({ model, prompt: 'warmup', stream: false,
    options: { num_predict: 1 } });
}

module.exports = { probePayload, probeTarget, residentsOf, restorePayload };
