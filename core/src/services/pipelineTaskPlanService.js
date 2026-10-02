'use strict';
const PipelineTask = require('../../models/PipelineTask');
const {
  planError, basisRef, currentRevision, isPrivateLane, normalizePlanSubmission, normalizeDecision,
  buildRevision, recordPlanRevision, basisGuard, planView,
} = require('./pipelineTaskPlans');
const { buildTransition, recordTransition } = require('./pipelineTaskTransitions');

const PLANNABLE_STATUSES = ['queued', 'blocked'];

async function load(pipelineId) {
  if (!/^\d{3,4}$/.test(String(pipelineId || ''))) throw planError('Invalid pipeline id', 400, 'INVALID_PIPELINE_ID');
  const task = await PipelineTask.findOne({ pipelineId: String(pipelineId) }).lean();
  if (!task) throw planError('Task not found', 404, 'NOT_FOUND');
  return task;
}

async function readPlan(pipelineId) {
  const task = await load(pipelineId);
  return { pipelineId: task.pipelineId, status: task.status, plan: planView(task) };
}

/**
 * Record a new plan revision. The write changes only the plan fields: status,
 * assignee, automation, lease and review state stay exactly as they were, so a
 * recorded plan (whatever its text says) cannot start or approve anything.
 */
async function submitPlan(pipelineId, body) {
  const input = normalizePlanSubmission(body);
  const task = await load(pipelineId);
  if (isPrivateLane(task)) throw planError('This task belongs to its personal or household workflow.', 409, 'PLAN_LANE_UNSUPPORTED');
  if (!PLANNABLE_STATUSES.includes(task.status) || task.automationLease?.leaseId) {
    throw planError('Plans are recorded before work starts; this task is running, in review or closed.', 409, 'PLAN_TASK_STATE');
  }
  if (currentRevision(task) !== input.expectedRevision) {
    throw planError(`The plan is now at revision ${currentRevision(task)}. Read it before adding a new revision.`, 409, 'PLAN_REVISION_CONFLICT');
  }
  const revision = buildRevision(task, { mode: input.mode, text: input.text, steps: input.steps,
    declaredActor: input.by, channel: 'plan_api' });
  const query = basisGuard({ pipelineId: task.pipelineId, status: task.status, 'automationLease.leaseId': { $exists: false } }, task);
  const update = {};
  recordPlanRevision(query, update, task, revision);
  const updated = await PipelineTask.findOneAndUpdate(query, update, { new: true, runValidators: true }).lean();
  if (!updated) throw planError('The task or its plan changed while saving. Read the current plan and try again.', 409, 'PLAN_REVISION_CONFLICT');
  return { pipelineId: updated.pipelineId, status: updated.status, plan: planView(updated) };
}

function sameDecision(existing, input) {
  return existing.outcome === input.outcome && existing.planFingerprint === input.planFingerprint
    && existing.actor?.declared === input.by;
}

/**
 * Record one human decision on the exact current revision. A decision for an
 * older revision, a different fingerprint, a changed scope or a changed task
 * request is refused (409) instead of being applied to what the reviewer did
 * not see. Approval changes nothing else. Requesting changes on a queued,
 * unleased task returns it to `blocked` so the preparation loop resumes; that
 * status change is written with its transition event in the same update.
 */
async function decidePlan(pipelineId, body) {
  const input = normalizeDecision(body);
  const task = await load(pipelineId);
  if (isPrivateLane(task)) throw planError('This task belongs to its personal or household workflow.', 409, 'PLAN_LANE_UNSUPPORTED');
  const latest = (task.planRevisions || []).at(-1);
  if (!latest || latest.revision !== currentRevision(task)) throw planError('This task has no current plan to decide on.', 409, 'PLAN_MISSING');
  if (input.revision !== latest.revision) {
    throw planError(`Revision ${input.revision} is no longer current. Revision ${latest.revision} has its own decision to make; the earlier decision does not carry over.`, 409, 'PLAN_REVISION_STALE');
  }
  if (input.planFingerprint !== latest.fingerprint) throw planError('The reviewed plan text differs from the recorded revision.', 409, 'PLAN_FINGERPRINT_MISMATCH');
  if (latest.decision) {
    if (sameDecision(latest.decision, input)) return { pipelineId: task.pipelineId, status: task.status, plan: planView(task), idempotent: true };
    throw planError(`Revision ${latest.revision} already has a decision. A new plan revision is needed to decide again.`, 409, 'PLAN_ALREADY_DECIDED');
  }
  if ((task.automation?.fingerprint ?? null) !== (latest.scopeFingerprint ?? null)) {
    throw planError('The automation scope changed after this plan was written. Prepare a new revision.', 409, 'PLAN_SCOPE_CHANGED');
  }
  if (basisRef(task) !== latest.basisRef) throw planError('The task request changed after this plan was written. Prepare a new revision.', 409, 'PLAN_BASIS_CHANGED');

  const at = new Date();
  const decision = {
    outcome: input.outcome,
    planFingerprint: latest.fingerprint,
    scopeFingerprint: latest.scopeFingerprint ?? null,
    basisRef: latest.basisRef,
    actor: { declared: input.by, authenticated: null, channel: 'operator_api' },
    reason: input.reason,
    at,
  };
  const label = input.outcome === 'approved' ? 'approved' : 'changes requested';
  const query = basisGuard({
    pipelineId: task.pipelineId,
    planRevision: latest.revision,
    planRevisions: { $elemMatch: { revision: latest.revision, fingerprint: latest.fingerprint, decision: null } },
  }, task);
  const update = {
    $set: { 'planRevisions.$[plan].decision': decision },
    $push: { feedback: { by: input.by, text: `Plan revision ${latest.revision} ${label}${input.reason ? `: ${input.reason}` : '.'}`, at } },
  };
  let transition = null;
  if (input.outcome === 'changes_requested' && task.status === 'queued' && !task.automationLease?.leaseId) {
    transition = buildTransition(task, { to: 'blocked', kind: 'operator_set', channel: 'operator_api',
      declaredActor: input.by, reason: `Plan revision ${latest.revision}: changes requested`, at });
    query['automationLease.leaseId'] = { $exists: false };
    update.$set.status = 'blocked';
    recordTransition(query, update, task, transition);
  }
  const updated = await PipelineTask.findOneAndUpdate(query, update, {
    new: true, runValidators: true, arrayFilters: [{ 'plan.revision': latest.revision }],
  }).lean();
  if (!updated) throw planError('The task or its plan changed while saving. Read the current plan before deciding.', 409, 'PLAN_DECISION_CONFLICT');
  return { pipelineId: updated.pipelineId, status: updated.status, plan: planView(updated), ...(transition && { transition: { seq: transition.seq, from: transition.from, to: transition.to } }) };
}

module.exports = { readPlan, submitPlan, decidePlan };
