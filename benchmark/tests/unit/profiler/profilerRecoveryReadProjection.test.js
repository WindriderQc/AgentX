'use strict';
const { projectRecovery, projectHostProfileForRead } = require('../../../src/services/profiler/profilerRecoveryReadProjection');
const now = new Date('2026-09-27T12:00:00Z');
const fixture = fields => ({ hostId: 'synthetic-host', displayName: 'Synthetic host', reconciliation: {
  state: 'unknown', operationId: 'operation-1', operation: 'profile_run', startedAt: new Date(now - 120000),
  serverTerminalObserved: false, ownerClaimedAt: new Date(now - 120000), pendingRequests: 1,
  admissionId: 'private-admission', admissionGeneration: 'private-generation', ownerEpoch: 'private-epoch',
  recoveryRequestId: 'private-request', releaseReceipt: { token: 'private-token' }, reason: 'private runtime path', ...fields } });

test('absence of a terminal response stays unknown despite an old writer', () => {
  expect(projectRecovery(fixture(), now)).toMatchObject({ code: 'terminal_unknown', unresolved: true, attention: true,
    serverTerminalObserved: false, authorization: 'not_granted' });
});
test.each(['prepared', 'mutating'])('a future writer timestamp does not establish a live %s operation', state => {
  expect(projectRecovery(fixture({ state, ownerClaimedAt: new Date(now.getTime() + 60000) }), now).code).toBe('terminal_unknown');
});
test('distinguishes terminal recovery, verified restoration and release', () => {
  expect(projectRecovery(fixture({ serverTerminalObserved: true }), now).code).toBe('restore_pending');
  expect(projectRecovery(fixture({ state: 'verified', serverTerminalObserved: true }), now).code).toBe('release_pending');
  expect(projectRecovery(fixture({ state: 'resolved' }), now).code).toBe('closed_unverified');
  expect(projectRecovery(fixture({ state: 'resolved', releaseReceipt: { released: true } }), now).code).toBe('released');
});
test('a recent recorded writer labels ongoing work without granting recovery authority', () => {
  expect(projectRecovery(fixture({ state: 'mutating', ownerClaimedAt: now }), now)).toMatchObject({ code: 'running', unresolved: true, attention: false, authorization: 'not_granted' });
});
test('browser host reads exclude coordination identities, opaque epochs and receipt bodies', () => {
  const source = fixture();
  const before = JSON.stringify(source);
  const publicView = projectHostProfileForRead(source);
  expect(publicView.reconciliation).toBeUndefined();
  expect(JSON.stringify(publicView)).not.toContain('private-');
  expect(JSON.stringify(source)).toBe(before);
});

test('a journal that stopped retrying asks for an operator without exposing its reason', () => {
  const view = projectRecovery(fixture({ serverTerminalObserved: true, failedAttempts: 6,
    operatorRequiredAt: now, nextAttemptAt: new Date(now.getTime() + 3600000) }), now);
  expect(view).toMatchObject({ code: 'operator_required', unresolved: true, attention: true, failedAttempts: 6, nextAttemptAt: null });
  expect(view.action).toContain('after 6 failed attempts');
  expect(JSON.stringify(view)).not.toContain('private runtime path');
});

test('a journal waiting for its next retry shows when', () => {
  const next = new Date(now.getTime() + 120000);
  expect(projectRecovery(fixture({ serverTerminalObserved: true, failedAttempts: 2, nextAttemptAt: next }), now))
    .toMatchObject({ code: 'restore_pending', failedAttempts: 2, nextAttemptAt: next.toISOString() });
});
