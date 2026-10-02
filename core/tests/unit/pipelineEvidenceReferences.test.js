const {
  attemptLogReference,
  leaseReference,
  taskEvidenceReferences,
} = require('../../src/services/pipelineEvidenceReferences');

const FIRST = '10000000-0000-4000-8000-000000000001';
const SECOND = '10000000-0000-4000-8000-000000000002';
const RECEIPT = 'a'.repeat(64);

function attempt(number, overrides = {}) {
  return {
    attempt: number,
    leaseId: `lease-secret-${number}`,
    assignee: 'worker',
    finalState: 'review',
    reviewOutcome: 'pending',
    ...overrides,
  };
}

describe('pipeline evidence references', () => {
  test('emits one displayable chain per attempt and never the coordination lease id', () => {
    const refs = taskEvidenceReferences({
      pipelineId: '0307',
      status: 'in_progress',
      automationLease: { leaseId: 'lease-secret-2', attempt: 2 },
      automationAttempts: [
        attempt(1, { dispatchRequestId: FIRST, finalState: 'blocked', evidence: { workerReceiptFingerprint: RECEIPT, source: 'clawdx-guarded-dispatch/v1' } }),
        attempt(2, { dispatchRequestId: SECOND, finalState: 'active' }),
      ],
    });
    expect(refs.schema).toBe('agentx.pipeline-evidence-references/v1');
    expect(refs.attempts.map((row) => row.ref)).toEqual(['task-0307/attempt-2', 'task-0307/attempt-1']);
    const [latest, previous] = refs.attempts;
    expect(latest).toMatchObject({ current: true, request: { status: 'recorded', requestId: SECOND } });
    // The previous attempt's receipt is never substituted for the current one.
    expect(latest.receipt).toEqual({ status: 'absent', fingerprint: null, source: null });
    expect(previous).toMatchObject({ current: false, request: { requestId: FIRST }, receipt: { status: 'recorded', fingerprint: RECEIPT } });
    expect(refs.activeLease).toEqual({ status: 'bound', ref: latest.lease.ref, attempt: 2 });
    expect(latest.lease.ref).toMatch(/^lease-[a-f0-9]{16}$/);
    expect(latest.lease.ref).toBe(leaseReference('lease-secret-2'));
    expect(JSON.stringify(refs)).not.toMatch(/lease-secret/);
  });

  test('keeps missing, malformed and colliding references unknown', () => {
    const refs = taskEvidenceReferences({
      pipelineId: '0307',
      automationLease: { leaseId: 'orphan-lease' },
      automationAttempts: [
        attempt(1, { dispatchRequestId: FIRST, evidence: { workerReceiptFingerprint: 'not-a-hash', source: '/home/user/secret path' } }),
        attempt(2, { dispatchRequestId: FIRST }),
        attempt(3, { dispatchRequestId: '../../etc/passwd' }),
        attempt(4, { leaseId: undefined }),
      ],
    });
    const byAttempt = Object.fromEntries(refs.attempts.map((row) => [row.attempt, row]));
    expect(byAttempt[1].request).toEqual({ status: 'conflict', requestId: null });
    expect(byAttempt[2].request).toEqual({ status: 'conflict', requestId: null });
    expect(byAttempt[3].request).toEqual({ status: 'malformed', requestId: null });
    expect(byAttempt[4].request).toEqual({ status: 'not_recorded', requestId: null });
    expect(byAttempt[4].lease).toEqual({ status: 'not_recorded', ref: null });
    expect(byAttempt[1].receipt).toEqual({ status: 'malformed', fingerprint: null, source: null });
    expect(refs.conflicts).toEqual([{ code: 'request_reused', requestId: FIRST, attempts: [1, 2] }]);
    expect(refs.activeLease).toEqual({ status: 'unbound', ref: null, attempt: null });
    expect(JSON.stringify(refs)).not.toMatch(/passwd|home\/user|orphan-lease/);
  });

  test('a lease left on a task that is no longer in progress is inactive, matching the mutation fence', () => {
    for (const status of ['queued', 'review', 'blocked', 'done']) {
      const refs = taskEvidenceReferences({
        pipelineId: '0307', status,
        automationLease: { leaseId: 'lease-secret-1', attempt: 1 },
        automationAttempts: [attempt(1)],
      });
      expect(refs.activeLease).toEqual({ status: 'inactive', ref: leaseReference('lease-secret-1'), attempt: 1 });
    }
  });

  test('treats duplicate attempt numbers as ambiguous rather than picking one', () => {
    const refs = taskEvidenceReferences({
      pipelineId: '0307',
      automationAttempts: [
        attempt(1, { dispatchRequestId: FIRST, evidence: { workerReceiptFingerprint: RECEIPT } }),
        attempt(1, { dispatchRequestId: SECOND, leaseId: 'other' }),
      ],
    });
    expect(refs.conflicts).toContainEqual({ code: 'duplicate_attempt_number', attempt: 1 });
    for (const row of refs.attempts) {
      expect(row).toMatchObject({ current: false, request: { requestId: null }, lease: { ref: null }, receipt: { status: 'conflict', fingerprint: null } });
    }
  });

  test('returns no references for tasks without an exact id and no attempts for manual tasks', () => {
    expect(taskEvidenceReferences({ pipelineId: '../x' })).toBeNull();
    expect(taskEvidenceReferences({ pipelineId: '0400' })).toMatchObject({ attempts: [], conflicts: [], activeLease: null });
  });

  test('log references expose the chain without the lease id', () => {
    const entry = attemptLogReference({ pipelineId: '0307', attempt: 2, leaseId: 'lease-secret', dispatchRequestId: SECOND });
    expect(entry).toEqual({ evidenceRef: 'task-0307/attempt-2', leaseRef: leaseReference('lease-secret'), dispatchRequestId: SECOND });
    expect(attemptLogReference({ pipelineId: '0307', attempt: 2, dispatchRequestId: 'bad' })).toEqual({
      evidenceRef: 'task-0307/attempt-2', leaseRef: null, dispatchRequestId: null,
    });
  });
});
