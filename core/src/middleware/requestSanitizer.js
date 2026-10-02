'use strict';

const mongoSanitize = require('express-mongo-sanitize');

// Model protocol bridges forward bodies to inference hosts, never to MongoDB.
// Their tool definitions legitimately carry JSON Schema keys such as `$schema`
// and `$ref`; rewriting them would alter what the model receives.
const INFERENCE_PROXY_PREFIXES = Object.freeze([
  '/api/openclaw-ollama/',
  '/api/hermes-openai/'
]);

function isInferenceProxyPath(path) {
  return INFERENCE_PROXY_PREFIXES.some((prefix) => String(path || '').startsWith(prefix));
}

// Sanitize MongoDB operators out of request input (NoSQL injection), except on
// the inference proxy routes above.
function createRequestSanitizer({ logger }) {
  const sanitize = mongoSanitize({
    replaceWith: '_',
    onSanitize: ({ req, key }) => {
      logger.warn('Sanitized malicious input', {
        ip: req.ip,
        key,
        path: req.path
      });
    }
  });
  return function requestSanitizer(req, res, next) {
    if (isInferenceProxyPath(req.path)) return next();
    return sanitize(req, res, next);
  };
}

module.exports = { INFERENCE_PROXY_PREFIXES, createRequestSanitizer, isInferenceProxyPath };
