const { taskNextAction } = require('../../src/services/pipelineNextAction');
const now = new Date('2026-09-27T12:00:00Z');
const read = (task, options = {}) => taskNextAction({ pipelineId: '0950', service: 'core', ...task }, { now, ...options });

test.each([null, 'invalid', '2026-09-27T13:00:00Z', '2026-09-26T00:00:00Z'])(
  'missing/invalid/future/old heartbeat %s never proves worker death or authorizes replay', heartbeatAt => {
    const next = read({ status: 'in_progress', assignee: 'worker', heartbeatAt, updatedAt: now });
    expect(next).toMatchObject({ code: 'inspect_worker', actor: 'human', authorization: 'not_granted', attention: true });
    expect(next.action).not.toMatch(/re-queue|restart|retry/i);
    expect(next.detail).toContain('does not prove');
  });
test('recent heartbeat is recorded activity only; absence of owner stays distinct', () => {
  expect(read({ status: 'in_progress', assignee: 'worker', heartbeatAt: now })).toMatchObject({ code: 'observe_progress', heartbeatFreshness: 'fresh' });
  expect(read({ status: 'in_progress', heartbeatAt: now })).toMatchObject({ code: 'inspect_owner', actor: 'human' });
});
test('an expired automation lease asks for inspection even with a recent heartbeat', () => {
  const task = { status: 'in_progress', assignee: 'worker', heartbeatAt: now };
  const expired = read({ ...task, automationLease: { expiresAt: '2026-09-27T11:59:59Z' } });
  expect(expired).toMatchObject({ code: 'inspect_worker', actor: 'human', attention: true, authorization: 'not_granted',
    heartbeatFreshness: 'fresh' });
  expect(expired.label).toMatch(/lease expired/i);
  expect(expired.detail).toContain('does not prove');
  expect(expired.action).not.toMatch(/restart|retry/i);
  expect(read({ ...task, automationLease: { expiresAt: '2026-09-27T12:01:00Z' } })).toMatchObject({ code: 'observe_progress' });
});
test('only the current completed review attempt establishes receipt presence', () => {
  const old = { attempt: 1, completedAt: now, finalState: 'review', evidence: { schema: 'receipt/v1', privatePayload: 'synthetic-secret' } };
  const current = { attempt: 2, finalState: 'active' };
  expect(read({ status: 'review', automationAttempts: [old, current] })).toMatchObject({ receiptPresent: false, code: 'human_review' });
  const next = read({ status: 'review', automationAttempts: [old] });
  expect(next).toMatchObject({ receiptPresent: true, actor: 'human', diagnostics: [] });
  expect(JSON.stringify(next)).not.toContain('synthetic-secret');
});
test('verification failure remains separate from worker failure and never authorizes retry', () => {
  const next = read({ status: 'blocked', automationAttempts: [{ attempt: 1, evidence: {
    failureCodes: ['independent_verification_failed'], privatePayload: 'synthetic-secret' } }] });
  expect(next.diagnostics[0]).toMatchObject({ category: 'verification', nextAction: 'inspect_verification_report' });
  expect(next.authorization).toBe('not_granted');
  expect(JSON.stringify(next)).not.toContain('synthetic-secret');
  expect(read({ status: 'blocked' }).detail).toContain('no structured evidence');
});
test('dependency and not-before decisions use the claim predicates without dependency content', () => {
  const task = { status: 'queued', dependsOn: ['0951'] };
  expect(read(task)).toMatchObject({ code: 'inspect_dependencies' });
  expect(read(task, { dependencyStatuses: new Map([['0951', 'done']]) })).toMatchObject({ code: 'await_claim' });
  expect(read({ ...task, notBefore: '2026-09-28' })).toMatchObject({ code: 'wait_not_before' });
  expect(JSON.stringify(read(task))).not.toContain('0951');
});
test('private lanes and closed records are not worker execution signals', () => {
  expect(read({ status: 'queued', service: ' Family ' })).toMatchObject({ code: 'human_lane', actor: 'human' });
  expect(read({ status: 'queued', source: 'household-request' })).toMatchObject({ code: 'human_lane' });
  expect(read({ status: 'done', dueAt: '2026-01-01' })).toMatchObject({ code: 'none', attention: false });
  expect(read({ status: 'queued', dueAt: '2026-01-01' })).toMatchObject({ code: 'review_due_date' });
  expect(read({ status: 'new-future-state' })).toMatchObject({ code: 'inspect_state' });
});
