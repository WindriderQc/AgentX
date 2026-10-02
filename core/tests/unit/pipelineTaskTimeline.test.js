const { taskTimeline, taskSummaryWithTimeline } = require('../../src/services/pipelineTaskTimeline');

test('does not infer completion from a done record or free-form feedback', () => {
  const task = { status: 'done', createdAt: '2026-09-01', updatedAt: '2026-09-10', feedback: [{ at: '2026-09-02', text: 'done deployed' }] };
  expect(taskTimeline(task).map(event => event.kind)).toEqual(['created', 'updated']);
});

test('projects recorded attempts and decisions without exposing attempt payloads', () => {
  const task = { pipelineId: '1001', createdAt: '2026-09-01', automationAttempts: [{
    attempt: 2, acquiredAt: '2026-09-03', completedAt: '2026-09-04', finalState: 'review',
    reviewedAt: '2026-09-05', reviewOutcome: 'accepted', evidence: { privatePayload: 'must not leave summary' }
  }] };
  const summary = taskSummaryWithTimeline(task);
  expect(summary.automationAttempts).toBeUndefined();
  expect(JSON.stringify(summary)).not.toContain('privatePayload');
  expect(summary.timeline.map(event => event.kind)).toEqual(['created', 'started', 'completed', 'reviewed']);
  expect(summary.timeline.at(-1)).toMatchObject({ at: '2026-09-05T00:00:00.000Z', label: 'Human decision: accepted', attempt: 2 });
});

test('unknown dates remain absent and supersession remains a separate closure', () => {
  expect(taskTimeline({ createdAt: 'bad', updatedAt: null, status: 'done' })).toEqual([]);
  expect(taskTimeline({ resolution: { kind: 'superseded', at: '2026-09-05' } })).toEqual([
    { at: '2026-09-05T00:00:00.000Z', kind: 'superseded', label: 'Closed by supersession' }
  ]);
});

test('projects recorded transitions as typed rows and states log coverage', () => {
  const { buildTransition } = require('../../src/services/pipelineTaskTransitions');
  const created = buildTransition({ pipelineId: '1002' }, { to: 'queued', kind: 'created', channel: 'task_create', at: new Date('2026-09-01') });
  const claimed = buildTransition({ pipelineId: '1002', status: 'queued', transitionSeq: 1 }, {
    to: 'in_progress', kind: 'claimed', channel: 'automation_lease', declaredActor: '  worker-a  ',
    attempt: 1, leaseId: 'secret-lease-id', dispatchRequestId: 'not-a-uuid', reason: 'x'.repeat(900), at: new Date('2026-09-02'),
  });
  const task = { pipelineId: '1002', status: 'in_progress', createdAt: '2026-09-01', transitions: [created, claimed], transitionSeq: 2 };
  const summary = taskSummaryWithTimeline(task);
  expect(summary.transitions).toBeUndefined();
  expect(summary.transitionLog).toMatchObject({ coverage: 'complete', retained: 2, firstSeq: 1, lastSeq: 2 });
  const row = summary.timeline.filter(event => event.kind === 'transition').at(-1);
  expect(row).toMatchObject({ label: 'Status queued -> in_progress (claimed) · declared by worker-a', attempt: 1 });
  expect(row.transition.actor).toEqual({ declared: 'worker-a', authenticated: null, channel: 'automation_lease' });
  expect(row.transition.reason).toHaveLength(500);
  expect(row.transition.evidence).toMatchObject({ attemptRef: 'task-1002/attempt-1', dispatchRequestId: null });
  expect(JSON.stringify(summary)).not.toContain('secret-lease-id');
});

test('a log that does not start at creation is partial and an absent log is none', () => {
  const { transitionLog } = require('../../src/services/pipelineTaskTransitions');
  expect(transitionLog({})).toMatchObject({ coverage: 'none', retained: 0 });
  expect(transitionLog({ transitions: [{ seq: 4, at: '2026-09-03', from: 'queued', to: 'blocked', kind: 'operator_set' }] }))
    .toMatchObject({ coverage: 'partial', firstSeq: 4, since: '2026-09-03T00:00:00.000Z' });
});
