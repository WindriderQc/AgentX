'use strict';

const crypto = require('node:crypto');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');
const { describeFailure } = require('../../../shared/failureDiagnostics');

// This is an instance inventory, not GPU discovery or release evidence. A
// consumer can name several devices; CPU-only endpoints are left unmapped.
function resourceTopology(raw = process.env.AGENTX_RUNTIME_RESOURCES_JSON) {
  if (raw === undefined || raw === '') return { hash: null, resources: [] };
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 128 * 1024) throw new Error();
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > 128) throw new Error();
    const ids = new Set();
    const resources = rows.map(row => {
      if (!row || typeof row.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(row.id)
        || ids.has(row.id) || Object.keys(row).some(key => !['id', 'endpoints'].includes(key))
        || !Array.isArray(row.endpoints)
        || !row.endpoints.length || row.endpoints.length > 128) throw new Error();
      ids.add(row.id);
      const endpoints = [...new Set(row.endpoints.map(value => {
        if (typeof value !== 'string' || value.length > 500) throw new Error();
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
          || url.search || url.hash || url.pathname !== '/') throw new Error();
        return hostUrlKey(value);
      }))].sort();
      return { id: row.id, endpoints };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { hash: resources.length
      ? crypto.createHash('sha256').update(JSON.stringify(resources)).digest('hex') : null, resources };
  } catch {
    // Do not echo the private inventory or silently discard an invalid entry.
    throw Object.assign(new Error('Physical runtime resource configuration is invalid'), {
      code: 'runtime_resource_configuration_invalid'
    });
  }
}

function resourcesFor(topology, hosts) {
  return topology.resources.filter(row => row.endpoints.some(host => hosts.includes(host)))
    .map(row => row.id).sort();
}

function topologyGuard(topology) {
  // A configuration change can take effect only after every admission has
  // settled. This predicate and insertion share the singleton Mongo CAS.
  // Old admissions without resource IDs, including UNKNOWN, keep their fence.
  return { $and: [{ $or: [
    { resourceTopologyHash: topology.hash },
    { 'inferences.0': { $exists: false }, 'workloads.0': { $exists: false } }
  ] }] };
}

function topologyMatches(state, topology) {
  return (state?.resourceTopologyHash || null) === topology.hash
    || (!(state?.inferences || []).length && !(state?.workloads || []).length);
}

function resourceFailure(cause) {
  return { acquired: false, reason: cause === 'runtime_resource_configuration_changed'
    ? 'Physical resource mapping changed while runtime admissions remain held'
    : 'Physical runtime resource configuration is invalid',
  failure: { cause, retryable: false, safeToRetry: true, retryAfterMs: null,
    holder: null, diagnostic: describeFailure(cause) } };
}

function overlaps(item, host, resources) {
  return item.host === host || (item.hosts || []).includes(host)
    || (item.resourceIds || []).some(id => resources.includes(id));
}

module.exports = { resourceTopology, resourcesFor, topologyGuard, topologyMatches, resourceFailure, overlaps };
