'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const {
  CORE_RECREATE_SCOPE, HOST_SCOPE, coreRecreateWorkloadFilter, deployBlockers
} = require('./runtimeDeployGate');
const {
  resourceTopology, resourcesFor, topologyGuard, topologyMatches, resourceFailure, overlaps
} = require('./runtimePhysicalResources');
const { normalizedHosts } = require('./runtimeCoordinationState');

function sameMaintenanceIntent(existing, { scope, hosts }) {
  return existing?.scope === scope && (existing.hosts || []).join(' ') === hosts.join(' ');
}

// Work running on the leased hosts: the endpoint itself, or any endpoint on
// the same physical device (a machine's GPU and CPU instances count together).
function onHosts(item, hosts, resourceIds) {
  return hosts.some(host => overlaps(item, host, resourceIds));
}

function hostWorkFilter(hosts, resourceIds) {
  return { $or: [
    { host: { $in: hosts } },
    { hosts: { $in: hosts } },
    ...(resourceIds.length ? [{ resourceIds: { $in: resourceIds } }] : [])
  ] };
}

// Purposes a maintenance lease may state; anything else is stored as null.
const MAINTENANCE_PURPOSES = Object.freeze(['topology-switch']);

function maintenanceService(scope) {
  return scope === CORE_RECREATE_SCOPE ? 'core' : 'all';
}

// Maintenance acquisition and the deploy verdict, bound to the coordination
// service's reaper and helpers (kept outside that file so it does not grow).
function createMaintenanceAcquisition({ clean, ttlMs, secret, reapExpired }) {
  function idempotentResult(existing, { principal, requestId, scope, hosts }) {
    if (existing?.requestId !== requestId || existing.principal !== principal) return null;
    if (!sameMaintenanceIntent(existing, { scope, hosts })) {
      return { acquired: false, reason: 'idempotency key already binds a different maintenance intent' };
    }
    if ((existing.state || 'ACTIVE') !== 'ACTIVE' || new Date(existing.expiresAt).getTime() <= Date.now()) {
      return { acquired: false, recoveryRequired: true, reason: 'maintenance lease requires operator reconciliation' };
    }
    return { acquired: true, ...existing, idempotent: true };
  }

  async function acquireMaintenance({ principal, requestId, scope, hosts, ttl, purpose } = {}) {
    purpose = MAINTENANCE_PURPOSES.includes(purpose) ? purpose : null;
    principal = clean(principal);
    requestId = clean(requestId);
    scope = clean(scope) || 'runtime-deploy';
    const hostScoped = scope === HOST_SCOPE;
    hosts = hostScoped ? normalizedHosts(hosts) : [];
    if (!principal || !requestId) return { acquired: false, reason: 'principal and requestId required' };
    if (hostScoped && !hosts.length) return { acquired: false, reason: 'a host lease names at least one host' };
    let topology = null;
    if (hostScoped) {
      try { topology = resourceTopology(); } catch (error) { return resourceFailure(error.code); }
    }
    const resourceIds = hostScoped ? resourcesFor(topology, hosts) : [];
    await reapExpired();
    const current = await RuntimeCoordination.findById('runtime').lean();
    const intent = { principal, requestId, scope, hosts };
    const repeated = idempotentResult(current?.maintenance, intent);
    if (repeated) return repeated;
    if (hostScoped && !topologyMatches(current, topology)) return resourceFailure('runtime_resource_configuration_changed');
    const now = new Date();
    const lease = {
      leaseId: secret(),
      generation: secret(),
      principal,
      requestId,
      scope,
      hosts,
      resourceIds,
      purpose,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(now.getTime() + ttlMs(ttl)),
      state: 'ACTIVE',
      unknownAt: null,
      unknownReason: null
    };
    // A Core recreate leaves Benchmark-owned profiler workloads running
    // (#47); a host lease needs only its own hosts idle; every other
    // maintenance scope requires an idle runtime.
    let idle;
    if (hostScoped) {
      const busy = { $elemMatch: hostWorkFilter(hosts, resourceIds) };
      idle = { ...topologyGuard(topology), workloads: { $not: busy }, inferences: { $not: busy } };
    } else {
      idle = {
        ...(scope === CORE_RECREATE_SCOPE
          ? { workloads: coreRecreateWorkloadFilter(now) }
          : { 'workloads.0': { $exists: false } }),
        'inferences.0': { $exists: false }
      };
    }
    const updated = await RuntimeCoordination.findOneAndUpdate(
      { _id: 'runtime', maintenance: null, ...idle },
      { $set: { maintenance: lease } },
      { new: true }
    ).lean();
    if (updated) return { acquired: true, ...updated.maintenance };
    // A concurrent retry with the same idempotency key may have won the CAS
    // between our read and update. Return only that principal's Core-minted
    // proof; never translate a different owner's lease into capability.
    const raced = await RuntimeCoordination.findById('runtime').lean();
    const racedResult = idempotentResult(raced?.maintenance, intent);
    if (racedResult) return racedResult;
    const blocking = hostScoped && raced ? {
      ...raced,
      workloads: (raced.workloads || []).filter(item => onHosts(item, hosts, resourceIds)),
      inferences: (raced.inferences || []).filter(item => onHosts(item, hosts, resourceIds))
    } : raced;
    const { blockers } = deployBlockers(blocking, { service: maintenanceService(scope), now: new Date() });
    return {
      acquired: false,
      reason: hostScoped
        ? 'active workload or inference on these hosts, or a maintenance lease, blocks host maintenance'
        : 'active workload, inference admission, or maintenance lease blocks maintenance',
      blockers
    };
  }

  async function listDeployBlockers({ service } = {}) {
    await reapExpired();
    const state = await RuntimeCoordination.findById('runtime').lean();
    return deployBlockers(state, { service, now: new Date() });
  }

  return { acquireMaintenance, listDeployBlockers };
}

module.exports = { createMaintenanceAcquisition, MAINTENANCE_PURPOSES };
