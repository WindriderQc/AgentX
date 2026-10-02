'use strict';

function cleanBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bridge URL must use http or https');
  return raw;
}

function requestAbort(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error('client disconnected'));
  };
  const close = () => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', close);
  return {
    signal: controller.signal,
    cleanup() {
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
    }
  };
}

function applyRoutingHeaders(res, metadata) {
  if (!metadata) return;
  res.set('X-Resolved-Model', metadata.model || '');
  res.set('X-Routed-Host', metadata.hostUrl || '');
  res.set('X-Routed-Host-Key', metadata.hostKey || '');
  res.set('X-Routing-Source', metadata.routingSource || '');
  res.set('X-AgentX-Context-Window', String(
    metadata.inferenceContract?.contextBudget?.windowTokens
      || metadata.options?.num_ctx
      || ''
  ));
}

function publicError(error) {
  const status = Number(error?.statusCode || error?.status || 500);
  const code = String(error?.code || 'RUNTIME_BRIDGE_ERROR');
  const safeStatus = status >= 400 && status <= 599 ? status : 500;
  const clientSafe = safeStatus < 500 || [
    'INFERENCE_TIMEOUT',
    'INFERENCE_CANCELLED',
    'CLOUD_PROVIDER_NOT_CONFIGURED',
    'BENCHMARK_CLAIM_ACTIVE',
    'RUNTIME_INFERENCE_ADMISSION_DENIED',
    'RUNTIME_INFERENCE_RECOVERY_REQUIRED'
  ].includes(code);
  return {
    status: safeStatus,
    code,
    message: clientSafe ? String(error?.message || 'Runtime bridge request failed.') : 'Runtime bridge upstream request failed.'
  };
}

function sendRuntimeError(res, error, logger, label) {
  const safe = publicError(error);
  if (safe.status >= 500 && safe.code !== 'INFERENCE_CANCELLED') {
    logger?.warn?.(`${label} failed`, { code: safe.code, status: safe.status });
  }
  if (!res.headersSent) return res.status(safe.status).json({ error: safe.message, code: safe.code });
  return res.end();
}

function uniqueEffectiveModels(snapshot) {
  const seen = new Set();
  const rows = [];
  for (const task of Object.values(snapshot?.tasks || {})) {
    const model = String(task?.model || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    rows.push(task);
  }
  return rows;
}

function effectiveModel(snapshot, model) {
  return uniqueEffectiveModels(snapshot).find((row) => row.model === model || row.configuredModel === model) || null;
}

function enforceEffectiveModel(snapshot, body) {
  const model = String(body?.model || body?.name || '').trim();
  const effective = effectiveModel(snapshot, model);
  if (!model || !effective) {
    const error = new Error(model ? 'model is not part of the effective AgentX routing configuration' : 'model is required');
    error.statusCode = model ? 409 : 400;
    error.code = model ? 'MODEL_NOT_EFFECTIVE' : 'MODEL_REQUIRED';
    throw error;
  }
  const requestedContext = Number(body?.options?.num_ctx);
  if (Number.isFinite(requestedContext) && requestedContext > 0
    && effective.contextSize && Math.round(requestedContext) !== effective.contextSize) {
    const error = new Error('requested context does not match the effective AgentX context contract');
    error.statusCode = 409;
    error.code = 'CONTEXT_POLICY_MISMATCH';
    throw error;
  }
  return effective;
}

// Disconnected clients stop receiving bytes; admitted local streams still
// reach Core's terminal validator instead of stalling behind backpressure.
function pipeRuntimeStream(stream, res, signal) {
  const drain = () => { stream.unpipe(res); stream.resume(); };
  const cleanup = () => signal.removeEventListener('abort', drain);
  stream.once('end', cleanup);
  stream.once('close', cleanup);
  if (signal.aborted) drain();
  else {
    signal.addEventListener('abort', drain, { once: true });
    stream.pipe(res);
  }
}

module.exports = {
  pipeRuntimeStream,
  applyRoutingHeaders,
  cleanBaseUrl,
  effectiveModel,
  enforceEffectiveModel,
  publicError,
  requestAbort,
  sendRuntimeError,
  uniqueEffectiveModels
};
