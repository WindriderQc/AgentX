'use strict';
const { buildTransition, recordTransition } = require('./pipelineTaskTransitions');

// Route-specific wiring: each helper decides whether the pending update changes
// the status and, if so, adds the typed event and the status/sequence guard to
// the same query and update. They return the event, or null when the status
// does not change (no event is written for a no-op status).

function attemptFields(record) {
  if (!record) return {};
  return {
    attempt: Number(record.attempt),
    leaseId: record.leaseId,
    dispatchRequestId: record.dispatchRequestId,
  };
}

function statusKind({ status, current, body, reviewOutcome }) {
  if (current.resolution?.kind === 'superseded' && status !== 'done' && body.reopen === true) return 'reopened';
  if (reviewOutcome === 'accepted') return 'review_accepted';
  if (reviewOutcome === 'rejected') return 'review_rejected';
  if (status === 'queued') return 'requeued';
  return 'operator_set';
}

// POST /tasks/:id/status
function statusTransition(query, update, current, { status, body = {}, reviewOutcome = null, latestAttempt = null, workerLease = null }) {
  if (status === current.status) return null;
  const lease = current.automationLease?.leaseId && status !== 'in_progress' ? current.automationLease : null;
  const event = buildTransition(current, {
    to: status,
    kind: statusKind({ status, current, body, reviewOutcome }),
    // A caller naming the active lease passed Core's lease check; others are operator calls.
    channel: workerLease ? 'automation_lease' : 'operator_api',
    declaredActor: typeof body.by === 'string' ? body.by : null,
    reason: typeof body.reason === 'string' ? body.reason : null,
    ...attemptFields(lease || (reviewOutcome ? latestAttempt : null)),
  });
  recordTransition(query, update, current, event);
  return event;
}

function verdictReason(requested, to, evidence) {
  const codes = Array.isArray(evidence?.failureCodes) ? evidence.failureCodes : [];
  if (requested === 'done' && to === 'blocked') {
    const gate = codes.find((code) => String(code).startsWith('cost_'));
    return `Core cost gate: ${gate || 'unknown'}`;
  }
  if (to === 'blocked' && codes.length) return `Failure codes: ${codes.join(', ')}`;
  return null;
}

// POST /tasks/:id/feedback with a worker verdict.
function feedbackTransition(query, update, current, { entry, lease = null, requested = null, evidence = null }) {
  const to = update.$set?.status;
  if (!to || to === current.status) return null;
  const event = buildTransition(current, {
    to,
    kind: 'worker_verdict',
    channel: lease ? 'automation_lease' : 'worker_api',
    declaredActor: entry?.by,
    reason: verdictReason(requested, to, evidence),
    at: entry?.at,
    ...(lease ? attemptFields({ ...current.automationLease, attempt: lease.attempt }) : {}),
  });
  recordTransition(query, update, current, event);
  return event;
}

// POST /tasks/:id/supersede (confirmed).
function supersedeTransition(query, update, current, resolution) {
  const event = buildTransition(current, {
    to: 'done',
    kind: 'superseded',
    channel: 'operator_api',
    declaredActor: resolution.by,
    reason: resolution.reason,
    supersededBy: resolution.supersededBy,
    at: resolution.at,
  });
  recordTransition(query, update, current, event);
  return event;
}

// pipelineTaskPreparationService.apply: queued/blocked -> queued/blocked.
function preparationTransition(query, update, current, { question = false, at = new Date() } = {}) {
  const to = update.$set?.status;
  if (!to || to === current.status) return null;
  const event = buildTransition(current, {
    to,
    kind: question ? 'prepared' : 'requeued',
    channel: 'task_preparation',
    reason: question ? 'Coding team asked the operator a question' : 'Prepared task returned to the queue',
    at,
  });
  recordTransition(query, update, current, event);
  return event;
}

module.exports = { statusTransition, feedbackTransition, supersedeTransition, preparationTransition };
