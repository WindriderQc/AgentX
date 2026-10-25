'use strict';

// Closed operational vocabulary: never classify arbitrary error prose as a cause.
const ADMISSION_REASONS = Object.freeze([
  'workload_reserved', 'workload_yielded', 'workload_proof_invalid',
  'maintenance_active', 'maintenance_recovery_required', 'workload_recovery_required',
  'inference_active', 'inference_residency_active', 'inference_recovery_required',
  'admission_refused', 'admission_conflict_unclassified', 'runtime_inference_admission_denied',
  'runtime_inference_recovery_required', 'benchmark_claim_active', 'benchmark_claim_proof_invalid',
  // Topology role routing (#360): refused before dispatch, nothing truncated.
  'topology_role_unresolved', 'lane_context_exceeded', 'topology_switch_in_progress',
]);
const FAILURE_REASONS = Object.freeze([
  ...ADMISSION_REASONS, 'connection_failure', 'connection_unavailable',
  'provider_rejected', 'provider_temporarily_unavailable', 'upstream_error',
  'upstream_timeout', 'response_processing_error', 'terminal_record_unverified',
]);

function trustedRuntimeOutcome(status, error, metadata) {
  if (status === 'success') return {
    outcomeStage: 'execution', outcomeCode: 'execution_succeeded', outcomeReasonCode: null,
  };
  if (error === 'cancelled') return {
    outcomeStage: 'execution', outcomeCode: 'caller_disconnected', outcomeReasonCode: 'caller_disconnected',
  };
  const code = typeof metadata.errorCode === 'string' ? metadata.errorCode.toLowerCase() : null;
  const cause = metadata.failure?.cause;
  const refusal = ADMISSION_REASONS.includes(cause) ? cause : ADMISSION_REASONS.includes(code) ? code : null;
  if (refusal) return {
    outcomeStage: 'admission', outcomeCode: 'pre_dispatch_error', outcomeReasonCode: refusal,
  };
  const timeout = status === 'timeout' || error === 'timeout';
  const upstream = typeof error === 'string' && /^upstream_http_[1-5][0-9]{2}$/.test(error);
  const reason = timeout ? 'upstream_timeout' : upstream ? 'upstream_error' : FAILURE_REASONS.includes(error) ? error : null;
  return {
    outcomeStage: reason ? 'execution' : 'unknown',
    outcomeCode: timeout ? 'upstream_timeout' : reason ? 'upstream_error' : 'unknown',
    outcomeReasonCode: reason,
  };
}

module.exports = { ADMISSION_REASONS, FAILURE_REASONS, trustedRuntimeOutcome };
