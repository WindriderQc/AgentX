'use strict';

/**
 * Automatic continuation of private reports (#835).
 *
 * When a report execution stops only because its calls or time ran out, with
 * its partial report archived, Core may launch the next execution from that
 * exact checkpoint, inside the grant and campaign window the owner already
 * approved. It mirrors the coding autonomy loop's guarantees:
 *
 * - a global switch, off by default, and one active continuation at a time,
 *   claimed by compare-and-swap;
 * - one continuation per parent outcome, with a request id derived from that
 *   parent, saved before any host call, so a lost answer is observed and never
 *   replaced by a second launch;
 * - the host is observed before every replay; an unknown outcome blocks the
 *   task and raises an alert instead of relaunching;
 * - Core's own report authority still binds the run (grant, credits, window,
 *   parent) when the worker starts; this service only prepares and launches.
 *
 * Anything else (another stop reason, no progress, no grant or window, blocked
 * documents, completion) is reported to the owner as an alert, whether or not
 * automatic continuation is switched on.
 */

const crypto = require('crypto');
const Task = require('../../models/PipelineTask');
const Run = require('../../models/PipelineReportRun');
const Settings = require('../../models/PipelineReportContinuation');
const authority = require('./pipelineReportAuthority');
const notifications = require('./pipelineReportNotifications');
const { fail } = require('./pipelineManualReportClaim');

const ID = 'report-continuation';
const WC = { w: 1, j: true };
const CONTINUE_REASONS = new Set(['model_call_limit', 'hard_budget']);
let control;
let preparation;

function configure({ control: nextControl, preparation: nextPreparation } = {}) {
  control = nextControl;
  preparation = nextPreparation || require('./pipelineTaskPreparationService');
}

async function settings() {
  return (await Settings.findById(ID).lean()) || { _id: ID, enabled: false, revision: 0, active: null };
}

/** The request id of the one continuation allowed after `parentRequestId`. */
function continuationId(pipelineId, parentRequestId) {
  const hex = crypto.createHash('sha256').update(`report-continuation:${pipelineId}:${parentRequestId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(8 | (parseInt(hex[16], 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function reportOutcomes(task) {
  return (task.feedback || []).map(row => row.reportOutcome).filter(Boolean);
}

/** What to do with the task's latest report outcome. */
function decide(task) {
  const outcomes = reportOutcomes(task);
  const latest = outcomes.at(-1);
  if (!latest || !latest.requestId) return { action: 'none' };
  // A delivered report carries its deliverable; a stopped one has kind 'blocked'.
  if (latest.kind !== 'blocked') return latest.deliverableId && latest.sha256 ? { action: 'completed', outcome: latest } : { action: 'none' };
  if (!CONTINUE_REASONS.has(latest.reason) || !latest.partial?.sha256) return { action: 'failed', outcome: latest };
  if (latest.progress?.verified !== true) return { action: 'failed', outcome: latest, reason: 'coverage_comparison_unverified' };
  if (latest.progress.advanced !== true) return { action: 'no_progress', outcome: latest };
  return { action: 'continue', outcome: latest };
}

// Older results remain immutable. Read their accepted native coverage instead
// of treating a changed Markdown digest as proof of work or rewriting history.
async function decision(task) {
  const latest = reportOutcomes(task).at(-1);
  if (!latest || latest.progress || !CONTINUE_REASONS.has(latest.reason) || !latest.partial?.sha256) return decide(task);
  const run = await Run.findById(latest.requestId).lean();
  const progress = await require('./pipelineReportProgress').read(run?.pipelineId === task.pipelineId && run.taskId === String(task._id) ? run : null);
  return decide({ ...task, feedback: [{ reportOutcome: { ...latest, progress } }] });
}

/** Whether Core's report authority could bind a continuation now (read-only). */
async function allowance(task) {
  if (!require('./taskIntakePolicy').accepted(task)) return { ok: false, reason: 'intake_decision_required' };
  const state = task.codingReportAuthority;
  if (!state?.grants?.length) return { ok: false, reason: 'no_grant' };
  const runs = await Run.find({ taskId: String(task._id) }).lean();
  const grant = state.grants.at(-1);
  const used = (state.bindings || []).filter(row => row.grantKey === grant.key).length;
  const spent = authority.history(task, runs);
  const total = authority.limits(state);
  if (used >= grant.additionalRuns) return { ok: false, reason: 'grant_runs_used' };
  if (spent.executions >= total.executions || spent.workSeconds >= total.workSeconds
    || spent.modelCalls + (task.codingResult?.modelCallLimit || 128) > total.modelCalls) return { ok: false, reason: 'credits_exhausted' };
  try { await authority.campaign(grant.queueRequestId, null, task.pipelineId); }
  catch { return { ok: false, reason: 'campaign_window_closed' }; }
  return { ok: true };
}

async function blockedDocuments(requestId) {
  const run = await Run.findById(requestId).select('coverage').lean().catch(() => null);
  return (run?.coverage?.documents || []).filter(row => row?.state === 'blocked').map(row => row.path);
}

async function saveState(task, next) {
  const saved = await Task.findOneAndUpdate({ _id: task._id, updatedAt: task.updatedAt },
    { $set: { reportContinuation: next } }, { new: true, timestamps: false, writeConcern: WC }).lean();
  if (!saved) throw fail('The report task changed; observe it again', 'REPORT_CONTINUATION_CHANGED', 409);
  return saved;
}

async function clearActive(requestId) {
  await Settings.updateOne({ _id: ID, 'active.requestId': requestId }, { $set: { active: null } }, { writeConcern: WC });
}

async function block(task, run, reason, kind) {
  const state = task.reportContinuation || { runs: [] };
  await saveState(task, { ...state, state: 'blocked', reason,
    runs: (state.runs || []).map(item => item.requestId === run.requestId ? { ...item, finishedAt: new Date().toISOString(), result: reason } : item) });
  await notifications.publish(task, kind, run.requestId, { reason });
  await clearActive(run.requestId);
}

/** Alerts that need no launch: completion, failure, no progress, blocked documents. */
async function observeOutcome(task, decision) {
  const { outcome } = decision;
  const blocked = await blockedDocuments(outcome.requestId);
  if (blocked.length) await notifications.publish(task, 'documents_blocked', outcome.requestId, { paths: blocked });
  if (decision.action === 'completed') await notifications.publish(task, 'completed', outcome.requestId);
  if (decision.action === 'failed') await notifications.publish(task, 'execution_failed', outcome.requestId, { reason: decision.reason || outcome.reason || 'unknown' });
  if (decision.action === 'no_progress') await notifications.publish(task, 'no_progress', outcome.requestId);
}

/**
 * Chaining is allowed by the global switch, or for one task by the owner's
 * explicit choice when resuming it (#878). Turning the switch off stops only
 * tasks that did not opt in themselves.
 */
const chaining = (config, task) => config.enabled === true || task?.reportResume?.autoContinue === true;

/** Whether a continuation would be launched for this task now (read-only). */
async function wouldContinue(task) {
  if (!chaining(await settings(), task) || (await decision(task)).action !== 'continue') return false;
  return (await allowance(task)).ok;
}

async function select(config) {
  const tasks = await Task.find({ 'codingResult.profile': 'report', 'codingReportAuthority.grants.0': { $exists: true },
    status: { $in: ['blocked', 'review'] } }).lean();
  for (const task of tasks) {
    const next = await decision(task);
    if (next.action === 'none') continue;
    await observeOutcome(task, next);
    if (next.action !== 'continue' || !chaining(config, task)) continue;
    const parent = next.outcome;
    const state = task.reportContinuation || { runs: [] };
    if ((state.runs || []).some(run => run.parentRequestId === parent.requestId)) continue;
    if (task.status !== 'blocked' || task.automationLease) continue;
    const allowed = await allowance(task);
    if (!allowed.ok) { await notifications.publish(task, 'needs_grant', parent.requestId, { reason: allowed.reason }); continue; }
    let executor = null;
    const previousExecutorId = (state.runs || []).findLast(run => run.requestId === parent.requestId)?.executorId;
    try { executor = typeof control.select === 'function' ? await control.select({ profile: 'report',
      ...(previousExecutorId ? { executorId: previousExecutorId } : { requestId: parent.requestId }) }) : null; }
    catch { continue; }
    const requestId = continuationId(task.pipelineId, parent.requestId);
    const active = { pipelineId: task.pipelineId, requestId, selectedAt: new Date().toISOString(),
      ...(executor && { executorId: executor.id, harness: executor.harness }) };
    const won = await Settings.findOneAndUpdate({ _id: ID, revision: config.revision, active: null },
      { $set: { active } }, { new: true, writeConcern: WC }).lean();
    if (!won) return;
    try {
      await saveState(task, { state: 'dispatching', reason: null, runs: [...(state.runs || []), {
        requestId, parentRequestId: parent.requestId, parentSha256: parent.partial.sha256, selectedAt: active.selectedAt,
        ...(executor && { executorId: executor.id, harness: executor.harness }) }] });
    } catch (error) { await clearActive(requestId); throw error; }
    return;
  }
}

async function dispatch(active, config) {
  const task = await Task.findOne({ pipelineId: active.pipelineId }).lean();
  const run = task?.reportContinuation?.runs?.find(item => item.requestId === active.requestId);
  if (!task || !run) { await clearActive(active.requestId); return; }
  if (run.finishedAt) { await clearActive(run.requestId); return; }
  const host = await control.status({ requestId: run.requestId, ...(run.executorId && { executorId: run.executorId }) });
  if (host.run?.phase === 'not_received' || (!host.run && !run.launchedAt)) {
    if (!chaining(config, task)) { await block(task, run, 'switched_off', 'execution_failed'); return; }
    let current = task;
    if (task.status === 'blocked') {
      // The same requeue an operator performs: the saved checkpoint becomes the
      // parent and the existing grant is reused, never extended.
      current = await preparation.apply({ pipelineId: task.pipelineId, expectedUpdatedAt: new Date(task.updatedAt).toISOString(),
        contextNotice: `Automatic continuation of the saved report ${run.parentSha256.slice(0, 12)} (request ${run.parentRequestId}).`,
        result: { profile: 'report', reportName: task.codingResult.reportName, modelCallLimit: task.codingResult.modelCallLimit,
          parentRequestId: run.parentRequestId, parentSha256: run.parentSha256,
          ...(task.codingResult.documentPaths ? { documentPaths: task.codingResult.documentPaths } : {}) } });
    }
    const status = await control.status(run.executorId ? { executorId: run.executorId } : {});
    const candidate = (status.candidates || []).find(row => row.pipelineId === task.pipelineId);
    if (!candidate) return;
    const started = await Task.findOneAndUpdate({ _id: current._id, 'reportContinuation.runs.requestId': run.requestId },
      { $set: { 'reportContinuation.runs.$.launchedAt': new Date().toISOString(),
        'reportContinuation.runs.$.expectedAttemptCount': candidate.expectedAttemptCount } },
      { new: true, timestamps: false, writeConcern: WC }).lean();
    if (!started) return;
    try {
      await control.launch({ pipelineId: task.pipelineId, requestId: run.requestId, expectedAttemptCount: candidate.expectedAttemptCount,
        ...(run.executorId && { executorId: run.executorId }),
        confirm: true, reportName: task.codingResult.reportName, modelCallLimit: task.codingResult.modelCallLimit,
        parentRequestId: run.parentRequestId, parentSha256: run.parentSha256 });
    } catch (error) {
      // An unknown answer is observed on the next tick under the same id.
      if (error.code !== 'CODING_DISPATCH_OUTCOME_UNKNOWN') await block(started, run, error.code || 'launch_refused', 'execution_failed');
    }
    return;
  }
  if (host.run && (host.run.pipelineId !== task.pipelineId || host.run.requestId !== run.requestId)) {
    await block(task, run, 'runner_identity_mismatch', 'outcome_unknown'); return;
  }
  const receipt = host.run?.progress;
  if (receipt?.phase === 'finished' && receipt.coreRecorded === true) {
    const state = task.reportContinuation;
    await saveState(task, { ...state, state: 'idle', reason: null, runs: state.runs.map(item => item.requestId === run.requestId
      ? { ...item, finishedAt: new Date().toISOString(), result: receipt.result, stopReason: receipt.stopReason || null } : item) });
    await clearActive(run.requestId);
    return;
  }
  if (['unknown', 'uncertain'].includes(host.run?.phase)) {
    try { await control.reconcile({ pipelineId: task.pipelineId, requestId: run.requestId }); return; }
    catch { await block(task, run, 'runner_outcome_unknown', 'outcome_unknown'); }
  }
}

async function tick() {
  if (!control) return;
  const config = await settings();
  if (config.active) return dispatch(config.active, config);
  // Outcome alerts are published with the switch off too; only launching
  // a continuation needs it on.
  return select(config);
}

async function configureSwitch(input) {
  if (input.confirm !== true || typeof input.enabled !== 'boolean' || !Number.isInteger(input.expectedRevision))
    throw fail('Confirm the switch and its current revision', 'REPORT_CONTINUATION_INVALID', 400);
  if (input.enabled && (!control || control.target === '')) throw fail('The coding runner is unavailable', 'REPORT_CONTINUATION_UNAVAILABLE', 503);
  const current = await settings();
  const saved = await Settings.findOneAndUpdate({ _id: ID, revision: input.expectedRevision },
    { $set: { enabled: input.enabled, actor: 'operator' }, $inc: { revision: 1 } },
    { new: true, upsert: current.revision === 0 && input.expectedRevision === 0, writeConcern: WC }).lean();
  if (!saved) throw fail('The continuation switch changed; refresh it', 'REPORT_CONTINUATION_CHANGED', 409);
  return { enabled: saved.enabled, revision: saved.revision, active: saved.active || null };
}

async function status() {
  const config = await settings();
  return { enabled: config.enabled === true, revision: config.revision || 0, active: config.active || null,
    available: Boolean(control && control.target !== ''), escalation: await require('./pipelineReportEscalation').policy() };
}

module.exports = { configure, tick, configureSwitch, status, decide, decision, continuationId, allowance, wouldContinue, CONTINUE_REASONS };
