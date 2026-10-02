'use strict';

const { describeFailure, describePipelineFailures } = require('../../../shared/failureDiagnostics');

test('pre-dispatch admission refusal explains fresh admission evidence without granting retry', () => {
  const result = describeFailure('workload_reserved', { safeToRetry: true, retryable: true });
  expect(result).toMatchObject({ code: 'workload_reserved', category: 'admission',
    evidenceSource: 'runtime_admission', nextAction: 'wait_for_admission',
    recovery: { authorization: 'not_granted' } });
  expect(result.recovery.requiredEvidence).toContain('request_not_dispatched');
  expect(result.recovery.requiredEvidence).toContain('admission_revalidated');
});

test.each(['ETIMEDOUT', 'ECONNRESET', 'OLLAMA_STREAM_INCOMPLETE', 'OLLAMA_RESPONSE_INCOMPLETE',
  'stream_interrupted', 'stream_completion_unverified'])('%s requires settlement of the prior execution', code => {
  const result = describeFailure(code, { safeToRetry: true, completed: true });
  expect(result.recovery.authorization).toBe('not_granted');
  expect(result.recovery.requiredEvidence).toContain('prior_execution_settled');
  expect(result.nextAction).not.toBe('wait_for_admission');
  expect(result.classification).not.toBe('model_error');
});

test('runtime quarantine needs restoration and does not become safe when a lease expires', () => {
  const result = describeFailure('workload_recovery_required', { leaseExpired: true });
  expect(result).toMatchObject({ category: 'admission', nextAction: 'reconcile_runtime_owner' });
  expect(result.recovery.requiredEvidence).toEqual(expect.arrayContaining([
    'prior_execution_settled', 'restoration_verified', 'admission_revalidated',
  ]));
  expect(result.recovery.authorization).toBe('not_granted');
});

test('a generic admission denial cannot imply pre-dispatch safety after an unacknowledged release', () => {
  const result = describeFailure('RUNTIME_INFERENCE_ADMISSION_DENIED');
  expect(result.category).toBe('unknown');
  expect(result.recovery.requiredEvidence).toContain('prior_execution_settled');
  expect(result.recovery.authorization).toBe('not_granted');
});

test('wrong model identity is an evidence problem, separate from a failed result', () => {
  const identity = describeFailure('attribution_session_model_mismatch');
  const result = describeFailure('no_diff_in_final');
  expect(identity).toMatchObject({ category: 'evidence', nextAction: 'reconcile_execution_evidence' });
  expect(identity.recovery.requiredEvidence).toContain('receipt_identity_verified');
  expect(result).toMatchObject({ category: 'model', classification: 'invalid_result' });
  expect(result.recovery.authorization).toBe('not_granted');
});

test('a reported model refusal uses the worker classification without inventing quality or retry authority', () => {
  const result = describeFailure('provider_specific_refusal', { classification: 'model_error', retryable: true });
  expect(result).toMatchObject({ code: 'provider_specific_refusal', recognizedCode: false,
    category: 'model', classification: 'model_error', evidenceSource: 'model_response',
    recovery: { authorization: 'not_granted' } });
  expect(result.recovery.requiredEvidence).toContain('model_identity_verified');
});

test('generic worker provider/result classifications do not imply a proven rejection or model fault', () => {
  const provider = describeFailure('new_transport_code', { classification: 'provider_error' });
  expect(provider).toMatchObject({ category: 'availability', nextAction: 'inspect_provider_execution' });
  expect(provider.recovery.requiredEvidence).toContain('prior_execution_settled');
  const result = describeFailure('new_contract_code', { classification: 'invalid_result' });
  expect(result).toMatchObject({ category: 'evidence', nextAction: 'inspect_result_contract' });
  expect(result.recovery.requiredEvidence).toContain('receipt_identity_verified');
});

test('failed tests, grader crash and unreadable response have different evidence owners', () => {
  const tests = describeFailure('independent_verification_failed');
  const grader = describeFailure('grader_error');
  const unreadable = describeFailure('OLLAMA_RESPONSE_INCOMPLETE');
  expect(tests).toMatchObject({ category: 'verification', evidenceSource: 'independent_verification' });
  expect(grader).toMatchObject({ category: 'evaluator', classification: 'harness_error',
    evidenceSource: 'qualified_evaluator', nextAction: 'repair_or_requalify_evaluator' });
  expect(grader.recovery.requiredEvidence).toContain('evaluator_qualified');
  expect(unreadable.category).toBe('unknown');
  expect(unreadable.recovery.requiredEvidence).toContain('prior_execution_settled');
});

test('a partial receipt remains an evidence failure even with passed tests and a supplied retry flag', () => {
  const evidence = { failureCodes: ['SUCCESS_MISSING_EVIDENCE'], verification: { status: 'passed' },
    safeToRetry: true, recovery: { authorization: 'granted' } };
  const snapshot = JSON.stringify(evidence);
  const [result] = describePipelineFailures(evidence);
  expect(result).toMatchObject({ code: 'SUCCESS_MISSING_EVIDENCE', category: 'evidence',
    recovery: { authorization: 'not_granted' } });
  expect(result.recovery.requiredEvidence).toContain('required_evidence_complete');
  expect(JSON.stringify(evidence)).toBe(snapshot);
});

test.each(['configuration', 'availability', 'policy', 'budget', 'worker'])(
  '%s stays separate from model quality', category => {
    const codes = { configuration: 'INFERENCE_HOST_INVALID', availability: 'connection_unavailable',
      policy: 'protected_scope', budget: 'cost_budget_exceeded', worker: 'worker_process_failed' };
    expect(describeFailure(codes[category])).toMatchObject({ category,
      recovery: { authorization: 'not_granted' } });
  });

test('unknown codes remain readable and cannot borrow policy or timeout authority by substring', () => {
  const result = describeFailure('future_policy_timeout_code', { classification: 'future_class', safeToRetry: true });
  expect(result).toMatchObject({ code: 'future_policy_timeout_code', recognizedCode: false,
    classification: 'unknown', category: 'unknown', recovery: { authorization: 'not_granted' } });
  expect(describeFailure('worker_process_failed:exit=1').recognizedCode).toBe(false);
});

test('malformed codes do not expose response bodies or credentials in diagnostics', () => {
  const result = describeFailure('Provider failed at https://user:secret@host/private');
  expect(result.code).toBeNull();
  expect(JSON.stringify(result)).not.toContain('secret');
});

test('legacy verification verdicts remain separate from persisted codes', () => {
  const evidence = { failureCodes: [], verification: { status: 'failed' } };
  const [result] = describePipelineFailures(evidence);
  expect(result).toMatchObject({ code: null, category: 'verification', derivedFrom: 'verification.status' });
  expect(evidence.failureCodes).toEqual([]);
  expect(describePipelineFailures({ failureCodes: ['independent_verification_failed'],
    verification: { status: 'failed' } })).toHaveLength(1);
});

test('terminal inference causes are diagnosed but successful retry history is not an active failure', () => {
  const evidence = { failureCodes: ['worker_process_failed'], inference: {
    state: 'recovery_required', cause: 'stream_interrupted' } };
  expect(describePipelineFailures(evidence)).toEqual(expect.arrayContaining([
    expect.objectContaining({ category: 'worker' }),
    expect.objectContaining({ code: 'stream_interrupted', category: 'unknown', derivedFrom: 'inference' }),
  ]));
  expect(describePipelineFailures({ inference: { state: 'completed',
    history: [{ cause: 'workload_reserved' }] } })).toEqual([]);
  expect(describePipelineFailures({ inference: { state: 'recovery_required' } })[0].category).toBe('unknown');
  expect(describePipelineFailures(null)).toEqual([]);
});

test('a transient cause cannot hide terminal recovery even when the code is already recorded', () => {
  const failures = describePipelineFailures({ failureCodes: ['connection_unavailable'],
    inference: { state: 'recovery_required', cause: 'connection_unavailable' } });
  const recovery = failures.find(item => item.derivedFrom === 'inference');
  expect(recovery).toMatchObject({ code: 'connection_unavailable', evidenceSource: 'runtime_recovery',
    nextAction: 'reconcile_execution_outcome', recovery: { authorization: 'not_granted' } });
  expect(recovery.recovery.requiredEvidence).toContain('prior_execution_settled');
  expect(recovery.recovery.requiredEvidence).toContain('restoration_verified');
});

test('required evidence arrays cannot be changed by another reader', () => {
  const first = describeFailure('workload_reserved');
  first.recovery.requiredEvidence.length = 0;
  expect(describeFailure('workload_reserved').recovery.requiredEvidence).toContain('admission_revalidated');
});
