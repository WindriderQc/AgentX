'use strict';
const intake = require('./taskIntakePolicy');
const policy = require('./pipelineCodingAutonomyPolicy');
const DIMENSIONS = ['workSeconds', 'testSeconds', 'modelSeconds', 'modelCalls', 'ciSeconds'];
const budgets = value => Object.fromEntries(DIMENSIONS.filter(key => Number.isFinite(value?.[key])).map(key => [key, value[key]]));
const timestamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const declared = event => event ? { declared: event.actor?.declared || null, authenticated: null,
  channel: event.actor?.channel || null, at: timestamp(event.at) } : null;

// A read projection, never an authorizer. Only native journals supply facts;
// names and caller headers cannot become authenticated people or new grants.
function view(task) {
  if (!intake.applicable(task)) return null;
  const transitions = task.transitions || [];
  const state = task.codingAutonomy;
  const run = state?.runs?.at(-1);
  const dag = task.codeStepDag;
  const pending = [
    ...(run?.pendingInferences || []).map(callId => ({ kind: 'root_inference', requestId: run.requestId, callId })),
    ...(dag?.steps || []).flatMap(step => step.attempts.filter(attempt => ['running', 'unknown'].includes(attempt.state))
      .map(attempt => ({ kind: 'code_step', requestId: attempt.requestId, executorId: attempt.executorId,
        stepId: step.id, state: attempt.state }))),
  ];
  let currentScope = false;
  if (state?.authorized) {
    try {
      policy.assertTask(task);
      currentScope = state.basis === policy.basis(task);
      if (dag) require('./pipelineCodeDagAuthority').assertReviewedAuthority(task, dag);
    } catch { currentScope = false; }
  }
  return { schema: 'agentx.work-authority/v1', observedAt: new Date().toISOString(),
    identity: { boundary: 'private_lan', authenticatedPerson: null, declaredNamesAreIdentity: false,
      nativeLeaseProves: 'lease_possession', internalConsumerTokenProves: 'transport_contract_only' },
    roles: {
      requester: declared(transitions.find(event => event.kind === 'created')),
      accountableOwner: null,
      assignee: task.assignee ? { declared: task.assignee, authenticated: null } : null,
      authorizer: state ? { channel: 'operator_api', authenticated: null, declared: null, at: timestamp(state.authorizedAt),
        attribution: 'individual_not_recorded' } : null,
      executor: run?.executorId ? { nativeId: run.executorId, harness: run.harness || null,
        rootRequestId: run.requestId, authenticatedPerson: null } : null,
      reviewer: declared([...transitions].reverse().find(event => ['review_accepted', 'review_rejected'].includes(event.kind))),
    },
    roleCoverage: 'Recorded roles only; missing ownership or identity is not inferred from an assignee, agent name or surface.',
    delegation: state ? { owner: 'core.coding_autonomy', revision: state.revision, authorized: state.authorized === true,
      currentScope, taskBasis: state.basis, rootRequestId: run?.requestId || null,
      scope: [...(task.automation?.scope || [])], humanGates: [...(task.automation?.humanGates || [])],
      cumulative: { limits: budgets(policy.totalLimits(state)), settledSpent: budgets(policy.spent(state)),
        activeReportedUsage: budgets(run?.finishedAt ? null : run?.currentUsage), grantCount: state.budgetGrants?.length || 0,
        accounting: 'Settled usage and active reports are observations; native admission decides remaining capacity.' },
      futureEffects: currentScope ? 'subject_to_native_admission' : 'blocked',
      revocation: 'Blocks new effects; original receipts and uncertain outcomes remain reconcilable. Stopping requires the native owner.' } : null,
    unresolved: pending,
    review: { required: task.status === 'review', selfApprovalProtection: 'declared_name_check_only',
      authenticatedSeparationOfDuties: false },
    audience: 'engineering_private_lan', authorization: 'none', externalWrites: 'none' };
}
async function read(pipelineId) {
  if (!/^\d{3,4}$/.test(pipelineId || '')) throw Object.assign(new Error('Use an exact Core task ID.'), { code: 'INVALID_ARGUMENTS', status: 400 });
  const task = await require('../../models/PipelineTask').findOne({ pipelineId }).lean();
  require('./pipelineWorkReferencePolicy').assertTask(task);
  return view(task);
}
module.exports = { view, read };
