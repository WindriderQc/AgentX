'use strict';
const { leaseReference, exactRequestId } = require('./pipelineEvidenceReferences');

// Typed status-transition events written by the same single-document update
// that changes the status. MongoDB applies one findOneAndUpdate atomically, so
// the status and its event cannot diverge after a crash, and no replica-set
// transaction is needed. Events are appended only by live mutations: nothing
// here reconstructs history from feedback text, timestamps or attempts.
const SCHEMA = 'agentx.pipeline-task-transition/v1';
const MAX_TRANSITIONS = 50;
const TIMELINE_TRANSITIONS = 20;
const KINDS = [
  'created', 'claimed', 'worker_verdict', 'review_accepted', 'review_rejected',
  'requeued', 'reopened', 'superseded', 'operator_set', 'prepared',
  'family_check_in', 'family_approved', 'family_rolled_over', 'family_cancelled',
  'personal_completed',
];
// Which Core path performed the write. `automation_lease` means the caller
// presented the active server-issued lease; that proves lease possession, not
// who the caller is. Core has no authenticated principal on /api/pipeline yet,
// so `actor.authenticated` is always null and `actor.declared` is only a claim.
const CHANNELS = ['task_create', 'worker_api', 'automation_lease', 'operator_api', 'task_preparation',
  'family_surface', 'personal_surface'];
const PIPELINE_ID_RE = /^\d{3,4}$/;

function bounded(value, max) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim().slice(0, max);
  return text || null;
}

function transitionConflict(message = 'Task changed before its status transition was recorded; reload it') {
  return Object.assign(new Error(message), { status: 409, code: 'TASK_TRANSITION_CONFLICT' });
}

/**
 * Build one event from the document state the caller read. `task` must be the
 * version the guarded update will match: its status becomes `from` and its
 * `transitionSeq` the expected sequence.
 */
function buildTransition(task, { to, kind, channel, declaredActor = null, attempt = null,
  leaseId = null, dispatchRequestId = null, reason = null, supersededBy = null, at = new Date() }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown transition kind: ${kind}`);
  if (!CHANNELS.includes(channel)) throw new Error(`unknown transition channel: ${channel}`);
  const pipelineId = PIPELINE_ID_RE.test(String(task?.pipelineId ?? '')) ? String(task.pipelineId) : null;
  const attemptNumber = Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : null;
  const replacement = PIPELINE_ID_RE.test(String(supersededBy ?? '')) ? String(supersededBy) : null;
  return {
    schema: SCHEMA,
    seq: expectedSeq(task) + 1,
    at,
    from: kind === 'created' ? null : (task?.status ?? null),
    to,
    kind,
    actor: { declared: bounded(declaredActor, 120), authenticated: null, channel },
    attempt: attemptNumber,
    reason: bounded(reason, 500),
    evidence: {
      taskRef: pipelineId ? `task-${pipelineId}` : null,
      attemptRef: pipelineId && attemptNumber ? `task-${pipelineId}/attempt-${attemptNumber}` : null,
      leaseRef: leaseReference(leaseId),
      dispatchRequestId: exactRequestId(dispatchRequestId),
      supersededByRef: replacement ? `task-${replacement}` : null,
    },
  };
}

function expectedSeq(task) {
  const seq = Number(task?.transitionSeq);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
}

/**
 * Add the event to an existing update and guard its query on the exact status
 * and sequence the event was built from. Another transition in between makes
 * the update match nothing, so the caller reports a conflict instead of
 * recording a wrong `from`. The retained log is capped at MAX_TRANSITIONS.
 */
function recordTransition(query, update, task, event) {
  // The caller's own guards (e.g. preflight feedback's `status: 'queued'`)
  // stay in force; the event's `from` is added beside them, never over them.
  query.$and = [
    ...(Array.isArray(query.$and) ? query.$and : []),
    { status: event.from },
    { transitionSeq: expectedSeq(task) || null }, // null also matches a document without a log
  ];
  update.$set = { ...(update.$set || {}), transitionSeq: event.seq };
  update.$push = { ...(update.$push || {}), transitions: { $each: [event], $slice: -MAX_TRANSITIONS } };
  return { query, update };
}

function initialTransition(pipelineId, { channel = 'task_create', declaredActor = null, at = new Date() } = {}) {
  const event = buildTransition({ pipelineId }, { to: 'queued', kind: 'created', channel, declaredActor, at });
  return { transitions: [event], transitionSeq: event.seq };
}

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

// Reserved for lanes with status paths that have not adopted atomic events.
const UNJOURNALED_LANES = new Set();

// Coverage is stated, never assumed: a log that does not start with the
// creation event says nothing about what happened before its first event, and
// a lane with unjournaled write paths can never claim a complete log.
function transitionLog(task = {}) {
  const events = (Array.isArray(task.transitions) ? task.transitions : [])
    .filter((event) => Number.isSafeInteger(event?.seq) && validDate(event.at));
  const lane = String(task.service || '').toLowerCase();
  const unjournaled = UNJOURNALED_LANES.has(lane) ? `lane_has_unjournaled_writes:${lane}` : null;
  if (!events.length) {
    return { schema: SCHEMA, coverage: 'none', reason: unjournaled || 'no_recorded_transitions',
      retained: 0, firstSeq: null, lastSeq: null, since: null };
  }
  const first = events[0];
  const last = events.at(-1);
  const fromCreation = first.seq === 1 && first.kind === 'created';
  return {
    schema: SCHEMA,
    coverage: fromCreation && !unjournaled ? 'complete' : 'partial',
    reason: unjournaled || (fromCreation ? null : (first.seq > 1 ? 'older_events_trimmed' : 'recorded_after_creation')),
    retained: events.length,
    firstSeq: first.seq,
    lastSeq: last.seq,
    since: validDate(first.at).toISOString(),
  };
}

function timelineLabel(event) {
  const from = event.from || 'new';
  const actor = event.actor?.declared ? ` · declared by ${event.actor.declared}` : '';
  return `Status ${from} -> ${event.to} (${String(event.kind).replace(/_/g, ' ')})${actor}`;
}

// Timeline rows for the most recent recorded transitions, in stored order.
function transitionTimelineEvents(task = {}, limit = TIMELINE_TRANSITIONS) {
  const events = (Array.isArray(task.transitions) ? task.transitions : []).slice(-limit);
  return events.flatMap((event) => {
    const at = validDate(event?.at);
    if (!at || !event.to) return [];
    return [{
      at: at.toISOString(),
      kind: 'transition',
      label: timelineLabel(event),
      ...(event.attempt ? { attempt: event.attempt } : {}),
      transition: {
        seq: event.seq ?? null,
        from: event.from ?? null,
        to: event.to,
        kind: event.kind,
        actor: {
          declared: event.actor?.declared ?? null,
          authenticated: event.actor?.authenticated ?? null,
          channel: event.actor?.channel ?? null,
        },
        reason: event.reason ?? null,
        evidence: event.evidence || null,
      },
    }];
  });
}

module.exports = {
  SCHEMA,
  MAX_TRANSITIONS,
  TIMELINE_TRANSITIONS,
  UNJOURNALED_LANES,
  KINDS,
  CHANNELS,
  buildTransition,
  recordTransition,
  initialTransition,
  transitionConflict,
  transitionLog,
  transitionTimelineEvents,
};
