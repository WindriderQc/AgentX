'use strict';

// Source and execution mode are independent of the model's provider or billing.
// Local engines stay behind their existing transports; OpenClaw owns its models.
const SOURCES = Object.freeze(['local', 'openclaw']);
const MODES = Object.freeze(['model', 'agent']);
const PREFIX = 'openclaw:';

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'EXECUTION_SOURCE_INVALID', statusCode: 400 });
}

function modelRef(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:@+\-]*\/[a-zA-Z0-9][a-zA-Z0-9._:@/+\-]*$/.test(value)
      || value.includes('..') || value.length > 300) invalid('Choose an explicit OpenClaw provider/model reference.');
  return value;
}

function agentRef(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_\-]{0,79}$/.test(value)) invalid('Choose a configured OpenClaw agent.');
  return value;
}

function parseExecutionSource(request = {}) {
  const raw = request.execution;
  const encoded = typeof request.model === 'string' && request.model.startsWith(PREFIX);
  if (raw == null && !encoded) return null; // Preserve the existing local request verbatim.
  if (raw != null && (!raw || typeof raw !== 'object' || Array.isArray(raw))) invalid('execution must be an object.');
  let selection = raw;
  if (encoded) {
    const match = /^openclaw:(model|agent):(.+)$/.exec(request.model);
    if (!match) invalid('Invalid OpenClaw selection.');
    const decoded = { source: 'openclaw', mode: match[1], [match[1] === 'agent' ? 'agentId' : 'model']: match[2] };
    if (raw && (raw.source !== decoded.source || raw.mode !== decoded.mode
        || (decoded.model && raw.model !== decoded.model) || (decoded.agentId && raw.agentId !== decoded.agentId))) {
      invalid('The model selection and execution source disagree.');
    }
    selection = { ...decoded, ...raw };
  }
  if (!SOURCES.includes(selection.source)) invalid('Execution source must be local or openclaw.');
  const mode = selection.mode || 'model';
  if (!MODES.includes(mode)) invalid('Execution mode must be model or agent.');
  if (selection.source === 'local') {
    if (mode !== 'model') invalid('Local direct execution does not run an agent profile.');
    if (selection.engine && selection.engine !== 'ollama') invalid('This local engine is not installed.');
    return { source: 'local', mode, engine: 'ollama', model: selection.model || request.model || null };
  }
  if (request.autoRoute === true || request.allowCrossModelFallback === true) invalid('An explicit OpenClaw source cannot use local automatic routing or fallback.');
  if (request.target && request.target !== 'openclaw' || request.host) invalid('An OpenClaw selection cannot also select a local host.');
  return mode === 'model'
    ? { source: 'openclaw', mode, model: modelRef(selection.model || request.model) }
    : { source: 'openclaw', mode, agentId: agentRef(selection.agentId), model: selection.model ? modelRef(selection.model) : null };
}

function executionModelId(selection) {
  if (selection.source !== 'openclaw') return selection.model;
  return `${PREFIX}${selection.mode}:${selection.mode === 'agent' ? agentRef(selection.agentId) : modelRef(selection.model)}`;
}

module.exports = { SOURCES, MODES, parseExecutionSource, executionModelId, modelRef, agentRef };
