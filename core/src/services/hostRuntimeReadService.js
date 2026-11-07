'use strict';

const { validateHostUrl } = require('../helpers/ollamaHostConfig');
const { fetchRunningModelInfosStrict } = require('./hostPinPrimitives');
const { defaultParking } = require('./runtimeTopologyParking');

// Reporting only: no warm-up, reconciliation, persisted writes or routing.
// Each read has its own observation; a failed read never reuses old residents.
async function readHostRuntime(hostUrl) {
  const checkedAt = new Date().toISOString();
  function parked() {
    const reason = defaultParking.parkedReason(hostUrl);
    if (!reason) return null;
    return {
      online: false, status: 'inactive', runningModels: [],
      topology: { ...reason, observedAt: defaultParking.lastObservedAt() },
      observation: { source: 'runtime_topology_parking', status: 'not_applicable',
        observedAt: null, checkedAt, reason: reason.reason }
    };
  }
  function unavailable(reason) {
    return {
      online: false, status: 'unknown', runningModels: [],
      observation: { source: 'ollama_api_ps', status: 'unavailable', observedAt: null, checkedAt, reason }
    };
  }
  const inactive = parked();
  if (inactive) return inactive;
  const validation = validateHostUrl(hostUrl);
  if (!validation.valid) return unavailable('blocked_by_allowlist');
  try {
    const runningModels = await fetchRunningModelInfosStrict(validation.host || hostUrl, 3000);
    if (runningModels.some(model => !model || typeof (model.name || model.model) !== 'string')) {
      throw new Error('Malformed resident model');
    }
    // A switch may have started while the read was in flight.
    const afterRead = parked();
    if (afterRead) return afterRead;
    return {
      hostUrl: validation.host || hostUrl,
      online: true, status: runningModels.length ? 'ready' : 'idle', runningModels,
      observation: { source: 'ollama_api_ps', status: 'fresh',
        observedAt: new Date().toISOString(), checkedAt, reason: null }
    };
  } catch {
    return parked() || unavailable('runtime_unavailable');
  }
}

module.exports = { readHostRuntime };
