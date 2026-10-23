'use strict';

/**
 * One-click resume of a private report (#878).
 *
 * The owner chooses only *when* (as soon as possible, tonight, or a time) and
 * whether executions may chain and failed steps may escalate to the cloud.
 * Core then:
 *
 * 1. estimates the remaining work from the saved coverage, and turns it into
 *    a generous safety budget (calls, work seconds, executions);
 * 2. records a report campaign in the heavy-work queue that Core itself owns
 *    (executor `pipeline-report`), places it with the "When" choice and marks
 *    it to start automatically;
 * 3. at the slot, records the report grant on that campaign and launches the
 *    worker from the saved checkpoint, exactly like an operator would;
 * 4. settles the campaign when the report is delivered or stops for good.
 *
 * Progress, not the clock, ends the work: a stop with unchanged saved bytes is
 * `no_progress` (no continuation, an alert), blocked documents raise an alert,
 * and the budget only bounds a runaway. The cloud cap stays the owner's.
 */

const crypto = require('crypto');
const Task = require('../../models/PipelineTask');
const Run = require('../../models/PipelineReportRun');
const queue = require('./heavyWorkQueueService');
const authority = require('./pipelineReportAuthority');
const routerConfig = require('./modelRouterConfig');
const { fail } = require('./pipelineManualReportClaim');

const WC = { w: 1, j: true };
const WHEN = ['asap', 'tonight', 'at'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function retryable(task, job) {
  return job?.state === 'failed' && !task.reportResume?.launch
    && job.releaseReceipt?.receiptRef?.startsWith('core:not-started:')
    && !(task.codingReportAuthority?.grants || []).some(row => row.key === task.reportResume?.grantKey);
}
// Conservative cost of one document step when the lane has no agent
// measurement yet, plus the final writer step. MARGIN makes the budget a
// safety net rather than a target.
const PER_DOCUMENT = { seconds: 240, calls: 6 };
const WRITER = { seconds: 900, calls: 6 };
const MARGIN = 1.5;
const LIMITS = { calls: [128, 1024], seconds: [3600, 57600], runs: [1, 4] };
const clamp = (value, [low, high]) => Math.min(high, Math.max(low, value));

let control;
let preparation;
function configure({ control: nextControl, preparation: nextPreparation } = {}) {
  control = nextControl;
  preparation = nextPreparation || require('./pipelineTaskPreparationService');
}

const uuidFrom = text => {
  const hex = crypto.createHash('sha256').update(text).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(8 | (parseInt(hex[16], 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const latestOutcome = task => (task.feedback || []).map(row => row.reportOutcome).filter(Boolean).at(-1) || null;

async function readTask(pipelineId) {
  const task = await Task.findOne({ pipelineId }).lean();
  if (!task) throw fail('Task not found', 'NOT_FOUND', 404);
  return task;
}

/** The checkpoint a resume continues from: the latest saved report, if any. */
function checkpointOf(task) {
  const outcome = latestOutcome(task);
  if (!outcome?.requestId) return null;
  const sha = outcome.partial?.sha256 || null;
  return { parentRequestId: outcome.requestId, ...(sha && { parentSha256: sha }) };
}

/** Documents still to review, from the latest run's coverage or the scope. */
async function remainingWork(task) {
  const runs = await Run.find({ taskId: String(task._id) }).sort({ claimSeq: 1 }).lean();
  const latest = runs.at(-1);
  const documents = latest?.coverage?.documents || latest?.inventory?.documents || null;
  if (Array.isArray(documents) && documents.length) {
    const left = documents.filter(row => row?.state !== 'reviewed');
    return { total: documents.length, remaining: left.length, reviewed: documents.length - left.length,
      partial: left.filter(row => row?.state === 'partial').length, blocked: left.filter(row => row?.state === 'blocked').length,
      source: latest.coverage ? 'coverage' : 'inventory' };
  }
  const scope = task.codingResult?.documentPaths;
  if (Array.isArray(scope) && scope.length) return { total: scope.length, remaining: scope.length, reviewed: 0, partial: 0, blocked: 0, source: 'scope' };
  return { total: null, remaining: null, reviewed: 0, partial: 0, blocked: 0, source: 'unknown' };
}

/** Safety budget for the remaining work; shown to the owner, not asked. */
function budgetFor(work, modelCallLimit = 128) {
  const documents = work.remaining ?? 40;
  const seconds = clamp(Math.ceil((documents * PER_DOCUMENT.seconds + WRITER.seconds) * MARGIN), LIMITS.seconds);
  const calls = clamp(Math.ceil((documents * PER_DOCUMENT.calls + WRITER.calls) * MARGIN), LIMITS.calls);
  const runs = clamp(Math.ceil(calls / Math.max(1, modelCallLimit)), LIMITS.runs);
  return { modelCalls: calls, workSeconds: seconds, executions: runs, minutes: Math.ceil(seconds / 60),
    basis: work.remaining == null ? 'default' : 'remaining_documents' };
}

function reportTask(task) {
  if (task.codingResult?.profile !== 'report' && !latestOutcome(task)) throw fail('This task does not produce a report', 'REPORT_RESUME_UNSUPPORTED', 409);
  const outcome = latestOutcome(task);
  if (outcome && outcome.kind !== 'blocked') throw fail('The report was delivered; review it instead of resuming', 'REPORT_RESUME_DELIVERED', 409);
  return outcome;
}

async function target() {
  await routerConfig.ensureTaskModelOverridesLoaded();
  const route = routerConfig.getModelForTask('code_generation');
  if (!route?.url || !route.model || String(route.model).startsWith('openrouter/')) throw fail('No local coding route is configured', 'REPORT_ROUTE_UNAVAILABLE', 409);
  return { model: route.model, host: route.url.replace(/\/+$/, '') };
}

/** What a resume would do now: checkpoint, remaining work, budget, campaign. */
async function preview(pipelineId) {
  const task = await readTask(pipelineId);
  reportTask(task);
  const work = await remainingWork(task);
  const limit = task.codingResult?.modelCallLimit || 128;
  const campaign = task.reportResume?.queueRequestId ? await queue.get(task.reportResume.queueRequestId).catch(() => null) : null;
  return { pipelineId, reportName: task.codingResult?.reportName || latestOutcome(task)?.reportName || null,
    checkpoint: checkpointOf(task), work, budget: budgetFor(work, limit), perExecutionModelCalls: limit, route: await target().catch(() => null),
    escalation: await require('./pipelineReportEscalation').policy().catch(() => null),
    retryCampaignId: retryable(task, campaign) ? campaign.id : null,
    resume: task.reportResume || null,
    campaign: campaign ? { id: campaign.id, state: campaign.state, reservation: campaign.reservation, reason: campaign.reason || null,
      releaseReceipt: campaign.releaseReceipt || null } : null };
}

/**
 * Plan the resume. Idempotent per checkpoint: pressing again for the same
 * saved report returns the same campaign (replanned when still unstarted).
 */
async function resume(pipelineId, input = {}) {
  if (input.confirm !== true || !WHEN.includes(input.when)) throw fail('Choose when to resume and confirm', 'REPORT_RESUME_INVALID', 400);
  for (const flag of ['autoContinue', 'allowCloudEscalation']) {
    if (input[flag] !== undefined && typeof input[flag] !== 'boolean') throw fail(`${flag} needs true or false`, 'REPORT_RESUME_INVALID', 400);
  }
  if (input.retryCampaignId !== undefined && !UUID.test(input.retryCampaignId))
    throw fail('Name the exact failed campaign to retry', 'REPORT_RESUME_INVALID', 400);
  const task = await readTask(pipelineId);
  reportTask(task);
  if (!['queued', 'blocked'].includes(task.status) || task.automationLease?.leaseId) throw fail('The task is running or awaiting review', 'REPORT_RESUME_BUSY', 409);
  if (!task.codingResult?.reportName) throw fail('Choose the report result once with the full form first', 'REPORT_RESUME_UNCONFIGURED', 409);
  const checkpoint = checkpointOf(task);
  const work = await remainingWork(task);
  const budget = budgetFor(work, task.codingResult.modelCallLimit || 128);
  const route = await target();
  const basis = checkpoint?.parentRequestId || 'initial';
  const prior = task.reportResume;
  if (prior?.basis === basis && prior.queueRequestId) {
    const job = await queue.get(prior.queueRequestId).catch(() => null);
    if (job && ['dispatching', 'running', 'uncertain'].includes(job.state)) throw fail('This resume is already running', 'REPORT_RESUME_BUSY', 409);
  }
  let retryOfCampaignId = prior?.basis === basis ? prior.retryOfCampaignId || null : null;
  if (input.retryCampaignId && input.retryCampaignId !== retryOfCampaignId) {
    const failed = prior?.queueRequestId === input.retryCampaignId && prior.basis === basis
      ? await queue.get(input.retryCampaignId).catch(() => null) : null;
    if (!retryable(task, failed)) throw fail('Refresh the exact campaign; only an unstarted, unallocated failure can be retried', 'REPORT_RESUME_CHANGED', 409);
    retryOfCampaignId = input.retryCampaignId;
  }
  const request = {
    key: `report-campaign:${pipelineId}:${basis}${retryOfCampaignId ? `:retry:${retryOfCampaignId}` : ''}`,
    title: `Report ${task.codingResult.reportName}: resume task ${pipelineId}`,
    kind: 'other', hosts: [route.host], estimatedMinutes: budget.minutes,
    source: { type: 'coding', ref: 'pipeline-report-resume', taskId: pipelineId },
    executor: { mode: 'pipeline-report', pipelineId }
  };
  let job = await queue.submit(request, 'pipeline-report-resume');
  if (job.archived || !['requested', 'reserved'].includes(job.state)) {
    throw fail('This checkpoint already had a campaign; its outcome is in the queue history', 'REPORT_RESUME_DONE', 409);
  }
  job = await queue.place(job.id, { expectedRevision: job.revision, when: input.when, at: input.at, autoStart: true }, 'pipeline-report-resume');
  const state = { basis, queueRequestId: job.id, grantKey: uuidFrom(`report-grant:${pipelineId}:${job.id}`),
    ...(retryOfCampaignId && { retryOfCampaignId }),
    when: input.when, budget, work, checkpoint, model: route.model, host: route.host,
    autoContinue: input.autoContinue === true, allowCloudEscalation: input.allowCloudEscalation === true,
    requestedAt: new Date().toISOString(), state: 'planned', launch: null };
  const saved = await Task.findOneAndUpdate({ _id: task._id, updatedAt: task.updatedAt },
    { $set: { reportResume: state } }, { new: true, timestamps: false, writeConcern: WC }).lean();
  if (!saved) throw fail('The task changed; read it again', 'REPORT_RESUME_CHANGED', 409);
  return preview(pipelineId);
}

/** Before the dispatch mark: the task must still be resumable from the same checkpoint. */
async function preDispatch(job) {
  const task = await readTask(job.executor.pipelineId);
  const state = task.reportResume;
  if (!state || state.queueRequestId !== job.id) throw fail('This campaign no longer belongs to the task\'s resume', 'REPORT_RESUME_CHANGED', 409);
  if ((checkpointOf(task)?.parentRequestId || 'initial') !== state.basis) throw fail('The saved report changed since the resume was planned', 'REPORT_RESUME_CHANGED', 409);
  if (!['queued', 'blocked'].includes(task.status) || task.automationLease?.leaseId) throw fail('The task is running or awaiting review', 'REPORT_RESUME_BUSY', 409);
  if (!control) throw fail('The coding runner is unavailable', 'REPORT_RESUME_UNAVAILABLE', 409);
}

/**
 * At the slot, after the dispatch mark: record the grant on this campaign and
 * launch the worker from the checkpoint. The worker request id is derived
 * from the campaign and saved before the host call, so a lost answer is
 * observed instead of launched twice.
 */
async function launchFromCampaign(job) {
  try { return await launchWorker(job); }
  catch (error) {
    // Nothing reached the runner before the launch mark: Core may release the
    // campaign itself instead of leaving it uncertain.
    if (!error.launchSent) error.notStarted = true;
    throw error;
  }
}
async function launchWorker(job) {
  let task = await readTask(job.executor.pipelineId);
  const state = task.reportResume;
  const requestId = uuidFrom(`report-resume:${task.pipelineId}:${job.id}`);
  const checkpoint = state.checkpoint || null;
  const result = { profile: 'report', reportName: task.codingResult.reportName, modelCallLimit: task.codingResult.modelCallLimit || 128,
    ...(checkpoint || {}), ...(task.codingResult.documentPaths ? { documentPaths: task.codingResult.documentPaths } : {}) };
  task = await preparation.apply({ pipelineId: task.pipelineId, expectedUpdatedAt: new Date(task.updatedAt).toISOString(), handoff: true,
    contextNotice: `Resumed by the owner (${state.when === 'asap' ? 'as soon as possible' : state.when === 'tonight' ? 'tonight' : 'at a chosen time'}): `
      + `${state.work?.remaining ?? 'unknown'} documents left, safety budget ${state.budget.modelCalls} calls / ${Math.round(state.budget.workSeconds / 60)} min.`,
    result, reportGrant: { key: state.grantKey, confirm: true, queueRequestId: job.id, additionalRuns: state.budget.executions,
      budget: { modelCalls: state.budget.modelCalls, workSeconds: state.budget.workSeconds },
      ...(state.allowCloudEscalation && { allowCloudEscalation: true }) } });
  const status = await control.status({});
  const candidate = (status.candidates || []).find(row => row.pipelineId === task.pipelineId
    && (!Array.isArray(row.executorProfiles) || row.executorProfiles.includes('report')));
  if (!candidate) throw fail('The coding runner does not offer this task now', 'REPORT_RESUME_NOT_CANDIDATE', 409);
  const marked = await Task.findOneAndUpdate({ _id: task._id, 'reportResume.queueRequestId': job.id, 'reportResume.launch': null },
    { $set: { 'reportResume.launch': { requestId, at: new Date().toISOString(), expectedAttemptCount: candidate.expectedAttemptCount,
      ...(candidate.executorId && { executorId: candidate.executorId }) },
      'reportResume.state': 'launched' } }, { new: true, timestamps: false, writeConcern: WC }).lean();
  if (!marked) throw Object.assign(fail('This campaign already launched its worker', 'REPORT_RESUME_LAUNCHED', 409), { launchSent: true });
  await control.launch({ pipelineId: task.pipelineId, requestId, expectedAttemptCount: candidate.expectedAttemptCount, confirm: true,
    ...(candidate.executorId && { executorId: candidate.executorId }),
    reportName: result.reportName, modelCallLimit: result.modelCallLimit,
    ...(checkpoint?.parentRequestId && { parentRequestId: checkpoint.parentRequestId }),
    ...(checkpoint?.parentSha256 && { parentSha256: checkpoint.parentSha256 }) })
    .catch(error => { throw Object.assign(error, { launchSent: true }); });
  return { queueId: requestId };
}

/**
 * Whether the campaign is over: the report was delivered, or it stopped and
 * no continuation will follow under this campaign. A running worker or a
 * pending continuation keeps it open.
 */
async function observeCampaign(job) {
  const task = await readTask(job.executor.pipelineId);
  const state = task.reportResume;
  const operationId = state?.launch?.requestId || null;
  if (!state || state.queueRequestId !== job.id || !operationId) return { terminal: false, operationId };
  const active = await Run.exists({ taskId: String(task._id), state: 'active' });
  const host = control ? await control.status({ requestId: operationId,
    ...(state.launch.executorId && { executorId: state.launch.executorId }) }).catch(() => null) : null;
  if (host?.run?.requestId === operationId && host.run.phase === 'rejected') {
    await Task.updateOne({ _id: task._id, 'reportResume.queueRequestId': job.id },
      { $set: { 'reportResume.state': 'stopped', 'reportResume.finishedAt': new Date().toISOString(),
        'reportResume.result': { requestId: operationId, kind: 'rejected', reason: host.run.reason || 'launch_rejected' } } },
      { timestamps: false, writeConcern: WC });
    return { terminal: true, operationId, state: 'failed', outcome: { requestId: operationId, kind: 'rejected', reason: host.run.reason || 'launch_rejected' } };
  }
  if (active || host?.busy === true || task.automationLease?.leaseId) return { terminal: false, operationId };
  const ours = new Set([operationId, ...((task.reportContinuation?.runs || []).map(row => row.requestId))]);
  const outcome = latestOutcome(task);
  if (!outcome || !ours.has(outcome.requestId)) return { terminal: false, operationId };
  const continuation = require('./pipelineReportContinuationService');
  const decision = continuation.decide(task);
  const pending = (task.reportContinuation?.runs || []).some(row => !row.finishedAt);
  const windowOpen = Date.now() < Date.parse(job.reservation.end);
  if (pending || (decision.action === 'continue' && windowOpen && await continuation.wouldContinue(task))) return { terminal: false, operationId };
  const delivered = outcome.kind !== 'blocked';
  await Task.updateOne({ _id: task._id, 'reportResume.queueRequestId': job.id },
    { $set: { 'reportResume.state': delivered ? 'delivered' : 'stopped', 'reportResume.finishedAt': new Date().toISOString(),
      'reportResume.result': { requestId: outcome.requestId, kind: outcome.kind, reason: outcome.reason || null, decision: decision.action } } },
    { timestamps: false, writeConcern: WC });
  return { terminal: true, operationId, state: delivered ? 'completed' : 'failed',
    outcome: { requestId: outcome.requestId, kind: outcome.kind, reason: outcome.reason || decision.action } };
}

module.exports = { configure, preview, resume, preDispatch, launchFromCampaign, observeCampaign, budgetFor, remainingWork, checkpointOf };
