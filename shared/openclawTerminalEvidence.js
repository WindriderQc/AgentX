'use strict';
// A native done event was saved, but its result still failed validation. This
// reference never upgrades execution state or asserts observed billing.
function nativeTerminalEvidence(value) {
  if (value?.schema !== 'agentx.openclaw-terminal-evidence-ref/v1'
    || !/^openclaw-model-terminal:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.ref || '')
    || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || value.terminalObserved !== true || value.usageValidated !== false
    || typeof value.requestId !== 'string' || value.requestId.length > 160
    || typeof value.model !== 'string' || value.model.length > 160) return null;
  return { schema: value.schema, ref: value.ref, sha256: value.sha256, requestId: value.requestId,
    model: value.model, terminalObserved: true, usageValidated: false };
}
module.exports = { nativeTerminalEvidence };
