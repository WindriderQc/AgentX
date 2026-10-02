'use strict';

const { hostUrlKey } = require('../../../shared/ollamaHostConfig');
const { describeFailure } = require('../../../shared/failureDiagnostics');

function clean(value, max = 160) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, max) : null;
}

function canonicalHost(value) {
  const raw = clean(value, 500);
  return raw ? hostUrlKey(raw) : null;
}

function since(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

// Who holds the host, in words a consumer may show its user: labels and start
// time only, never admission ids, generations or request ids.
function holderOf(type, item) {
  if (!item) return null;
  return {
    type,
    kind: clean(item.kind, 80),
    principal: clean(item.principal, 80),
    model: type === 'inference' ? clean(item.model, 120) : null,
    since: since(item.acquiredAt)
  };
}

// Explain the state observed after a failed atomic acquisition. This is a
// diagnosis, never permission to release or replace another owner's reservation.
function inferenceConflict(state, request, now) {
  const failure = (cause, retryable = false, holder = null) => ({ cause, retryable, safeToRetry: true,
    retryAfterMs: retryable ? 2000 : null, holder, diagnostic: describeFailure(cause) });
  if (state?.maintenance) return failure(state.maintenance.state === 'UNKNOWN'
    ? 'maintenance_recovery_required' : 'maintenance_active', state.maintenance.state !== 'UNKNOWN',
  holderOf('maintenance', state.maintenance));
  const inferences = (state?.inferences || []).filter(item => canonicalHost(item.host) === request.host);
  if (inferences.some(item => item.state !== 'ACTIVE' || new Date(item.expiresAt) <= now)) {
    return failure('inference_recovery_required');
  }
  if (request.workloadAdmissionId && !(state?.workloads || []).some(item =>
    item.admissionId === request.workloadAdmissionId && item.generation === request.workloadGeneration
    && item.principal === request.principal && item.hosts.includes(request.host)
    && new Date(item.expiresAt) > now)) return failure('workload_proof_invalid');
  const workloads = (state?.workloads || []).filter(item => item.hosts.includes(request.host));
  if (workloads.some(item => item.recoveryState === 'UNKNOWN' || new Date(item.expiresAt) <= now)) {
    return failure('workload_recovery_required');
  }
  // A workload that yielded to a household turn (#62) no longer reserves the
  // host for shared inference, but refuses its own proof-bound inference.
  if (request.workloadAdmissionId) {
    const yielded = workloads.find(item => item.yieldedAt);
    if (yielded) return failure('workload_yielded', true, holderOf('workload', yielded));
  } else {
    const reserving = workloads.find(item => !item.yieldedAt);
    if (reserving) return failure('workload_reserved', true, holderOf('workload', reserving));
  }
  const exclusive = inferences.find(item => item.mode === 'exclusive');
  if (exclusive || (request.mode === 'exclusive' && inferences.length)) {
    return failure('inference_active', true, holderOf('inference', exclusive || inferences[0]));
  }
  const resident = inferences.find(item => item.residencyKey !== request.residencyKey);
  if (resident) return failure('inference_residency_active', true, holderOf('inference', resident));
  return failure('admission_conflict_unclassified');
}

module.exports = { inferenceConflict };
