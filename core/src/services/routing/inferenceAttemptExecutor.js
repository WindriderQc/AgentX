'use strict';

const fetch = require('node-fetch');
const logger = require('../../../config/logger');
const hostGate = require('../hostGate');
const { beginInferenceAdmission } = require('../inferenceAdmissionService');
const { protectContext } = require('./contextIntegrityPolicy');
const { observePromptCache } = require('./promptCacheAttribution');

const OLLAMA_ABORT_SOURCE = Object.freeze({
  CALLER: 'caller',
  TIMEOUT: 'timeout',
});

function hasTerminalOllamaFrame(raw) {
  const validator = createOllamaStreamTerminalValidator();
  String(raw || '').split(/\r?\n/).forEach(frame => validator.observe(frame));
  return validator.isComplete();
}

function createOllamaStreamTerminalValidator() {
  let terminalObserved = false;
  let invalid = false;
  let frameCount = 0;

  return {
    observe(rawFrame) {
      const frame = String(rawFrame || '').trim();
      if (!frame) return { accepted: true, empty: true, terminal: false, data: null };
      frameCount += 1;
      if (terminalObserved) {
        invalid = true;
        return { accepted: false, terminal: false, data: null };
      }
      let data;
      try {
        data = JSON.parse(frame);
      } catch {
        invalid = true;
        return { accepted: false, terminal: false, data: null };
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || typeof data.done !== 'boolean' || typeof data.error === 'string') {
        invalid = true;
        return { accepted: false, terminal: false, data: null };
      }
      const terminal = data?.done === true;
      if (terminal) terminalObserved = true;
      return { accepted: true, terminal, data };
    },
    isComplete() {
      return frameCount > 0 && terminalObserved && !invalid;
    },
    snapshot() {
      return { frameCount, terminalObserved, invalid, complete: this.isComplete() };
    }
  };
}

function hasTerminalOllamaResponse(raw) {
  try {
    const data = JSON.parse(String(raw || ''));
    return Boolean(data && typeof data === 'object' && !Array.isArray(data)
      && data.done === true && typeof data.error !== 'string');
  } catch {
    return false;
  }
}

function createIncompleteOllamaResponseError(stream) {
  const error = new Error(stream
    ? 'Ollama stream ended without an exact terminal done frame'
    : 'Ollama response ended without an exact terminal done object');
  error.code = stream ? 'OLLAMA_STREAM_INCOMPLETE' : 'OLLAMA_RESPONSE_INCOMPLETE';
  error.isOllamaAttemptError = true;
  error.ollamaTerminalObserved = false;
  return error;
}

function requestNotSent(error) {
  return error?.type === 'system'
    && ['ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code);
}

function createAttemptAbortBridge({ externalSignal, stream, timeoutMs }) {
  // null means the caller already owns a deadline spanning admission/body.
  const ownsTimeout = stream !== true && timeoutMs !== null;
  if (!ownsTimeout && !externalSignal) {
    return { signal: undefined, getAbortSource: () => null, cleanup() {} };
  }

  const controller = new AbortController();
  let abortSource = null;
  let callerListenerAttached = false;
  let timer = null;

  const abort = (source, message) => {
    if (controller.signal.aborted) return;
    abortSource = source;
    // Do not forward an external signal's reason. It may contain caller-owned
    // details that do not belong in Core errors or logs.
    controller.abort(new Error(message));
  };
  const abortFromCaller = () => abort(
    OLLAMA_ABORT_SOURCE.CALLER,
    'Ollama attempt cancelled by caller'
  );

  if (externalSignal?.aborted) {
    abortFromCaller();
  } else if (externalSignal?.addEventListener) {
    externalSignal.addEventListener('abort', abortFromCaller, { once: true });
    callerListenerAttached = true;
  }

  if (ownsTimeout && !controller.signal.aborted) {
    timer = setTimeout(() => abort(
      OLLAMA_ABORT_SOURCE.TIMEOUT,
      `Inference fetch timeout after ${timeoutMs}ms`
    ), timeoutMs);
  }

  return {
    signal: controller.signal,
    getAbortSource: () => abortSource,
    cleanup() {
      if (timer) clearTimeout(timer);
      if (callerListenerAttached) {
        externalSignal.removeEventListener('abort', abortFromCaller);
        callerListenerAttached = false;
      }
    },
  };
}

async function readOllamaResponse(response, { stream = false, mode, verifyRejection = false } = {}) {
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { response: raw }; }
  const object = data && typeof data === 'object' && !Array.isArray(data);
  const embedSuccess = object && (Array.isArray(data.embeddings) || Array.isArray(data.embedding));
  if (response.ok) {
    const terminalObserved = mode === 'embed'
      ? embedSuccess && typeof data.error !== 'string'
      : stream === true
      ? hasTerminalOllamaFrame(raw)
      : hasTerminalOllamaResponse(raw);
    if (!terminalObserved) {
      const error = createIncompleteOllamaResponseError(stream === true);
      if (mode === 'embed') error.code = 'OLLAMA_EMBED_RESPONSE_INVALID';
      throw error;
    }
  } else if (verifyRejection && !(object && typeof data.error === 'string'
    && !['response', 'message', 'tool_calls', 'choices', 'embeddings', 'embedding'].some(key => key in data)
    && data.done !== true)) {
    const error = new Error('Ollama rejection was not an exact error object');
    error.code = 'OLLAMA_REJECTION_UNVERIFIED';
    throw error;
  }
  return { ok: response.ok, status: response.status, response, raw, data };
}

async function executeOllamaAttempt({
  hostUrl,
  payload,
  useChat,
  stream = false,
  timeoutMs = 600000,
  signal: externalSignal,
  mode,
  verifyRejection = false,
}, { fetch: fetchImpl = fetch } = {}) {
  const url = `${hostUrl}/api/${mode === 'embed' ? 'embed' : useChat ? 'chat' : 'generate'}`;
  const abortBridge = createAttemptAbortBridge({ externalSignal, stream, timeoutMs });
  const attemptStartedAt = Date.now();
  let receivedResponse = false;

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      ...(abortBridge.signal && { signal: abortBridge.signal }),
    });
    receivedResponse = true;
    const { raw, data } = await readOllamaResponse(response, { stream, mode, verifyRejection });
    return {
      ok: response.ok,
      status: response.status,
      response,
      raw,
      data,
      durationMs: Date.now() - attemptStartedAt,
    };
  } catch (err) {
    err.ollamaRequestNotSent = !receivedResponse && requestNotSent(err);
    const abortSource = abortBridge.getAbortSource();
    err.attemptDurationMs = Date.now() - attemptStartedAt;
    err.isOllamaAttemptError = true;
    err.ollamaAbortSource = abortSource;
    err.isCallerCancellation = abortSource === OLLAMA_ABORT_SOURCE.CALLER;
    err.isOllamaTimeout = abortSource === OLLAMA_ABORT_SOURCE.TIMEOUT;
    throw err;
  } finally {
    abortBridge.cleanup();
  }
}

// The admission signal follows the caller and the distributed lease. When it
// aborts while the caller is still connected, the lease was lost: the caller
// must get an error response, not the silence reserved for a disconnect.
function classifyAdmissionAbort(error, callerSignal, admissionSignal) {
  if (callerSignal?.aborted) {
    error.isCallerCancellation = true;
    error.isOllamaTimeout = false;
  } else if (admissionSignal?.aborted) {
    error.isCallerCancellation = false;
    error.isOllamaTimeout = false;
    error.inferenceAdmissionLost = true;
    if (!/^RUNTIME_INFERENCE_/.test(String(error.code || ''))) error.code = 'RUNTIME_INFERENCE_ADMISSION_LOST';
    error.statusCode = 503;
  }
  return error;
}

/**
 * How the proxy settles a failed admitted attempt: silence for a caller that
 * disconnected, 503 for a lost admission, or null to continue normal error
 * handling.
 */
function settleAdmissionFailure(error, { cancelled = false, onCancelled = () => {}, host, model, lane } = {}) {
  if (error?.isCallerCancellation === true || cancelled) {
    onCancelled();
    logger.debug('[InferenceProxy] caller disconnected; upstream attempt cancelled', { host, model, lane });
    return { cancelled: true, response: null };
  }
  if (error?.inferenceAdmissionLost === true) {
    logger.warn('[InferenceProxy] inference admission lost; caller still connected', { host, model, lane, code: error.code });
    return { cancelled: false, response: { status: 503, body: { status: 'error', code: error.code, message: error.message } } };
  }
  if (error?.code === 'INFERENCE_CONTEXT_POLICY_UNAVAILABLE') {
    return { cancelled: false, response: { status: 503, body: { status: 'error', code: error.code, message: error.message } } };
  }
  return { cancelled: false, response: null };
}

async function beginAdmittedOllamaAttempt(options, dependencies = {}) {
  const begin = dependencies.beginInferenceAdmission || beginInferenceAdmission;
  const gate = dependencies.hostGate || hostGate;
  // Time spent before Ollama receives the call, for its telemetry row (#363).
  const admissionStartedAt = Date.now();
  const waits = { admissionMs: null, hostGateMs: null };
  const kind = options.admissionKind || (options.stream ? 'inference-stream' : 'inference');
  const distributed = await begin({
    host: options.hostUrl,
    model: options.model,
    kind,
    principal: options.principal || 'core-service',
    requestId: options.requestId,
    workloadAdmissionId: options.workloadAdmissionId || null,
    workloadGeneration: options.workloadGeneration || null,
    runtimeOptions: options.payload?.options || null,
    ...(Object.prototype.hasOwnProperty.call(options.payload || {}, 'keep_alive')
      && { keepAlive: options.payload.keep_alive }),
    ttlMs: options.admissionTtlMs,
    signal: options.signal,
    ...(options.exclusive && { mode: 'exclusive' }),
  }).catch((error) => {
    error.inferenceWaits = { admissionMs: Date.now() - admissionStartedAt };
    throw error;
  });
  waits.admissionMs = Date.now() - admissionStartedAt;
  let release = () => {};
  let dispatched = false;
  const gateStartedAt = Date.now();
  try {
    if (options.exclusive) {
      release = await gate.acquireExclusive(options.hostUrl, options.model, { signal: distributed.signal });
    } else if (!options.skipGate) {
      release = await gate.acquire(options.hostUrl, options.model, {
        signal: distributed.signal,
      });
    } else {
      release = await gate.track(options.hostUrl, options.model, {
        signal: distributed.signal,
      });
    }
    waits.hostGateMs = Date.now() - gateStartedAt;
    await options.afterAdmission?.();
    distributed.assertActive();
    distributed.markDispatched();
    dispatched = true;
    // Exclusive preparation can unload models and therefore belongs under the
    // same dispatched admission and generation fence as inference itself.
    if (options.prepareExclusive) {
      await options.prepareExclusive(distributed);
      distributed.assertActive();
    }
    // Observed in dispatch order, the order Ollama receives prompts (#364).
    const promptCache = options.mode === 'embed' ? null : (dependencies.observePromptCache || observePromptCache)({
      hostUrl: options.hostUrl, model: options.model, payload: options.payload, labels: { ...options.cacheLabels, kind },
    });
    options.onDispatch?.();
    let released = false;
    return { admission: distributed, signal: distributed.signal, waits, promptCache, release: async () => {
      if (released) return;
      released = true;
      await release();
    } };
  } catch (err) {
    err.inferenceWaits ??= { ...waits, hostGateMs: waits.hostGateMs ?? Date.now() - gateStartedAt };
    await distributed.abandon(err).catch(quarantineError => {
      err.inferenceQuarantineError = quarantineError;
    });
    if (options.signal?.aborted || (!dispatched && distributed.signal.aborted)) {
      classifyAdmissionAbort(err, options.signal, distributed.signal);
    }
    await release();
    throw err;
  }
}

async function executeAdmittedOllamaAttempt(options, dependencies = {}) {
  options = { ...options, payload: await protectContext(options, dependencies) };
  const scope = await beginAdmittedOllamaAttempt(options, dependencies);
  try {
    const result = await executeOllamaAttempt({ ...options, signal: scope.signal }, dependencies);
    scope.admission.assertActive();
    await scope.admission.complete();
    return { ...result, waits: scope.waits, promptCache: scope.promptCache };
  } catch (error) {
    error.inferenceWaits ??= scope.waits;
    error.inferencePromptCache ??= scope.promptCache;
    // A connection refused before response headers cannot have generated output.
    // Resets/timeouts after dispatch remain unknown and retain quarantine.
    const ownedDeadline = error.isOllamaTimeout === true && error.ollamaAbortSource === OLLAMA_ABORT_SOURCE.TIMEOUT;
    const settlement = error.ollamaRequestNotSent ? scope.admission.complete()
      : ownedDeadline ? scope.admission.abandon(error, { deadlineAborted: true }) : scope.admission.abandon(error);
    await settlement.catch(quarantineError => {
      error.inferenceQuarantineError = quarantineError;
    });
    classifyAdmissionAbort(error, options.signal, scope.signal);
    throw error;
  } finally {
    await scope.release();
  }
}

async function modelExistsOnHost(hostUrl, model, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${hostUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
      signal: controller.signal,
    });
    return response.ok === true;
  } catch (_err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveVerifiedFallbackModel({
  hostUrl,
  baseModel,
  resolvedPrimaryModel
}) {
  const names = [];
  if (resolvedPrimaryModel && !names.includes(resolvedPrimaryModel)) names.push(resolvedPrimaryModel);
  if (baseModel && !names.includes(baseModel)) names.push(baseModel);

  for (const candidateModel of names) {
    if (await modelExistsOnHost(hostUrl, candidateModel)) return candidateModel;
  }
  return null;
}

module.exports = {
  OLLAMA_ABORT_SOURCE,
  requestNotSent,
  createAttemptAbortBridge,
  createOllamaStreamTerminalValidator,
  hasTerminalOllamaFrame,
  hasTerminalOllamaResponse,
  beginAdmittedOllamaAttempt,
  readOllamaResponse,
  executeAdmittedOllamaAttempt,
  classifyAdmissionAbort,
  settleAdmissionFailure,
  executeOllamaAttempt,
  modelExistsOnHost,
  resolveVerifiedFallbackModel,
};
