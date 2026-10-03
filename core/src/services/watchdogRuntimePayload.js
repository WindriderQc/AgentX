'use strict';

const { withContextRefusal } = require('./routing/contextIntegrityPolicy');

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

module.exports = { probePayload, restorePayload };
