'use strict';

const {
  PHASES_SCHEMA,
  PHASE_DEFINITIONS,
  attemptPhases,
  resourceWaitKey,
  summarizePhases,
} = require('../../src/services/pipelineAttemptPhases');
const { buildPipelineAutomationPerformance } = require('../../src/services/pipelineAutomationPerformanceService');

const GUARDED = 'clawdx-guarded/v1';
const at = (minutes) => new Date(Date.UTC(2026, 8, 20, 10, 0, 0) + minutes * 60_000).toISOString();
const receipt = (usageMs, verificationMs, status = 'passed', source = GUARDED) => ({
  source,
  verification: { status, durationMs: verificationMs },
  usage: { durationMs: usageMs },
});

describe('pipeline attempt phases', () => {
  test('splits an accepted attempt into Core-clock and worker-clock phases', () => {
    const task = { createdAt: at(0), updatedAt: at(500), automationAttempts: [] };
    const attempt = {
      attempt: 1, acquiredAt: at(30), completedAt: at(45), reviewedAt: at(105),
      finalState: 'review', reviewOutcome: 'accepted', evidence: receipt(840_000, 120_000),
    };
    task.automationAttempts.push(attempt);
    task.pipelineId = '0700';
    const resourceWaits = new Map([[resourceWaitKey('0700', 1), { calls: 4, measuredCalls: 4, waitMs: 2_500 }]]);
    expect(attemptPhases(task, attempt, { resourceWaits })).toEqual({
      before_claim: { status: 'observed', durationMs: 30 * 60_000 },
      resource_wait: { status: 'observed', durationMs: 2_500 },
      startup: { status: 'not_instrumented', durationMs: null, reason: 'not_instrumented' },
      worker: { status: 'observed', durationMs: 720_000 },
      verification: { status: 'observed', durationMs: 120_000 },
      decision: { status: 'observed', durationMs: 60 * 60_000 },
    });
  });

  test('never reconstructs a phase from updatedAt or an unrecorded queue entry', () => {
    const task = {
      createdAt: null,
      updatedAt: at(10),
      automationAttempts: [
        { attempt: 1, acquiredAt: at(20), completedAt: at(30), finalState: 'blocked', reviewOutcome: 'pending' },
        { attempt: 2, acquiredAt: at(40), completedAt: at(50), finalState: 'done', reviewOutcome: 'pending',
          evidence: { source: GUARDED, verification: { status: 'passed', durationMs: null }, usage: { durationMs: 300_000 } } },
      ],
    };
    const [first, second] = task.automationAttempts;
    const one = attemptPhases(task, first);
    const two = attemptPhases(task, second);
    expect(one.before_claim).toEqual({ status: 'missing', durationMs: null, reason: 'queue_entry_not_recorded' });
    expect(one.worker).toMatchObject({ status: 'missing', reason: 'no_receipt' });
    expect(one.decision).toMatchObject({ status: 'pending', durationMs: null });
    // Attempt 1 was blocked, never recorded as requeued: attempt 2's queue entry is unknown.
    expect(two.before_claim).toMatchObject({ status: 'missing', durationMs: null });
    // Verification ran, but its duration is absent, so the worker share is unknown too.
    expect(two.worker).toMatchObject({ status: 'missing', reason: 'verification_duration_not_recorded' });
    expect(two.verification).toMatchObject({ status: 'missing', durationMs: null });
    // A legacy "done" without a recorded decision time stays unknown.
    expect(two.decision).toMatchObject({ status: 'missing', reason: 'decision_time_not_recorded' });
  });

  test('reports a resource wait only when every model call of the attempt measured it', () => {
    const task = { pipelineId: '0711', createdAt: at(0), automationAttempts: [] };
    const done = (attempt) => ({ attempt, acquiredAt: at(1), completedAt: at(20), finalState: 'blocked' });
    const resourceWaits = new Map([
      [resourceWaitKey('0711', 1), { calls: 3, measuredCalls: 3, waitMs: 0 }],
      [resourceWaitKey('0711', 2), { calls: 3, measuredCalls: 2, waitMs: 900 }],
    ]);
    const phase = (attempt, options) => attemptPhases(task, attempt, options).resource_wait;
    expect(phase(done(1), { resourceWaits })).toEqual({ status: 'observed', durationMs: 0 });
    expect(phase(done(2), { resourceWaits })).toMatchObject({ status: 'missing', durationMs: null, reason: 'wait_not_recorded' });
    expect(phase(done(3), { resourceWaits })).toMatchObject({ status: 'missing', reason: 'no_attributed_model_calls' });
    expect(phase(done(1))).toMatchObject({ status: 'missing', reason: 'inference_waits_not_read' });
    expect(phase({ ...done(1), finalState: 'active' }, { resourceWaits })).toMatchObject({ status: 'pending', reason: 'attempt_active' });
  });

  test('uses the recorded requeue decision or release as the next queue entry', () => {
    const task = {
      createdAt: at(0),
      automationAttempts: [
        { attempt: 1, acquiredAt: at(5), completedAt: at(15), reviewedAt: at(25), finalState: 'review', reviewOutcome: 'requeued' },
        { attempt: 2, acquiredAt: at(40), completedAt: at(45), finalState: 'released' },
        { attempt: 3, acquiredAt: at(47), finalState: 'active' },
      ],
    };
    const [, second, third] = task.automationAttempts;
    expect(attemptPhases(task, second).before_claim).toEqual({ status: 'observed', durationMs: 15 * 60_000 });
    expect(attemptPhases(task, third).before_claim).toEqual({ status: 'observed', durationMs: 2 * 60_000 });
    expect(attemptPhases(task, second).decision).toMatchObject({ status: 'not_applicable', durationMs: null });
    expect(attemptPhases(task, third).worker).toMatchObject({ status: 'pending', durationMs: null });
  });

  test('flags incoherent clocks instead of reporting a duration', () => {
    const task = { createdAt: at(60), automationAttempts: [] };
    const beforeCreation = { attempt: 1, acquiredAt: at(0), completedAt: at(2), reviewedAt: at(1),
      finalState: 'review', reviewOutcome: 'rejected', evidence: receipt(3_600_000, 1_000) };
    const verificationTooLong = { attempt: 1, acquiredAt: at(100), completedAt: at(160), finalState: 'blocked',
      evidence: receipt(60_000, 90_000, 'failed') };
    const reversedAttempt = { attempt: 1, acquiredAt: at(10), completedAt: at(5), reviewedAt: at(20),
      finalState: 'review', reviewOutcome: 'accepted', evidence: receipt(1_000, 500) };

    const first = attemptPhases(task, beforeCreation);
    expect(first.before_claim).toMatchObject({ status: 'inconsistent', durationMs: null, reason: 'end_before_start' });
    expect(first.worker).toMatchObject({ status: 'inconsistent', reason: 'worker_duration_exceeds_core_attempt' });
    expect(first.verification).toMatchObject({ status: 'inconsistent', durationMs: null });
    expect(first.decision).toMatchObject({ status: 'inconsistent', reason: 'end_before_start' });

    const second = attemptPhases(task, verificationTooLong);
    expect(second.worker).toMatchObject({ status: 'inconsistent', reason: 'verification_exceeds_worker_run' });
    expect(second.verification).toMatchObject({ status: 'inconsistent' });

    const third = attemptPhases(task, reversedAttempt);
    expect(third.decision).toMatchObject({ status: 'inconsistent', reason: 'attempt_end_before_start' });
  });

  test('keeps the worker share unknown for receipts with other duration semantics', () => {
    const task = { createdAt: at(0), automationAttempts: [] };
    const attempt = { attempt: 1, acquiredAt: at(1), completedAt: at(20), finalState: 'blocked',
      evidence: receipt(600_000, 60_000, 'failed', 'other-worker/v1') };
    const phases = attemptPhases(task, attempt);
    expect(phases.worker).toMatchObject({ status: 'missing', reason: 'receipt_source_semantics_unknown' });
    expect(phases.verification).toEqual({ status: 'observed', durationMs: 60_000 });
  });

  test('uses the whole guarded run as worker time when verification never ran', () => {
    const task = { createdAt: at(0), automationAttempts: [] };
    const attempt = { attempt: 1, acquiredAt: at(1), completedAt: at(20), finalState: 'blocked',
      evidence: receipt(600_000, null, 'unknown') };
    const phases = attemptPhases(task, attempt);
    expect(phases.worker).toEqual({ status: 'observed', durationMs: 600_000 });
    expect(phases.verification).toMatchObject({ status: 'missing', durationMs: null });
  });

  test('bounded aggregates carry coverage and only observed values', () => {
    const rows = [
      { phases: { before_claim: { status: 'observed', durationMs: 1_000 }, resource_wait: { status: 'observed', durationMs: 40 },
        startup: { status: 'not_instrumented' }, worker: { status: 'observed', durationMs: 50 },
        verification: { status: 'observed', durationMs: 10 }, decision: { status: 'pending' } } },
      { phases: { before_claim: { status: 'observed', durationMs: 3_000 }, resource_wait: { status: 'missing' },
        startup: { status: 'not_instrumented' }, worker: { status: 'inconsistent' },
        verification: { status: 'inconsistent' }, decision: { status: 'observed', durationMs: 7 } } },
      { phases: { before_claim: { status: 'missing' }, resource_wait: { status: 'pending' },
        startup: { status: 'not_instrumented' }, worker: { status: 'missing' },
        verification: { status: 'missing' }, decision: { status: 'not_applicable' } } },
    ];
    const summary = summarizePhases(rows);
    expect(summary.schema).toBe(PHASES_SCHEMA);
    expect(summary.inconsistentAttempts).toBe(1);
    expect(summary.phases.map((phase) => phase.id)).toEqual(PHASE_DEFINITIONS.map((definition) => definition.id));
    const byId = Object.fromEntries(summary.phases.map((phase) => [phase.id, phase]));
    expect(byId.before_claim.durationMs).toEqual({ p50: 1_000, p95: 3_000, min: 1_000, max: 3_000 });
    expect(byId.before_claim.coverage).toMatchObject({ observed: 2, missing: 1, total: 3 });
    expect(byId.resource_wait).toMatchObject({ instrumented: true, clock: 'core',
      durationMs: { p50: 40, p95: 40, min: 40, max: 40 } });
    expect(byId.resource_wait.coverage).toMatchObject({ observed: 1, missing: 1, pending: 1, total: 3 });
    expect(byId.startup).toMatchObject({ instrumented: false, clock: null,
      durationMs: { p50: null, p95: null, min: null, max: null } });
    expect(byId.startup.coverage).toMatchObject({ observed: 0, not_instrumented: 3, total: 3 });
    expect(byId.worker.coverage).toMatchObject({ observed: 1, inconsistent: 1, missing: 1 });
    expect(byId.decision.coverage).toMatchObject({ observed: 1, pending: 1, not_applicable: 1 });
    for (const phase of summary.phases) {
      const { total, ...counts } = phase.coverage;
      expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(total);
      const { p50, p95, min, max } = phase.durationMs;
      if (p50 != null) expect(min <= p50 && p50 <= p95 && p95 <= max).toBe(true);
    }
  });

  test('the performance projection attaches phases to every attempt and an aggregate with coverage', () => {
    const performance = buildPipelineAutomationPerformance([{
      pipelineId: '0710',
      createdAt: '2026-09-20T09:00:00.000Z',
      updatedAt: '2026-09-25T09:00:00.000Z',
      automationAttempts: [{
        attempt: 1, acquiredAt: '2026-09-20T10:00:00.000Z', completedAt: '2026-09-20T10:20:00.000Z',
        finalState: 'review', reviewOutcome: 'pending', evidence: receipt(1_100_000, 100_000),
      }],
    }], { now: '2026-09-27T00:00:00.000Z', windowDays: 30,
      resourceWaits: new Map([[resourceWaitKey('0710', 1), { calls: 2, measuredCalls: 2, waitMs: 1_234 }]]) });
    expect(performance.attempts[0].phases.worker).toEqual({ status: 'observed', durationMs: 1_000_000 });
    expect(performance.attempts[0].phases.resource_wait).toEqual({ status: 'observed', durationMs: 1_234 });
    expect(performance.attempts[0].phases.decision).toMatchObject({ status: 'pending', durationMs: null });
    const decision = performance.phaseDurations.phases.find((phase) => phase.id === 'decision');
    expect(decision.coverage).toMatchObject({ observed: 0, pending: 1, total: 1 });
    expect(decision.durationMs.p50).toBeNull();
    expect(performance.phaseDurations.phases.find((phase) => phase.id === 'before_claim').durationMs.p50).toBe(3_600_000);
  });
});
