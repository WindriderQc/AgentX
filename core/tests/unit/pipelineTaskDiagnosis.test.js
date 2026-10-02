'use strict';

const { diagnoseTask, repairGuardQuery } = require('../../src/services/pipelineTaskDiagnosis');

const now = new Date('2026-09-27T12:00:00Z');
const ago = ms => new Date(now.getTime() - ms);
const base = overrides => ({ pipelineId: '0701', status: 'queued', service: 'core', source: 'api', assignee: null, ...overrides });

test('in progress without owner and with a future heartbeat stay unknown and escalate', () => {
  expect(diagnoseTask(base({ status: 'in_progress' }), { now, slot: null }))
    .toMatchObject({ category: 'unknown', code: 'owner_missing', escalation: { key: expect.stringMatching(/^esc-/) } });
  expect(diagnoseTask(base({ status: 'in_progress', assignee: 'w', heartbeatAt: new Date(now.getTime() + 60000) }), { now, slot: null }))
    .toMatchObject({ category: 'unknown', code: 'heartbeat_absent', worker: { heartbeat: 'future', state: 'unknown' } });
});

test('a new heartbeat episode yields a new escalation key; the same episode keeps it', () => {
  const first = base({ status: 'in_progress', assignee: 'w', heartbeatAt: ago(2 * 3600000), transitionSeq: 2 });
  const again = diagnoseTask(first, { now: new Date(now.getTime() + 600000), slot: null });
  const once = diagnoseTask(first, { now, slot: null });
  expect(again.escalation.key).toBe(once.escalation.key);
  const later = diagnoseTask({ ...first, heartbeatAt: ago(90 * 60000) }, { now, slot: null });
  expect(later.escalation.key).not.toBe(once.escalation.key);
  expect(once.escalation.since).toBe(new Date(first.heartbeatAt.getTime() + 3600000).toISOString());
});

test('review and blocked name the human and the missing receipt or failure evidence', () => {
  expect(diagnoseTask(base({ status: 'review' }), { now })).toMatchObject({ category: 'human_decision', code: 'human_review',
    missingEvidence: [expect.objectContaining({ code: 'attempt_receipt' })], escalation: null });
  const receipt = { attempt: 1, completedAt: ago(1000), finalState: 'review', evidence: { schema: 'x', failureCodes: [] } };
  expect(diagnoseTask(base({ status: 'review', automationAttempts: [receipt] }), { now }).missingEvidence).toEqual([]);
  expect(diagnoseTask(base({ status: 'blocked' }), { now }).missingEvidence.map(item => item.code)).toEqual(['failure_evidence']);
  expect(diagnoseTask(base({ status: 'done' }), { now })).toMatchObject({ category: 'closed', escalation: null });
});

test('queued dependency and admission cases', () => {
  expect(diagnoseTask(base({ dependsOn: ['0702'] }), { now, dependencies: new Map() }))
    .toMatchObject({ category: 'unknown', code: 'dependency_missing', dependencies: [{ pipelineId: '0702', status: 'missing' }] });
  const automation = { mode: 'review_only', budgets: { maxAttempts: 1, maxDurationMs: 60000, maxCostNanodollars: 0 } };
  const exhausted = diagnoseTask(base({ automation, risk: 'low', automationAttemptCount: 1 }), { now, slot: null });
  expect(exhausted.category).toBe('human_decision');
  expect(diagnoseTask(base({ service: 'personal' }), { now })).toMatchObject({ code: 'human_lane', owner: 'human' });
  // Lane before owner: a household routine is queued with its lane as assignee.
  expect(diagnoseTask(base({ service: 'family', assignee: 'household-family' }), { now, slot: null }))
    .toMatchObject({ category: 'human_decision', code: 'human_lane', scope: 'private', escalation: null });
});

test('an overdue task says so without changing its category', () => {
  const diagnosis = diagnoseTask(base({ status: 'review', dueAt: ago(86400000) }), { now });
  expect(diagnosis).toMatchObject({ category: 'human_decision', overdueSince: ago(86400000).toISOString() });
});

test('the repair guard pins status, sequence, owner, heartbeat and lease expiry', () => {
  const task = base({ status: 'in_progress', assignee: 'w', heartbeatAt: ago(1000), transitionSeq: 3, automationAttemptCount: 1,
    automationLease: { leaseId: 'L', attempt: 1, acquiredAt: ago(2000), expiresAt: ago(-5000) } });
  const { observedVersion } = diagnoseTask(task, { now, slot: { leaseId: 'L' } });
  expect(repairGuardQuery('0701', observedVersion)).toEqual({ pipelineId: '0701', status: 'in_progress', transitionSeq: 3,
    automationAttemptCount: 1, assignee: 'w', heartbeatAt: ago(1000), 'automationLease.expiresAt': ago(-5000) });
  expect(JSON.stringify(observedVersion)).not.toContain('"L"');
});
