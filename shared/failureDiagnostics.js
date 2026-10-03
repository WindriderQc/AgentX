'use strict';

const { FAILURE_CLASSIFICATIONS } = require('./workerContract');

const FAILURE_DIAGNOSTIC_SCHEMA = 'agentx.failure-diagnostic/v1';

// These describe the authority to consult, not evidence already verified.
// Codes, worker receipt fingerprints and retry decisions remain owned by their
// existing contracts/controllers. This projection cannot authorize an effect.
function definition(category, classification, evidenceSource, nextAction, requiredEvidence) {
  if (!FAILURE_CLASSIFICATIONS.includes(classification)) throw new Error('Unsupported failure classification');
  return Object.freeze({ category, classification, evidenceSource, nextAction,
    requiredEvidence: Object.freeze(requiredEvidence) });
}

const TYPES = Object.freeze({
  configuration: definition('configuration', 'adapter_error', 'validated_configuration',
    'correct_configuration', ['configuration_validated', 'admission_revalidated']),
  admission: definition('admission', 'infrastructure_error', 'runtime_admission',
    'wait_for_admission', ['request_not_dispatched', 'admission_revalidated']),
  admissionProof: definition('admission', 'policy_violation', 'runtime_admission',
    'revalidate_admission_proof', ['owner_and_generation_verified', 'admission_revalidated']),
  admissionRecovery: definition('admission', 'infrastructure_error', 'runtime_recovery',
    'reconcile_runtime_owner', ['prior_execution_settled', 'restoration_verified', 'admission_revalidated']),
  availability: definition('availability', 'provider_error', 'provider_transport',
    'check_provider_availability', ['request_not_dispatched_or_rejection_verified', 'admission_revalidated']),
  rejection: definition('availability', 'provider_error', 'provider_response',
    'inspect_provider_rejection', ['rejection_verified', 'request_corrected', 'admission_revalidated']),
  provider: definition('availability', 'provider_error', 'provider_transport',
    'inspect_provider_execution', ['prior_execution_settled', 'provider_outcome_verified', 'admission_revalidated']),
  worker: definition('worker', 'harness_error', 'worker_execution',
    'inspect_worker_execution', ['prior_execution_settled', 'workspace_effects_reconciled', 'admission_revalidated']),
  model: definition('model', 'model_error', 'model_response',
    'inspect_model_response', ['response_contract_verified', 'model_identity_verified']),
  result: definition('model', 'invalid_result', 'result_contract',
    'inspect_result_contract', ['result_contract_verified', 'model_identity_verified']),
  invalidResult: definition('evidence', 'invalid_result', 'result_contract',
    'inspect_result_contract', ['prior_execution_settled', 'result_contract_verified', 'receipt_identity_verified']),
  verification: definition('verification', 'invalid_result', 'independent_verification',
    'inspect_verification_report', ['exact_revision_verified', 'verification_report_verified']),
  evaluator: definition('evaluator', 'harness_error', 'qualified_evaluator',
    'repair_or_requalify_evaluator', ['evaluator_qualified', 'independent_evaluation_verified']),
  evidence: definition('evidence', 'invalid_result', 'bound_execution_receipt',
    'reconcile_execution_evidence', ['prior_execution_settled', 'receipt_identity_verified', 'required_evidence_complete']),
  policy: definition('policy', 'policy_violation', 'execution_policy',
    'resolve_policy_block', ['scope_and_policy_approved', 'admission_revalidated']),
  budget: definition('budget', 'budget_exceeded', 'budget_accounting',
    'review_budget', ['prior_usage_reconciled', 'budget_approved', 'admission_revalidated']),
  timeout: definition('timeout', 'timeout', 'execution_controller',
    'reconcile_execution_outcome', ['prior_execution_settled', 'effects_reconciled', 'admission_revalidated']),
  cancellation: definition('cancellation', 'cancelled', 'execution_controller',
    'verify_cancellation', ['prior_execution_settled', 'effects_reconciled']),
  tool: definition('worker', 'tool_error', 'tool_execution',
    'inspect_tool_execution', ['tool_outcome_verified', 'effects_reconciled']),
  adapter: definition('worker', 'adapter_error', 'adapter_execution',
    'inspect_adapter_execution', ['prior_execution_settled', 'adapter_contract_verified']),
  infrastructure: definition('availability', 'infrastructure_error', 'runtime_health',
    'inspect_runtime_health', ['prior_execution_settled', 'runtime_health_verified', 'admission_revalidated']),
  unknown: definition('unknown', 'unknown', 'execution_controller',
    'inspect_execution_evidence', ['prior_execution_settled', 'effects_reconciled', 'failure_cause_verified']),
});

// Exact identifiers only. A future code containing "policy" or "timeout" is
// not proof that it belongs to that family. Keep the original code visible.
const CODES = new Map();
function register(type, codes) {
  for (const code of codes) CODES.set(code.toLowerCase(), TYPES[type]);
}

register('configuration', ['INFERENCE_HOST_INVALID', 'RUNTIME_INFERENCE_HOST_INVALID', 'INVALID_AUTOMATION_INTENT',
  'runtime_resource_configuration_invalid', 'runtime_resource_configuration_changed',
  'automation_invalid', 'automation_missing', 'automation_manual', 'attribution_requested_model_invalid']);
register('admission', ['BENCHMARK_CLAIM_ACTIVE', 'HOST_SESSION_HOLD_BUSY',
  'workload_reserved', 'workload_yielded',
  'maintenance_active', 'inference_active', 'inference_residency_active', 'task_unavailable',
  'not_before', 'dependencies_incomplete', 'resource_lock_conflict']);
register('admissionProof', ['BENCHMARK_CLAIM_PROOF_INVALID', 'workload_proof_invalid']);
register('admissionRecovery', ['RUNTIME_INFERENCE_RECOVERY_REQUIRED', 'RUNTIME_INFERENCE_ADMISSION_LOST',
  'RUNTIME_INFERENCE_ADMISSION_CLOSED', 'inference_recovery_required', 'maintenance_recovery_required',
  'workload_recovery_required']);
register('availability', ['connection_unavailable', 'provider_temporarily_unavailable',
  'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
register('rejection', ['provider_rejected', 'INFERENCE_PROVIDER_REJECTED']);
register('worker', ['worker_process_failed', 'runner_error']);
register('result', ['empty_response', 'thinking_only', 'no_diff_in_final', 'patch_did_not_apply']);
register('verification', ['independent_verification_failed', 'public_test_failed',
  'hidden_test_failed', 'regression_failed']);
register('evaluator', ['grader_error', 'llm_failed', 'no_valid_scores']);
register('evidence', ['worker_snapshot_receipt_failed', 'attribution_lease_evidence_invalid',
  'attribution_request_count_mismatch', 'attribution_session_model_mismatch', 'winner_route_mismatch',
  'cost_evidence_invalid', 'cost_evidence_unavailable', 'cost_provider_mismatch',
  'local_energy_evidence_unavailable', 'RECEIPT_SELECTION_MISMATCH', 'RECEIPT_ENVELOPE_MISMATCH',
  'RECEIPT_FINGERPRINT_MISMATCH', 'SUCCESS_MISSING_EVIDENCE']);
register('policy', ['protected_scope', 'risk_not_low', 'out_of_scope_edits',
  'paid_execution_disabled', 'fallback_used_for_explicit_model', 'local_zero_cost_nonzero',
  'local_zero_has_billed_origin']);
register('budget', ['attempt_budget_exhausted', 'cost_budget_exceeded', 'SUCCESS_EXCEEDS_BUDGET']);
register('timeout', ['ETIMEDOUT', 'timeout']);
register('cancellation', ['RUNTIME_INFERENCE_ADMISSION_ABORTED', 'cancelled']);
register('unknown', ['admission_conflict_unclassified', 'inference_outcome_unknown',
  // This outer code also covers an unacknowledged release after dispatch.
  'RUNTIME_INFERENCE_ADMISSION_DENIED',
  'ECONNRESET', 'stream_interrupted', 'stream_completion_unverified', 'OLLAMA_STREAM_INCOMPLETE',
  'OLLAMA_RESPONSE_INCOMPLETE', 'OLLAMA_EMBED_RESPONSE_INVALID', 'OLLAMA_REJECTION_UNVERIFIED',
  'model_call_failed', 'truncated_no_final']);

const WORKER_TYPES = Object.freeze({
  harness_error: TYPES.worker, adapter_error: TYPES.adapter, provider_error: TYPES.provider,
  model_error: TYPES.model, tool_error: TYPES.tool, policy_violation: TYPES.policy,
  budget_exceeded: TYPES.budget, timeout: TYPES.timeout, cancelled: TYPES.cancellation,
  invalid_result: TYPES.invalidResult, infrastructure_error: TYPES.infrastructure, unknown: TYPES.unknown,
});

function boundedCode(value) {
  // Error messages, response bodies and endpoint details are not codes.
  return typeof value === 'string' && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
    ? value : null;
}

function describeFailure(value, { classification } = {}) {
  const code = boundedCode(value);
  const known = code ? CODES.get(code.toLowerCase()) : null;
  const fallback = FAILURE_CLASSIFICATIONS.includes(classification) ? WORKER_TYPES[classification] : null;
  const type = known || fallback || TYPES.unknown;
  return {
    schema: FAILURE_DIAGNOSTIC_SCHEMA,
    code,
    recognizedCode: Boolean(known),
    category: type.category,
    classification: type.classification,
    evidenceSource: type.evidenceSource,
    nextAction: type.nextAction,
    recovery: { authorization: 'not_granted', requiredEvidence: [...type.requiredEvidence] },
  };
}

function describePipelineFailures(evidence) {
  if (!evidence) return [];
  const codes = Array.isArray(evidence.failureCodes) ? evidence.failureCodes.slice(0, 32) : [];
  const failures = codes.map(code => describeFailure(code));
  // Verdicts stay separate from codes. Do not invent a persisted failure code
  // when a legacy receipt records only a failed verification status.
  if (evidence.verification?.status === 'failed' && !failures.some(item => item.category === 'verification')) {
    failures.push({ ...describeFailure('independent_verification_failed'), code: null,
      recognizedCode: false, derivedFrom: 'verification.status' });
  }
  if (['failed', 'exhausted', 'cancelled', 'recovery_required'].includes(evidence.inference?.state)) {
    const cause = evidence.inference.cause || (evidence.inference.state === 'cancelled' ? 'cancelled' : null);
    if (!cause || !codes.includes(cause) || evidence.inference.state === 'recovery_required') {
      const diagnostic = describeFailure(cause);
      // Terminal progress can require recovery even when its initial cause
      // looked transient. Never erase that uncertainty with a cause label.
      if (evidence.inference.state === 'recovery_required') {
        diagnostic.nextAction = 'reconcile_execution_outcome';
        diagnostic.evidenceSource = 'runtime_recovery';
        diagnostic.recovery.requiredEvidence = [...new Set([
          'prior_execution_settled', 'restoration_verified', ...diagnostic.recovery.requiredEvidence,
        ])];
      }
      failures.push({ ...diagnostic, derivedFrom: 'inference' });
    }
  }
  return failures;
}

module.exports = { FAILURE_DIAGNOSTIC_SCHEMA, describeFailure, describePipelineFailures };
