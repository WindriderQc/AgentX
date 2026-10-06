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

async function isControlledProbe(options, dependencies) {
  // The distributed admission validates this exact Core-owned workload before
  // dispatch. A direct lane or a caller-provided claim alone is not an opt-out.
  if (options.principal !== 'benchmark-service'
    || !(options.workloadAdmissionId && options.workloadGeneration)) return false;
  // On a host the workload only shares, the model stays resident for everyone
  // else. A payload sent as is would load it in another runner mode, and each
  // probe, pin restore or household call would then reload it. Only a host the
  // workload reserves is its own to exercise.
  const sharesHost = dependencies.workloadSharesHost || defaultWorkloadSharesHost;
  return !(await sharesHost({ id: options.workloadAdmissionId, generation: options.workloadGeneration,
    host: options.hostUrl }));
}

async function defaultWorkloadSharesHost(query) {
  // Never wait on a disconnected database: Mongoose would buffer the query.
  if (require('mongoose').connection.readyState !== 1) return false;
  return require('../runtimeWorkloadAdmission').workloadSharesHost(query);
}

function withContextRefusal(payload, mode) {
  return mode === 'embed' ? { ...payload, truncate: false } : { ...payload, truncate: false, shift: false };
}

async function protectContext(options, dependencies = {}) {
  const { hostUrl, payload, mode, signal, principal, admissionKind } = options;
  if ((principal === 'core-session-hold' && admissionKind === 'session-hold-warm')
    || await isControlledProbe(options, dependencies)) return payload;
  signal?.throwIfAborted();
  const read = dependencies.readRuntimeVersion || readRuntimeVersion;
  const version = await read(hostUrl, dependencies.fetch, signal);
  signal?.throwIfAborted();
  if (!supportsRefusal(version)) {
    throw Object.assign(new Error('This runtime cannot enforce context overflow refusal. Ollama 0.30.10 or a later stable version is required; no inference was dispatched.'), {
      code: 'INFERENCE_CONTEXT_POLICY_UNAVAILABLE', statusCode: 503,
    });
  }
  return withContextRefusal(payload, mode);
}

module.exports = { protectContext, supportsRefusal, withContextRefusal };
