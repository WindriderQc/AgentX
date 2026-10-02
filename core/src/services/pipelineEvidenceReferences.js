'use strict';
const crypto = require('crypto');

// Displayable, copyable references that link one task attempt to its exact
// evidence. A reference identifies a record; it never grants an action.
// Coordination identities (lease ids), tokens, epochs, machine paths and free
// text are never emitted. A lease is shown only as a one-way fingerprint that
// cannot be used for heartbeats, feedback or releases.
const SCHEMA = 'agentx.pipeline-evidence-references/v1';
const REQUEST_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RECEIPT_RE = /^[a-f0-9]{64}$/;
const PIPELINE_ID_RE = /^\d{3,4}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9._/-]{0,79}$/i;

function exactRequestId(value) {
  const id = String(value ?? '');
  return REQUEST_ID_RE.test(id) ? id : null;
}

function leaseReference(leaseId) {
  const id = String(leaseId ?? '').trim();
  if (!id) return null;
  return `lease-${crypto.createHash('sha256').update(`agentx.lease-reference/v1\0${id}`).digest('hex').slice(0, 16)}`;
}

function attemptReference(pipelineId, attempt) {
  return `task-${pipelineId}/attempt-${attempt}`;
}

function receiptOf(attempt) {
  const evidence = attempt?.evidence;
  if (!evidence) return { status: 'absent', fingerprint: null, source: null };
  const fingerprint = String(evidence.workerReceiptFingerprint ?? '');
  const source = SOURCE_RE.test(String(evidence.source ?? '')) ? String(evidence.source) : null;
  if (!fingerprint) return { status: 'absent', fingerprint: null, source };
  return RECEIPT_RE.test(fingerprint)
    ? { status: 'recorded', fingerprint, source }
    : { status: 'malformed', fingerprint: null, source };
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) if (value != null) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function taskEvidenceReferences(task = {}) {
  const pipelineId = PIPELINE_ID_RE.test(String(task.pipelineId ?? '')) ? String(task.pipelineId) : null;
  if (!pipelineId) return null;
  const rows = (Array.isArray(task.automationAttempts) ? task.automationAttempts : [])
    .filter((attempt) => Number.isSafeInteger(attempt?.attempt) && attempt.attempt >= 1);
  const numbers = countBy(rows.map((attempt) => attempt.attempt));
  const requests = countBy(rows.map((attempt) => exactRequestId(attempt.dispatchRequestId)));
  const leases = countBy(rows.map((attempt) => leaseReference(attempt.leaseId)));
  const latest = rows.reduce((max, attempt) => Math.max(max, attempt.attempt), 0);
  const conflicts = [];
  for (const [attempt, count] of numbers) if (count > 1) conflicts.push({ code: 'duplicate_attempt_number', attempt });
  for (const [requestId, count] of requests) {
    if (count > 1) {
      conflicts.push({
        code: 'request_reused',
        requestId,
        attempts: rows.filter((row) => exactRequestId(row.dispatchRequestId) === requestId).map((row) => row.attempt),
      });
    }
  }
  for (const [lease, count] of leases) if (count > 1) conflicts.push({ code: 'lease_reused', lease });

  const attempts = rows.map((attempt) => {
    const ambiguous = numbers.get(attempt.attempt) > 1;
    const requestId = exactRequestId(attempt.dispatchRequestId);
    const lease = leaseReference(attempt.leaseId);
    const receipt = receiptOf(attempt);
    return {
      ref: attemptReference(pipelineId, attempt.attempt),
      attempt: attempt.attempt,
      current: attempt.attempt === latest && !ambiguous,
      finalState: String(attempt.finalState || 'unknown'),
      reviewOutcome: String(attempt.reviewOutcome || 'pending'),
      request: requestId && requests.get(requestId) === 1 && !ambiguous
        ? { status: 'recorded', requestId }
        : { status: requestId ? 'conflict' : (attempt.dispatchRequestId ? 'malformed' : 'not_recorded'), requestId: null },
      lease: lease && leases.get(lease) === 1 && !ambiguous
        ? { status: 'recorded', ref: lease }
        : { status: lease ? 'conflict' : 'not_recorded', ref: null },
      receipt: ambiguous ? { status: 'conflict', fingerprint: null, source: null } : receipt,
    };
  }).sort((a, b) => b.attempt - a.attempt);

  const activeLease = leaseReference(task.automationLease?.leaseId);
  const activeAttempt = activeLease ? attempts.find((row) => row.lease.ref === activeLease) : null;
  // Same rule as the mutation fence: a lease left on a task that is no longer
  // in progress is inactive and cannot be presented as the active attempt.
  const leaseActive = task.status === 'in_progress';
  return {
    schema: SCHEMA,
    pipelineId,
    task: { ref: `task-${pipelineId}` },
    activeLease: activeLease
      ? (!activeAttempt ? { status: 'unbound', ref: null, attempt: null }
        : { status: leaseActive ? 'bound' : 'inactive', ref: activeLease, attempt: activeAttempt.attempt })
      : null,
    attempts,
    conflicts,
    excluded: ['leaseId', 'tokens', 'epochs', 'releaseBodies', 'machinePaths', 'freeText'],
  };
}

// Log-safe fields for one attempt event. Callers merge them into their own
// structured log entry; no coordination identity is written.
function attemptLogReference({ pipelineId, attempt, leaseId, dispatchRequestId } = {}) {
  return {
    evidenceRef: PIPELINE_ID_RE.test(String(pipelineId ?? '')) && Number.isSafeInteger(attempt)
      ? attemptReference(pipelineId, attempt) : null,
    leaseRef: leaseReference(leaseId),
    dispatchRequestId: exactRequestId(dispatchRequestId),
  };
}

module.exports = {
  SCHEMA,
  REQUEST_ID_RE,
  attemptLogReference,
  exactRequestId,
  leaseReference,
  taskEvidenceReferences,
};
