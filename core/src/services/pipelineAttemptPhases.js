'use strict';

// Phase durations of one autonomous attempt, derived only from values the
// phase owner records. Core-clock phases subtract two Core timestamps; worker
// phases come from the worker's own monotonic durations. The two clocks are
// never subtracted from each other, updatedAt is never read, and a phase with
// no recorded source stays null instead of being reconstructed.
const PHASES_SCHEMA = 'agentx.pipeline-attempt-phases/v1';
// Worker durations may exceed the Core attempt window by transport jitter only.
const CLOCK_TOLERANCE_MS = 5_000;
// Receipts of this source measure usage.durationMs over the whole post-claim
// run, independent verification included, on one monotonic clock.
const GUARDED_SOURCE = 'clawdx-guarded/v1';
const DECIDED = new Set(['accepted', 'requeued', 'rejected']);

const PHASE_DEFINITIONS = Object.freeze([
  {
    id: 'before_claim', label: 'Before claim', clock: 'core',
    measures: 'Queue entry to claim: task creation for attempt 1, else the recorded requeue decision or release of the previous attempt.',
    note: 'Includes backlog, preparation, dependencies and dispatch capacity; it is not a resource wait.',
  },
  {
    id: 'resource_wait', label: 'Resource wait', clock: null, instrumented: false,
    measures: 'Not instrumented.',
    note: 'A busy host refuses the claim, so no attempt exists; model-call admission waits are kept only for the last call of a lease.',
  },
  {
    id: 'startup', label: 'Startup', clock: null, instrumented: false,
    measures: 'Not instrumented.',
    note: 'Claim to worker start is not recorded, and Core and worker clocks are not subtracted from each other.',
  },
  {
    id: 'worker', label: 'Worker run', clock: 'worker',
    measures: `Worker run minus independent verification (${GUARDED_SOURCE} receipts).`,
    note: 'Model inference and tool execution together; inference alone is not separable.',
  },
  {
    id: 'verification', label: 'Verification', clock: 'worker',
    measures: 'Independent verification duration recorded by the worker.',
    note: 'Measured on the worker clock.',
  },
  {
    id: 'decision', label: 'Human decision', clock: 'core',
    measures: 'Attempt end to the recorded human decision.',
    note: 'Only accepted, requeued or rejected decisions with a recorded time count.',
  },
].map((definition) => Object.freeze({ instrumented: true, ...definition })));
const PHASE_IDS = PHASE_DEFINITIONS.map((definition) => definition.id);

function instant(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.getTime() : null;
}

function duration(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

const observed = (durationMs) => ({ status: 'observed', durationMs });
const unknown = (status, reason) => ({ status, durationMs: null, reason });

function coreSpan(start, end, missingReason) {
  if (start == null || end == null) return unknown('missing', missingReason);
  if (end < start) return unknown('inconsistent', 'end_before_start');
  return observed(end - start);
}

function queueEntry(task, attempt) {
  const number = Number(attempt.attempt);
  if (number === 1) return instant(task.createdAt);
  const previous = (task.automationAttempts || []).filter((item) => Number(item?.attempt) === number - 1);
  if (previous.length !== 1) return null;
  if (previous[0].reviewOutcome === 'requeued') return instant(previous[0].reviewedAt);
  if (previous[0].finalState === 'released') return instant(previous[0].completedAt);
  return null;
}

function decisionPhase(attempt, acquiredAt, completedAt) {
  const finalState = attempt.finalState || 'active';
  if (!DECIDED.has(attempt.reviewOutcome)) {
    if (['active', 'review', 'blocked'].includes(finalState)) return unknown('pending', 'no_decision_yet');
    if (finalState === 'done') return unknown('missing', 'decision_time_not_recorded');
    return unknown('not_applicable', 'no_decision_expected');
  }
  if (acquiredAt != null && completedAt != null && completedAt < acquiredAt) {
    return unknown('inconsistent', 'attempt_end_before_start');
  }
  return coreSpan(completedAt, instant(attempt.reviewedAt), 'decision_time_not_recorded');
}

function workerPhases(attempt, acquiredAt, completedAt) {
  if ((attempt.finalState || 'active') === 'active') {
    const pending = unknown('pending', 'attempt_active');
    return { worker: pending, verification: pending };
  }
  const evidence = attempt.evidence;
  if (!evidence) {
    const missing = unknown('missing', 'no_receipt');
    return { worker: missing, verification: missing };
  }
  const run = duration(evidence.usage?.durationMs);
  const check = duration(evidence.verification?.durationMs);
  const verificationRan = ['passed', 'failed'].includes(evidence.verification?.status);
  const wall = acquiredAt != null && completedAt != null && completedAt >= acquiredAt
    ? completedAt - acquiredAt : null;
  if (run != null && wall != null && run > wall + CLOCK_TOLERANCE_MS) {
    const skew = unknown('inconsistent', 'worker_duration_exceeds_core_attempt');
    return { worker: skew, verification: check == null ? unknown('missing', 'not_recorded') : skew };
  }
  if (run != null && check != null && check > run) {
    const skew = unknown('inconsistent', 'verification_exceeds_worker_run');
    return { worker: skew, verification: skew };
  }
  const verification = check != null ? observed(check) : unknown('missing', 'not_recorded');
  let worker;
  if (evidence.source !== GUARDED_SOURCE) worker = unknown('missing', 'receipt_source_semantics_unknown');
  else if (run == null) worker = unknown('missing', 'not_recorded');
  else if (check != null) worker = observed(run - check);
  else if (!verificationRan) worker = observed(run);
  else worker = unknown('missing', 'verification_duration_not_recorded');
  return { worker, verification };
}

function attemptPhases(task, attempt) {
  const acquiredAt = instant(attempt.acquiredAt);
  const completedAt = instant(attempt.completedAt);
  const notInstrumented = unknown('not_instrumented', 'not_instrumented');
  return {
    before_claim: coreSpan(queueEntry(task, attempt), acquiredAt, 'queue_entry_not_recorded'),
    resource_wait: notInstrumented,
    startup: notInstrumented,
    ...workerPhases(attempt, acquiredAt, completedAt),
    decision: decisionPhase(attempt, acquiredAt, completedAt),
  };
}

function percentile(sorted, fraction) {
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}

function summarizePhases(rows) {
  const phases = PHASE_DEFINITIONS.map((definition) => {
    const counts = { observed: 0, pending: 0, missing: 0, inconsistent: 0, not_applicable: 0, not_instrumented: 0 };
    const values = [];
    for (const row of rows) {
      const phase = row.phases[definition.id];
      counts[phase.status] += 1;
      if (phase.status === 'observed') values.push(phase.durationMs);
    }
    values.sort((left, right) => left - right);
    return {
      ...definition,
      coverage: { ...counts, total: rows.length },
      durationMs: {
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        min: values.length ? values[0] : null,
        max: values.length ? values[values.length - 1] : null,
      },
    };
  });
  return {
    schema: PHASES_SCHEMA,
    clockToleranceMs: CLOCK_TOLERANCE_MS,
    inconsistentAttempts: rows.filter((row) => PHASE_IDS.some((id) => row.phases[id].status === 'inconsistent')).length,
    semantics: 'Each phase aggregates only its observed attempts; pending, missing, inconsistent and not instrumented phases stay null and are counted in coverage.',
    phases,
  };
}

module.exports = {
  PHASES_SCHEMA,
  PHASE_DEFINITIONS,
  CLOCK_TOLERANCE_MS,
  attemptPhases,
  summarizePhases,
};
