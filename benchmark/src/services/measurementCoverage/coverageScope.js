'use strict';

/**
 * What the coverage job measures: on each host, the models pinned there and
 * the models the task routing table sends there. Not the whole catalog.
 */

const { getConfiguredHosts } = require('../../helpers/ollamaHostConfig');
const { getDedicationStatuses } = require('../../clients/coreModelHostApi');
const { getRoutingConfig } = require('../../clients/coreCoverageReads');
const { isEmbeddingModelName } = require('../../../../shared/embeddingModels');
const { normalizeModelTag } = require('../../../../shared/modelNames');

const hostKey = url => String(url || '').trim().replace(/\/+$/, '').toLowerCase();
const modelKey = name => normalizeModelTag(name).toLowerCase();

/**
 * @returns {Promise<Array<{hostUrl, hostName, residency, model, pinned, tasks}>>}
 */
async function resolveScope(deps = {}) {
  const hosts = (deps.hosts || getConfiguredHosts)();
  // The routing table lives under the Nerve Center, which the demo profile
  // does not serve: without it the scope is the pinned models.
  const [preferences, routing] = await Promise.all([
    (deps.preferences || getDedicationStatuses)(),
    (deps.routing || getRoutingConfig)().catch(() => ({ taskModels: {}, hosts: {} })),
  ]);
  const cells = new Map();
  const known = new Map(hosts.map(host => [hostKey(host.url), host]));

  function cell(url, model) {
    const host = known.get(hostKey(url));
    const name = String(model || '').trim();
    // Embedding models answer no catalog prompt.
    if (!host || !name || isEmbeddingModelName(name)) return null;
    const key = `${hostKey(url)}::${modelKey(name)}`;
    if (!cells.has(key)) {
      cells.set(key, {
        hostUrl: host.url, hostName: host.name || host.id || host.url, residency: host.residency || 'gpu',
        model: name, pinned: false, pinContext: 0, tasks: []
      });
    }
    return cells.get(key);
  }

  for (const preference of preferences || []) {
    for (const pin of preference.pinnedModels || []) {
      const entry = cell(preference.hostUrl || preference.host, typeof pin === 'string' ? pin : pin?.model);
      if (entry) {
        entry.pinned = true;
        entry.pinContext = Number(pin?.contextSize) > 0 ? Number(pin.contextSize) : 0;
      }
    }
  }
  for (const [task, route] of Object.entries(routing?.taskModels || {})) {
    const target = routing.hosts?.[route?.host];
    const entry = cell(typeof target === 'string' ? target : target?.url, route?.model);
    if (entry && !entry.tasks.includes(task)) entry.tasks.push(task);
  }
  return [...cells.values()].sort((a, b) =>
    a.hostName.localeCompare(b.hostName) || a.model.localeCompare(b.model));
}

module.exports = { resolveScope, hostKey, modelKey };
