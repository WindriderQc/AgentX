'use strict';
const express = require('express');
const router = express.Router();
const envelope = require('../src/helpers/responseEnvelope');
const PipelineTask = require('../models/PipelineTask');
const { assertLeaseMutationAllowed, releaseAutomationSlot } = require('../src/services/pipelineTaskService');
const { PIPELINE_AUTOMATION_EVIDENCE_SCHEMA, normalizePipelineAutomationEvidence } = require('../../shared/pipelineAutomationContract');
const { feedbackTransition } = require('../src/services/pipelineTaskTransitionPaths');
const { redactTaskLeaseIds } = require('../src/services/pipelineTaskProjectionReadService');
const { attemptLogReference } = require('../src/services/pipelineEvidenceReferences');
const { workerResultFingerprint, recordedWorkerResult } = require('../src/services/pipelineWorkerResultReplay');
const logger = require('../config/logger');
const workerOutcome = require('../../shared/pipelineWorkerOutcome');
const workerScope = require('../src/helpers/workerTaskScope');
const FEEDBACK_STATUS = { done: 'review', blocked: 'blocked', partial: 'in_progress' };
const feedbackTextFromBody = (body = {}) => String(body.text ?? body.summary ?? '').trim().slice(0, 5000);
router.post('/tasks/:id/feedback', async (req, res) => {
  const b = req.body || {};
  const text = feedbackTextFromBody(b);
  if (!text) return envelope.error(res, 400, 'feedback text is required', 'EMPTY_FEEDBACK');
  const entry = { by: String(b.by || b.assignee || 'agent').trim() || 'agent', text, at: new Date() };
  const update = { $push: { feedback: entry } };
  try {
    const current = await PipelineTask.findOne({ pipelineId: req.params.id });
    if (!current) return envelope.error(res, 404, 'Task not found', 'NOT_FOUND');
    const replay = recordedWorkerResult(current, b);
    if (replay) {
      await releaseAutomationSlot(replay);
      return envelope.success(res, { task: redactTaskLeaseIds(current), alreadyRecorded: true });
    }
    let lease = null;
    try {
      lease = assertLeaseMutationAllowed(current, {
        assignee: b.leaseAssignee || b.assignee || b.by,
        leaseId: b.leaseId,
      });
    } catch (err) {
      return envelope.error(res, 409, err.message, err.code);
    }
    if (b.attemptEvidence && !lease) {
      return envelope.error(
        res,
        400,
        'attemptEvidence requires an active automation lease',
        'AUTOMATION_EVIDENCE_REQUIRES_LEASE'
      );
    }
    if (b.attemptEvidence && !['done', 'blocked'].includes(b.status)) {
      return envelope.error(
        res,
        400,
        'attemptEvidence may be recorded only with a terminal worker verdict',
        'AUTOMATION_EVIDENCE_REQUIRES_TERMINAL_VERDICT'
      );
    }

    let terminalVerdict = b.status;
    let normalizedEvidence = null;
    if (b.attemptEvidence) {
      try {
        normalizedEvidence = normalizePipelineAutomationEvidence(b.attemptEvidence);
      } catch (err) {
        return envelope.error(res, err.status || 400, err.message, err.code || 'INVALID_AUTOMATION_EVIDENCE');
      }
    }
    const rawAllowedCost = current.automation?.budgets?.maxCostNanodollars;
    const allowedCost = Number(rawAllowedCost);
    if (lease && b.status === 'done') {
      if (!normalizedEvidence) {
        normalizedEvidence = normalizePipelineAutomationEvidence({
          schema: PIPELINE_AUTOMATION_EVIDENCE_SCHEMA,
          verification: { status: 'unknown' },
          changes: {},
          usage: {},
          failureCodes: [],
          source: 'core-cost-gate/v1',
        });
      }
      const observedCost = normalizedEvidence.usage.costNanodollars;
      // Local execution is proven separately from monetary telemetry. Unknown
      // spend never means zero, nor does this grant permission to use paid APIs.
      const verifiedLocal = normalizedEvidence.routing?.status === 'verified'
        && normalizedEvidence.routing.provider === 'ollama'
        && normalizedEvidence.verification.status === 'passed'
        && normalizedEvidence.workerReceiptFingerprint
        && normalizedEvidence.failureCodes.length === 0
        && allowedCost === 0;
      const costBudgetValid = rawAllowedCost != null
        && Number.isSafeInteger(allowedCost)
        && allowedCost >= 0;
      const costFailure = !costBudgetValid
        ? 'cost_budget_invalid'
        : (observedCost == null && !verifiedLocal
          ? 'cost_evidence_required'
          : (observedCost > allowedCost ? 'cost_budget_exceeded' : null));
      if (costFailure) {
        terminalVerdict = 'blocked';
        normalizedEvidence.failureCodes = Array.from(new Set([
          ...normalizedEvidence.failureCodes,
          costFailure,
        ])).sort();
      }
    }
    if (FEEDBACK_STATUS[terminalVerdict]) update.$set = { status: FEEDBACK_STATUS[terminalVerdict] };
    if (update.$set?.status === 'in_progress' && current.status !== 'in_progress') {
      require('../src/services/taskIntakePolicy').assertAccepted(current);
    }

    const query = { pipelineId: req.params.id };
    if (update.$set?.status === 'in_progress' && current.status !== 'in_progress') require('../src/services/taskIntakePolicy').guard(query, current);
    const options = { new: true };
    if (b.manualWorkerClaim != null) {
      if (lease || b.manualReportClaim != null || entry.by !== 'coding-team' || !FEEDBACK_STATUS[b.status])
        return envelope.error(res, 400, 'Manual worker feedback must name its original claim', 'MANUAL_WORKER_CLAIM_INVALID');
      try { Object.assign(query, require('../src/services/pipelineManualReportClaim').query(current, b.manualWorkerClaim, ['in_progress', 'blocked'])); }
      catch (error) { return envelope.error(res, error.statusCode || 409, 'The original coding worker claim no longer owns this scope', 'MANUAL_WORKER_CLAIM_CHANGED'); }
    }
    if (b.manualReportClaim != null) {
      if (lease || entry.by !== 'coding-team' || b.status !== 'blocked') return envelope.error(res, 400, 'Manual report stop must name its original claim', 'REPORT_CLAIM_INVALID');
      try { Object.assign(query, require('../src/services/pipelineManualReportClaim').query(current, b.manualReportClaim, ['in_progress', 'blocked'])); }
      catch (error) { return envelope.error(res, error.statusCode || 409, error.message, error.code); }
    }
    if (b.workerOutcome != null) {
      if (!workerScope.contains(current) || lease || current.codingAutonomy || Number(current.automationAttemptCount) > 0
        || current.assignee !== 'coding-team' || !['in_progress', 'blocked'].includes(current.status)
        || (b.status != null && b.status !== 'blocked')) {
        return envelope.error(res, 409, 'Worker observations cannot replace an attempt or change another claim.', 'WORKER_OUTCOME_CONFLICT');
      }
      try {
        entry.workerOutcome = workerOutcome.normalize(b.workerOutcome, current.pipelineId);
        if ((entry.workerOutcome.source === 'worker_report' && entry.by !== 'coding-team')
          || (entry.workerOutcome.source === 'operator_observation' && entry.by !== 'operator')) throw new Error('Worker outcome source does not match the reporter.');
        if (entry.workerOutcome.source === 'operator_observation' && (current.status !== 'blocked' || b.status != null)) throw new Error('Operator observations explain an already blocked task without changing its status.');
        if (entry.workerOutcome.source === 'worker_report' && b.status !== 'blocked') throw new Error('Worker reports require a blocked verdict.');
        const latestClaim = (current.transitions || []).slice().reverse().find(item => item.kind === 'claimed');
        if (!latestClaim || latestClaim.seq !== entry.workerOutcome.claimSeq || (new Date(latestClaim.at).getTime() > Date.parse(entry.workerOutcome.startedAt) + 120000
          || new Date(latestClaim.at).getTime() > Date.parse(entry.workerOutcome.finishedAt))) throw new Error('This observation predates the current worker claim.');
      } catch (error) { return envelope.error(res, 400, error.message, 'INVALID_WORKER_OUTCOME'); }
      const recorded = (current.feedback || []).find(item => item.workerOutcome?.requestId === entry.workerOutcome.requestId);
      if (recorded) {
        if (recorded.by !== entry.by || recorded.text !== entry.text || JSON.stringify(workerOutcome.normalize(recorded.workerOutcome, current.pipelineId)) !== JSON.stringify(entry.workerOutcome)) {
          return envelope.error(res, 409, 'A different observation is already recorded for this worker request.', 'WORKER_OUTCOME_CONFLICT');
        }
        return envelope.success(res, { task: redactTaskLeaseIds(current), alreadyRecorded: true });
      }
      Object.assign(query, { status: current.status, assignee: current.assignee, updatedAt: current.updatedAt,
        transitionSeq: current.transitionSeq,
        $and: [workerScope(), { service: current.service ?? null, source: current.source ?? null }],
        'automationLease.leaseId': null, codingAutonomy: current.codingAutonomy ?? null,
        automationAttemptCount: { $in: [0, null] } });
    }
    if (b.status === 'deferred' && b.expectedQueuedUpdatedAt == null) {
      return envelope.error(res, 400, 'Capacity deferral requires the observed queued task version', 'INVALID_PREFLIGHT_FEEDBACK');
    }
    if (b.expectedQueuedUpdatedAt != null) {
      const expected = new Date(b.expectedQueuedUpdatedAt);
      if (!['blocked', 'deferred'].includes(b.status) || lease || Number.isNaN(expected.getTime())) {
        return envelope.error(res, 400, 'Queued preflight feedback requires a valid task version and blocked or deferred status', 'INVALID_PREFLIGHT_FEEDBACK');
      }
      Object.assign(query, { status: 'queued', assignee: null, updatedAt: expected });
    }
    if (lease) {
      query.status = 'in_progress';
      query.assignee = lease.assignee;
      query['automationLease.leaseId'] = lease.leaseId;
      query['automationLease.expiresAt'] = { $gt: entry.at };
      if (terminalVerdict === 'done' || terminalVerdict === 'blocked') {
        update.$set['automationAttempts.$[attempt].finalState'] = FEEDBACK_STATUS[terminalVerdict];
        update.$set['automationAttempts.$[attempt].completedAt'] = entry.at;
        if (normalizedEvidence) update.$set['automationAttempts.$[attempt].evidence'] = normalizedEvidence;
        update.$set['automationAttempts.$[attempt].resultRequestFingerprint'] = workerResultFingerprint(b);
        update.$unset = { automationLease: 1 };
        options.arrayFilters = [{ 'attempt.leaseId': lease.leaseId }];
      }
    }

    const transition = feedbackTransition(query, update, current, { entry, lease, requested: b.status, evidence: normalizedEvidence });
    const task = await PipelineTask.findOneAndUpdate(query, update, options);
    if (!task && (b.manualReportClaim != null || b.manualWorkerClaim != null)) return envelope.error(res, 409, 'Original worker claim changed before feedback', 'REPORT_CLAIM_CHANGED');
    if (!task && b.workerOutcome != null) return envelope.error(res, 409, 'The task changed while recording this observation.', 'WORKER_OUTCOME_CONFLICT');
    if (!task && b.expectedQueuedUpdatedAt != null) {
      return envelope.error(res, 409, 'Task changed before preflight feedback was recorded', 'TASK_PREFLIGHT_CHANGED');
    }
    if (!task && lease) {
      const latest = await PipelineTask.findOne({ pipelineId: req.params.id });
      const replay = recordedWorkerResult(latest, b);
      if (replay) {
        await releaseAutomationSlot(replay);
        return envelope.success(res, { task: redactTaskLeaseIds(latest), alreadyRecorded: true });
      }
      return envelope.error(res, 409, 'automation lease changed before feedback was recorded', 'TASK_LEASE_MISMATCH');
    }
    if (!task && transition) return envelope.error(res, 409, 'Task changed before its status was recorded; reload it', 'TASK_TRANSITION_CONFLICT');
    if (!task) return envelope.error(res, 404, 'Task not found', 'NOT_FOUND');
    if (lease && (terminalVerdict === 'done' || terminalVerdict === 'blocked')) {
      await releaseAutomationSlot({
        leaseId: lease.leaseId,
        pipelineId: current.pipelineId,
        assignee: lease.assignee,
      });
      const { attempt, dispatchRequestId } = current.automationLease || {};
      logger.info('Pipeline automation attempt ended', { ...attemptLogReference({ pipelineId: current.pipelineId,
        attempt, leaseId: lease.leaseId, dispatchRequestId }), verdict: terminalVerdict });
    }
    return envelope.success(res, { task: redactTaskLeaseIds(task) });
  } catch (err) { return envelope.error(res, err.status || err.statusCode || 500, err.message, err.code); }
});

module.exports = router;
