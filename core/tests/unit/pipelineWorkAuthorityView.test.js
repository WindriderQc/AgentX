'use strict';
const { view } = require('../../src/services/pipelineWorkAuthorityView');
const policy = require('../../src/services/pipelineCodingAutonomyPolicy');
const { normalizePipelineAutomationIntent } = require('../../../shared/pipelineAutomationContract');
function task() {
  const record = { pipelineId: '0991', service: 'agentx-coding', title: 'Synthetic change', spec: 'Public synthetic outcome', risk: 'low',
    assignee: 'declared-agent', automation: normalizePipelineAutomationIntent({ schema: 'agentx.pipeline-automation/v1',
      mode: 'review_only', policyRef: 'agentx.coding-autonomy/v1', dataClassification: 'public', operations: ['update'],
      scope: ['src/one.js'], sourceFiles: ['src/one.js'], lockKeys: ['file:src/one.js'], executionProfile: 'coding-sandbox/v1',
      verificationProfile: 'agentx-core-runner-tests/v1', budgets: { maxDurationMs: 900000, maxAttempts: 3, maxCostNanodollars: 0 },
      humanGates: ['review', 'merge', 'deploy'] }),
    transitions: [{ kind: 'created', actor: { declared: 'requester', authenticated: 'spoofed-person', channel: 'task_create' } },
      { kind: 'review_accepted', actor: { declared: 'reviewer', authenticated: 'spoofed-parent', channel: 'operator_api' } }] };
  record.codingAutonomy = { authorized: true, revision: 3, basis: policy.basis(record), limits: policy.limits(),
    spent: { modelCalls: 2, modelSeconds: 5 }, budgetGrants: [{ budget: { modelCalls: 1 } }], runs: [{ requestId: 'original-request',
      executorId: 'native-runner', harness: 'opencode', pendingInferences: ['original-call'],
      currentUsage: { modelCalls: 1 }, modelReceipts: [] }] };
  return record;
}
test('declared roles, native executors and unknown accountability stay distinct without credentials', () => {
  const record = task(); record.automationLease = { leaseId: 'PRIVATE-LEASE' };
  record.codingCapacity = { admissionId: 'PRIVATE-ADMISSION' };
  const result = view(record);
  expect(result).toMatchObject({ identity: { authenticatedPerson: null, declaredNamesAreIdentity: false },
    roles: { requester: { declared: 'requester', authenticated: null }, accountableOwner: null,
      assignee: { declared: 'declared-agent', authenticated: null }, authorizer: { declared: null, authenticated: null },
      executor: { nativeId: 'native-runner', authenticatedPerson: null }, reviewer: { declared: 'reviewer', authenticated: null } },
    delegation: { authorized: true, currentScope: true, cumulative: { limits: { modelCalls: 129 }, settledSpent: { modelCalls: 2 }, grantCount: 1 } },
    unresolved: [{ requestId: 'original-request', callId: 'original-call' }], authorization: 'none' });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE-|spoofed-/);
});
test('revocation and edited scope block future effects without hiding unresolved identities or resetting usage', () => {
  const record = task(); const before = view(record);
  record.codingAutonomy.authorized = false;
  const revoked = view(record);
  expect(revoked.delegation).toMatchObject({ authorized: false, currentScope: false, futureEffects: 'blocked' });
  expect(revoked.unresolved).toEqual(before.unresolved);
  expect(revoked.delegation.cumulative).toEqual(before.delegation.cumulative);
  record.codingAutonomy.authorized = true; record.spec = 'Unreviewed replacement';
  expect(view(record).delegation).toMatchObject({ authorized: true, currentScope: false, futureEffects: 'blocked' });
});
test('missing evidence is not invented and private work stays with its native domain', () => {
  expect(view({ pipelineId: '0991', service: 'core', status: 'review' })).toMatchObject({
    roles: { requester: null, accountableOwner: null, authorizer: null, executor: null, reviewer: null }, delegation: null,
    review: { required: true, authenticatedSeparationOfDuties: false } });
  for (const privateRecord of [{ service: 'family' }, { service: 'personal' }, { source: 'household-parent' }, { profileId: 'private' }]) {
    expect(view(privateRecord)).toBeNull();
  }
});
