'use strict';

const RuntimeCoordination = require('../../models/RuntimeCoordination');
const { clean } = require('./runtimeCoordinationState');

async function markMaintenanceUnknown({ id, generation, principal, reason = null } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  const boundedReason = clean(reason, 500) || 'maintenance terminal state is unknown';
  if (!id || !generation || !principal) {
    return { quarantined: false, reason: 'exact maintenance proof required' };
  }
  const now = new Date();
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      'maintenance.leaseId': id,
      'maintenance.generation': generation,
      'maintenance.principal': principal,
      'maintenance.state': { $in: ['ACTIVE', null] }
    },
    { $set: {
      'maintenance.state': 'UNKNOWN',
      'maintenance.unknownAt': now,
      'maintenance.unknownReason': boundedReason
    } },
    { new: true }
  ).lean();
  const owned = updated?.maintenance;
  if (owned?.leaseId === id && owned?.generation === generation && owned?.principal === principal) {
    return {
      contract: 'agentx.maintenance-quarantine/v1',
      coordinationKind: 'maintenance',
      quarantined: true,
      leaseId: owned.leaseId,
      generation: owned.generation,
      principal: owned.principal,
      requestId: owned.requestId,
      scope: owned.scope,
      state: 'UNKNOWN',
      unknownAt: owned.unknownAt,
      reason: owned.unknownReason
    };
  }
  const existing = await RuntimeCoordination.findById('runtime').lean();
  const quarantined = existing?.maintenance;
  return quarantined?.leaseId === id
    && quarantined?.generation === generation
    && quarantined?.principal === principal
    && quarantined?.state === 'UNKNOWN'
    ? {
      contract: 'agentx.maintenance-quarantine/v1',
      coordinationKind: 'maintenance',
      quarantined: true,
      leaseId: quarantined.leaseId,
      generation: quarantined.generation,
      principal: quarantined.principal,
      requestId: quarantined.requestId,
      scope: quarantined.scope,
      state: 'UNKNOWN',
      unknownAt: quarantined.unknownAt,
      reason: quarantined.unknownReason,
      idempotent: true
    }
    : { quarantined: false, reason: 'maintenance proof no longer owns active coordination state' };
}

async function recoverMaintenanceAfterOperatorReconciliation({ id, generation, principal, receipt } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  const exactReceipt = receipt?.contract === 'agentx.maintenance-recovery/v1'
    && receipt?.maintenanceReconciled === true
    && receipt?.confirmation === 'MAINTENANCE_SIDE_EFFECTS_VERIFIED_OR_ROLLED_BACK'
    && typeof receipt?.reconciledAt === 'string'
    && Number.isFinite(Date.parse(receipt.reconciledAt));
  if (!id || !generation || !principal || !exactReceipt) {
    return { recovered: false, reason: 'exact maintenance proof and operator reconciliation receipt required' };
  }
  const recoveredAt = new Date();
  const recoveryReceipt = {
    coordinationKind: 'maintenance-recovery',
    recovered: true,
    released: true,
    leaseId: id,
    generation,
    principal,
    receipt,
    recoveredAt
  };
  const recovered = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      'maintenance.leaseId': id,
      'maintenance.generation': generation,
      'maintenance.principal': principal,
      'maintenance.state': 'UNKNOWN'
    },
    {
      $set: { maintenance: null },
      $push: { releaseReceipts: { $each: [recoveryReceipt], $slice: -100 } }
    },
    { new: false }
  ).lean();
  return recovered
    ? recoveryReceipt
    : { recovered: false, reason: 'matching quarantined maintenance lease was not found' };
}

module.exports = {
  markMaintenanceUnknown,
  recoverMaintenanceAfterOperatorReconciliation
};
