'use strict';

const { readRuntimeVersion } = require('./ollamaRuntimeVersion');

// Both controls are implemented in this tagged server: truncate preserves the
// complete prompt; shift changes the scheduler's runner configuration, which
// disables context shifting. JSON field presence alone is not sufficient.
// https://github.com/ollama/ollama/blob/v0.30.10/server/sched.go
// https://github.com/ollama/ollama/blob/v0.30.10/llm/llama_server.go
const MINIMUM_VERSION = [0, 30, 10];

function supportsRefusal(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
  if (!match) return false;
  for (let index = 0; index < 3; index++) {
    const component = Number(match[index + 1]);
    if (component !== MINIMUM_VERSION[index]) return component > MINIMUM_VERSION[index];
  }
  return true;
}

function isControlledProbe(options) {
  // The distributed admission validates this exact Core-owned workload before
  // dispatch. A direct lane or a caller-provided claim alone is not an opt-out.
  return options.principal === 'benchmark-service'
    && Boolean(options.workloadAdmissionId && options.workloadGeneration);
}

async function protectContext(options, dependencies = {}) {
  const { hostUrl, payload, mode, signal, principal, admissionKind } = options;
  if (isControlledProbe(options)
    || (principal === 'core-session-hold' && admissionKind === 'session-hold-warm')) return payload;
  signal?.throwIfAborted();
  const read = dependencies.readRuntimeVersion || readRuntimeVersion;
  const version = await read(hostUrl, dependencies.fetch, signal);
  signal?.throwIfAborted();
  if (!supportsRefusal(version)) {
    throw Object.assign(new Error('This runtime cannot enforce context overflow refusal. Ollama 0.30.10 or a later stable version is required; no inference was dispatched.'), {
      code: 'INFERENCE_CONTEXT_POLICY_UNAVAILABLE', statusCode: 503,
    });
  }
  return mode === 'embed' ? { ...payload, truncate: false } : { ...payload, truncate: false, shift: false };
}

module.exports = { protectContext, supportsRefusal };
