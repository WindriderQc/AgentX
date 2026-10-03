'use strict';

const { withContextRefusal } = require('./routing/contextIntegrityPolicy');
const { isEmbeddingModelName } = require('../../../shared/embeddingModels');

// The resident a probe exercises: the first one that answers /api/generate.
// An embedding model refuses generation, so probing it proves nothing about
// the conversation model resident beside it.
function probeTarget(residentModels = []) {
  return residentModels.find(resident => !isEmbeddingModelName(resident.model)) || null;
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

module.exports = { probePayload, probeTarget, restorePayload };
