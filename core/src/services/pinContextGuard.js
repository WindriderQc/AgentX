'use strict';

// A pin's context size is an evidence-backed, benchmarked allocation. Only
// POST …/pin/context may change it: that path requires the operator's decision,
// refuses during a benchmark claim or session hold and verifies VRAM. Every
// other pin write may keep an existing pin's context size, never change it.
function contextChangeRefusal(previousPins = [], nextPins = []) {
  const before = new Map((previousPins || []).map((pin) => [pin.model, Number(pin.contextSize ?? 0)]));
  const changed = (Array.isArray(nextPins) ? nextPins : [])
    .filter((pin) => pin && before.has(pin.model) && pin.contextSize !== undefined
      && Number(pin.contextSize) !== before.get(pin.model))
    .map((pin) => pin.model);
  if (!changed.length) return null;
  return Object.assign(new Error(`Change a pin's context size through the guarded context apply (POST …/pin/context): ${changed.join(', ')}`), {
    code: 'HOST_PIN_CONTEXT_GUARDED', statusCode: 409
  });
}

module.exports = { contextChangeRefusal };
