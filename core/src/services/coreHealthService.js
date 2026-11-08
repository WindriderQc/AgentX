'use strict';

const { createServiceIdentity } = require('../../../shared/serviceIdentity');
const { refreshOllamaHealth } = require('./ollamaHealthProbe');

const SERVICE_VERSION = (() => {
  try { return require('../../package.json').version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

// The basic Core health contract, shared by HTTP and in-process surfaces.
// Mongo determines readiness; Ollama's live result remains an independent detail.
async function readCoreHealth(systemHealth, { publicUrl } = {}) {
  const ollamaHealth = await refreshOllamaHealth(systemHealth);
  const isHealthy = systemHealth.mongodb.status === 'connected';
  return {
    ok: isHealthy,
    ...createServiceIdentity({ service: 'agentx-core', version: SERVICE_VERSION }),
    status: isHealthy ? 'ok' : 'degraded',
    publicUrl,
    details: {
      mongodb: systemHealth.mongodb.status,
      ollama: ollamaHealth.status
    }
  };
}

module.exports = { readCoreHealth };
