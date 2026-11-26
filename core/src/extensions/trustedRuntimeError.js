'use strict';

const { frozenCopy } = require('../helpers/frozenCopy');

class TrustedRuntimeServiceError extends Error {
  constructor(message, { code = 'RUNTIME_INFERENCE_ERROR', statusCode = 500, cause = null } = {}) {
    super(message);
    this.name = 'TrustedRuntimeServiceError';
    this.code = code;
    this.statusCode = statusCode;
    if (cause) {
      this.cause = cause;
      if (cause.failure) this.failure = frozenCopy(cause.failure);
      if (cause.retry) this.retry = frozenCopy(cause.retry);
    }
  }
}

function topologyRefusal(refusal) {
  const error = new TrustedRuntimeServiceError(refusal.message, { code: refusal.code, statusCode: refusal.status });
  return Object.assign(error, { details: frozenCopy(refusal.data),
    failure: { cause: refusal.code.toLowerCase(), safeToRetry: true } });
}

module.exports = { TrustedRuntimeServiceError, topologyRefusal };
