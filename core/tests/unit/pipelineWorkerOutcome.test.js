'use strict';
const outcome = require('../../../shared/pipelineWorkerOutcome');
const { taskNextAction } = require('../../src/services/pipelineNextAction');
const now = Date.parse('2026-10-01T12:00:00Z');
const observation = { schema: outcome.SCHEMA, requestId: '11111111-2222-4333-8444-555555555555', pipelineId: '0700',
  claimSeq: 2, result: 'blocked', reason: 'no_useful_progress', source: 'worker_report', startedAt: '2026-10-01T11:15:00Z',
  finishedAt: '2026-10-01T12:00:00Z', usage: { workSeconds: 2700, modelCalls: 20 } };
const task = { pipelineId: '0700', service: 'core', status: 'blocked', assignee: 'coding-team',
  transitions: [{ kind: 'claimed', seq: 2, at: observation.startedAt }], feedback: [{ by: 'coding-team', text: 'Raw diagnostic', workerOutcome: observation }] };
const control = () => ({ available: true, observedAt: new Date(now).toISOString(), busy: false,
  run: { requestId: observation.requestId, pipelineId: '0700', phase: 'finished', progress: {
    ...observation, phase: 'finished', stopReason: observation.reason, activityAt: observation.finishedAt } } });

test('reported stop is a bounded explanation, never permission or release evidence', () => {
  const next = taskNextAction(task);
  expect(next).toMatchObject({ code: 'inspect_blocker', authorization: 'not_granted', attention: true,
    label: 'Stopped without saved progress' });
  expect(next.detail).toContain('45 min · 20 model calls');
  const normalized = outcome.normalize({ ...observation, runtimeReleased: true, command: 'private',
    usage: { ...observation.usage, secret: 'private' } }, '0700');
  expect(normalized).toEqual({ ...observation, startedAt: '2026-10-01T11:15:00.000Z', finishedAt: '2026-10-01T12:00:00.000Z' });
  expect(outcome.canResume(task, null, now)).toBe(false);
  expect(outcome.canResume(task, control(), now)).toBe(true);
});

test.each([
  c => { c.available = false; }, c => { c.busy = true; },
  c => { c.observedAt = '2026-10-01T11:50:00Z'; }, c => { c.observedAt = '2026-10-01T12:01:00Z'; },
  c => { c.run.phase = 'unknown'; }, c => { c.run.pipelineId = '0701'; },
  c => { c.run.progress.requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; },
  c => { c.run.progress.stopReason = 'model_termination_unverified'; },
  c => { c.run.requestId = c.run.progress.requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; },
])('unknown, busy, stale, mismatched or uncertain native status cannot expose resume', mutate => {
  const c = control(); mutate(c); expect(outcome.canResume(task, c, now)).toBe(false);
});

test('a new claim and archived autonomy retain their existing barriers', () => {
  const newer = { ...task, transitions: [{ kind: 'claimed', seq: 5, at: '2026-10-01T11:16:00Z' }] };
  expect(outcome.latest(newer)).toBeNull();
  expect(outcome.canResume(newer, control(), now)).toBe(false);
  const qualified = { ...task, codingAutonomy: { disposition: { kind: 'qualification', outcome: 'abandoned' } } };
  expect(outcome.canResume(qualified, control(), now)).toBe(false);
  expect(taskNextAction(qualified).code).toBe('qualification_archived');
  expect(outcome.canResume({ ...task, automationAttemptCount: 1 }, control(), now)).toBe(false);
  expect(outcome.canResume({ ...task, automationLease: { leaseId: 'retained' } }, control(), now)).toBe(false);
});

test('contradictory or uncertain canonical observations remain an inspection decision', () => {
  for (const reason of ['model_termination_unverified', 'runner_error', 'no_changes']) {
    const changed = { ...task, feedback: [{ workerOutcome: { ...observation, reason } }] };
    expect(outcome.canResume(changed, control(), now)).toBe(false);
  }
});

function reconciledReport() {
  const observed = { ...observation, reason: 'runner_error' }, sourceCommit = 'a'.repeat(40);
  const report = { schema: 'agentx.pipeline-report-result/v1', requestId: observed.requestId, claimSeq: 2,
    kind: 'blocked', reason: 'runner_error', reportName: 'REVIEW.md', sourceCommit,
    partial: { deliverableId: 'b'.repeat(24), sha256: 'c'.repeat(64), size: 100 } };
  const ticket = { ...task, feedback: [{ workerOutcome: observed, reportOutcome: report }],
    reportBudget: { latest: { requestId: observed.requestId, state: 'blocked', sourceCommit } } };
  const c = control(); Object.assign(c.run, { reportName: report.reportName });
  Object.assign(c.run.progress, { stopReason: 'runner_error', checkpoint: sourceCommit, coreRecorded: true });
  return { ticket, c };
}
test('a Core-recorded partial report exposes resume after reconciliation without rewriting runner_error', () => {
  const { ticket, c } = reconciledReport();
  expect(outcome.canResume(ticket, c, now)).toBe(true);
  expect(outcome.latest(ticket).reason).toBe('runner_error');
  expect(outcome.canResume({ ...ticket, reportBudget: undefined }, c, now)).toBe(false);
});
test.each([
  (t, c) => { c.run.progress.coreRecorded = false; },
  (t, c) => { c.run.progress.checkpoint = 'd'.repeat(40); },
  (t, c) => { c.run.reportName = 'OTHER.md'; },
  t => { t.reportBudget.latest.state = 'active'; },
  t => { t.reportBudget.latest.requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; },
  t => { t.feedback[0].reportOutcome.claimSeq = 1; },
  t => { t.feedback[0].reportOutcome.partial.sha256 = 'invalid'; },
  t => { delete t.feedback[0].reportOutcome.partial; },
  (t, c) => { t.feedback[0].workerOutcome.reason = c.run.progress.stopReason = 'model_termination_unverified'; },
  (t, c) => { c.run.phase = 'unknown'; },
])('uncertain or mismatched report evidence keeps the inspection barrier', mutate => {
  const { ticket, c } = reconciledReport(); mutate(ticket, c);
  expect(outcome.canResume(ticket, c, now)).toBe(false);
});

test.each([{ reason: 'invented' }, { reason: 'constructor' }, { reason: '__proto__' }, { reason: 'toString' }, { claimSeq: 0 }, { requestId: 'wrong' }, { pipelineId: '0701' },
  { finishedAt: '2026-09-01' }, { usage: { workSeconds: -1, modelCalls: 20 } }])('malformed observation %j cannot explain a task', override => {
  expect(() => outcome.normalize({ ...observation, ...override }, '0700')).toThrow();
  expect(outcome.latest({ ...task, feedback: [{ workerOutcome: { ...observation, ...override } }] })).toBeNull();
});
