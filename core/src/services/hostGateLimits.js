'use strict';

const { getConfiguredHosts } = require('../helpers/ollamaHostConfig');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');

// Global per-(host, model) in-flight limit, and a host's own limit when the
// inference host registry sets one (a CPU instance usually serves one agent
// at a time, so further requests queue here instead of inside Ollama).
const MAX_INFLIGHT = Math.max(1, parseInt(process.env.GATE_MAX_INFLIGHT, 10) || 2);

function inflightLimitFor(host) {
  const key = hostUrlKey(host);
  if (!key || typeof getConfiguredHosts !== 'function') return MAX_INFLIGHT;
  const configured = (getConfiguredHosts() || []).find(entry => hostUrlKey(entry.url) === key);
  return configured?.maxInflight > 0 ? configured.maxInflight : MAX_INFLIGHT;
}

module.exports = { MAX_INFLIGHT, inflightLimitFor };
