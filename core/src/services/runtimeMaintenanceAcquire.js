'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const { CORE_RECREATE_SCOPE, coreRecreateWorkloadFilter, deployBlockers } = require('./runtimeDeployGate');

function sameMaintenanceIntent(existing, { scope }) {
  return existing?.scope === scope;
}

function maintenanceService(scope) {
  return scope === CORE_RECREATE_SCOPE ? 'core' : 'all';
}

// Maintenance acquisition and the deploy verdict, bound to the coordination
// service's reaper and helpers (kept outside that file so it does not grow).
function createMaintenanceAcquisition({ clean, ttlMs, secret, reapExpired }) {
  function idempotentResult(existing, { principal, requestId, scope }) {
    if (existing?.requestId !== requestId || existing.principal !== principal) return null;
    if (!sameMaintenanceIntent(existing, { scope })) {
      return { acquired: false, reason: 'idempotency key already binds a different maintenance intent' };
    }
    if ((existing.state || 'ACTIVE') !== 'ACTIVE' || new Date(existing.expiresAt).getTime() <= Date.now()) {
      return { acquired: false, recoveryRequired: true, reason: 'maintenance lease requires operator reconciliation' };
    }
    return { acquired: true, ...existing, idempotent: true };
  }

  async function acquireMaintenance({ principal, requestId, scope, ttl } = {}) {
    principal = clean(principal);
    requestId = clean(requestId);
    scope = clean(scope) || 'runtime-deploy';
    if (!principal || !requestId) return { acquired: false, reason: 'principal and requestId required' };
    await reapExpired();
    const current = await RuntimeCoordination.findById('runtime').lean();
    const repeated = idempotentResult(current?.maintenance, { principal, requestId, scope });
    if (repeated) return repeated;
    const now = new Date();
    const lease = {
      leaseId: secret(),
      generation: secret(),
      principal,
      requestId,
      scope,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(now.getTime() + ttlMs(ttl)),
      state: 'ACTIVE',
      unknownAt: null,
      unknownReason: null
    };
    // A Core recreate leaves Benchmark-owned profiler workloads running
    // (#47); every other maintenance scope requires an idle runtime.
    const updated = await RuntimeCoordination.findOneAndUpdate(
      {
        _id: 'runtime',
        maintenance: null,
        ...(scope === CORE_RECREATE_SCOPE
          ? { workloads: coreRecreateWorkloadFilter(now) }
          : { 'workloads.0': { $exists: false } }),
        'inferences.0': { $exists: false }
      },
      { $set: { maintenance: lease } },
      { new: true }
    ).lean();
    if (updated) return { acquired: true, ...updated.maintenance };
    // A concurrent retry with the same idempotency key may have won the CAS
    // between our read and update. Return only that principal's Core-minted
    // proof; never translate a different owner's lease into capability.
    const raced = await RuntimeCoordination.findById('runtime').lean();
    const racedResult = idempotentResult(raced?.maintenance, { principal, requestId, scope });
    if (racedResult) return racedResult;
    const { blockers } = deployBlockers(raced, { service: maintenanceService(scope), now: new Date() });
    return {
      acquired: false,
      reason: 'active workload, inference admission, or maintenance lease blocks maintenance',
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

module.exports = { createMaintenanceAcquisition };
