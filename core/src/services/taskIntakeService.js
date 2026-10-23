'use strict';
const { createHash } = require('node:crypto');
const Task = require('../../models/PipelineTask');
const ReportRun = require('../../models/PipelineReportRun');
const policy = require('./taskIntakePolicy');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_DECISIONS = 64;

function normalize(input) {
  const fields = ['state', 'reason', 'by', 'requestId', 'expectedRevision', 'expectedScopeFingerprint', 'confirm'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))
    || input.confirm !== true || !policy.STATES.includes(input.state) || !UUID.test(input.requestId || '')
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || !/^[a-f0-9]{64}$/.test(input.expectedScopeFingerprint || '')) throw policy.error('Confirm one exact intake decision with its current revision, scope and request identity.', 'INVALID_INTAKE_DECISION', 400);
  if (typeof input.reason !== 'string' || input.reason.trim().length < 8 || input.reason.length > 1000
    || typeof input.by !== 'string' || !input.by.trim() || input.by.length > 120)
    throw policy.error('Supply a decision reason (8–1000 characters) and declared actor (1–120 characters).', 'INVALID_INTAKE_DECISION', 400);
  return { state: input.state, reason: input.reason.trim(), by: input.by.trim(), requestId: input.requestId,
    expectedRevision: input.expectedRevision, expectedScopeFingerprint: input.expectedScopeFingerprint, confirm: true };
}

async function decide(pipelineId, body) {
  const input = normalize(body);
  const intentHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const task = await Task.findOne({ pipelineId }).lean();
  if (!task) throw policy.error('Task not found', 'NOT_FOUND', 404);
  if (!policy.applicable(task)) throw policy.error('Use the existing personal/family decision workflow.', 'TASK_INTAKE_PRIVATE');
  const prior = task.intake?.history?.find(row => row.requestId === input.requestId);
  if (prior) {
    if (prior.intentHash !== intentHash) throw policy.error('This decision identity has another intent.', 'TASK_INTAKE_KEY_CONFLICT');
    return { task, intakeView: policy.view(task), receipt: prior, replayed: true };
  }
  if (input.expectedRevision !== (task.intake?.revision || 0) || input.expectedScopeFingerprint !== policy.scopeFingerprint(task))
    throw policy.error('The decision or request changed. Read it again before deciding.', 'TASK_INTAKE_CONFLICT');
  if (task.resolution?.kind === 'superseded' || policy.fenced(task))
    throw policy.error('Reconcile existing ownership, authorization and execution before changing the intake decision.', 'TASK_INTAKE_FENCED');
  const unresolved = await ReportRun.exists({ taskId: String(task._id), $or: [{ state: 'active' },
    { 'pendingInferences.0': { $exists: true } }, { modelReceipts: { $elemMatch: { state: { $nin: ['completed', 'refused'] } } } }] });
  if (unresolved) throw policy.error('Reconcile the original report and native model receipts first.', 'TASK_INTAKE_FENCED');
  const bindings = task.codingReportAuthority?.bindings || [];
  if (bindings.length && await ReportRun.countDocuments({ taskId: String(task._id), _id: { $in: bindings.map(row => row.requestId) } }) !== new Set(bindings.map(row => row.requestId)).size)
    throw policy.error('Reconcile the original allocated report identity first.', 'TASK_INTAKE_FENCED');
  const history = task.intake?.history || [];
  if (history.length >= MAX_DECISIONS) throw policy.error('Decision history is full; preserve and review it before any further decision.', 'TASK_INTAKE_HISTORY_FULL');
  const revision = (task.intake?.revision || 0) + 1;
  const receipt = { revision, requestId: input.requestId, intentHash, from: policy.stateOf(task), to: input.state,
    reason: input.reason, scopeFingerprint: input.expectedScopeFingerprint,
    actor: { declared: input.by, authenticated: null, channel: 'operator_api' }, at: new Date() };
  const intake = { state: input.state, revision, scopeFingerprint: input.expectedScopeFingerprint, history: [...history, receipt] };
  const updated = await Task.findOneAndUpdate({ pipelineId, updatedAt: task.updatedAt, status: task.status,
    assignee: task.assignee ?? null, title: task.title, spec: task.spec ?? null,
    service: task.service ?? null, source: task.source ?? null, profileId: task.profileId ?? null, origin: task.origin ?? null,
    automationLease: null, codingCapacity: null, automationAttempts: task.automationAttempts ?? null,
    'codingAutonomy.revision': task.codingAutonomy?.revision ?? null,
    reportContinuation: task.reportContinuation ?? null,
    'codingReportAuthority.revision': task.codingReportAuthority?.revision ?? null,
    'intake.revision': task.intake?.revision ?? null }, { $set: { intake }, $inc: { __v: 1 } },
  { new: true, runValidators: true, writeConcern: { w: 1, j: true } }).lean();
  if (!updated) {
    // A duplicate concurrent delivery reconciles its original identity once.
    const current = await Task.findOne({ pipelineId }).lean();
    const saved = current?.intake?.history?.find(row => row.requestId === input.requestId);
    if (saved?.intentHash === intentHash) return { task: current, intakeView: policy.view(current), receipt: saved, replayed: true };
    throw policy.error('The task changed while recording the decision. Read the same request.', 'TASK_INTAKE_CONFLICT');
  }
  return { task: updated, intakeView: policy.view(updated), receipt, replayed: false };
}
module.exports = { decide };
