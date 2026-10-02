'use strict';

const crypto = require('crypto');
const { clean } = require('./runtimeCoordinationState');

const RESIDENCY_OPTION_KEYS = Object.freeze([
  'num_ctx',
  'num_batch',
  'num_gpu',
  'main_gpu',
  'low_vram',
  'num_thread',
  'numa',
  'use_mmap',
  'use_mlock',
  'vocab_only',
  'adapters'
]);

function canonicalResidencyValue(value) {
  if (Array.isArray(value)) return value.map(item => canonicalResidencyValue(item));
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
}

function classifyKeepAlive(value, supplied) {
  if (!supplied || value === undefined) return 'default';
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (Number.isFinite(numeric)) {
    if (numeric < 0) return 'persistent';
    if (numeric === 0) return 'unload';
    return 'finite';
  }
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'explicit-empty';
  if (['infinite', 'infinity', 'always'].includes(text)) return 'persistent';
  return 'finite';
}

function buildInferenceResidencySpec({ model, runtimeOptions, keepAlive, keepAliveSupplied } = {}) {
  const source = runtimeOptions && typeof runtimeOptions === 'object' && !Array.isArray(runtimeOptions)
    ? runtimeOptions
    : {};
  const runner = {};
  for (const key of RESIDENCY_OPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      runner[key] = canonicalResidencyValue(source[key]);
    }
  }
  return {
    version: 1,
    model: clean(model, 500),
    runner,
    keepAliveClass: classifyKeepAlive(keepAlive, keepAliveSupplied)
  };
}

function buildInferenceResidencyKey(input) {
  const spec = buildInferenceResidencySpec(input);
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex')}`;
}

module.exports = {
  classifyKeepAlive,
  buildInferenceResidencySpec,
  buildInferenceResidencyKey
};
