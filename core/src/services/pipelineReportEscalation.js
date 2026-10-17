'use strict';

/**
 * Cloud escalation of a failed report step (#835).
 *
 * The owner switches it on globally (off by default) and allows it per task on
 * the explicit report grant. An execution started with both records its
 * ordered models and the task's remaining cost allowance, fixed for that run.
 * The runner may then send one large single-shot verification request for a
 * group that already failed locally; Core executes it through OpenClaw's
 * single-call model mode, trying the models in order, with OpenClaw's own cost
 * reservation capped by what the task has left, and journals every call.
 */

const Settings = require('../../models/PipelineReportContinuation');
const Run = require('../../models/PipelineReportRun');
const { fail } = require('./pipelineManualReportClaim');

const ID = 'report-continuation';
const WC = { w: 1, j: true };
const NANO = 1e9;
const MODEL = /^[a-z0-9-]+\/[A-Za-z0-9._:/-]{1,120}$/;

async function policy() {
  const doc = await Settings.findById(ID).lean();
  const escalation = doc?.escalation || {};
  return {
    enabled: escalation.enabled === true,
    models: Array.isArray(escalation.models) && escalation.models.length ? escalation.models
      : ['openai/gpt-5.6-sol', 'openrouter/nvidia/nemotron-3-super-120b-a12b:free'],
    maxCostUsdPerTask: Number.isFinite(escalation.maxCostUsdPerTask) ? escalation.maxCostUsdPerTask : 10,
    revision: escalation.revision || 0
  };
}

/** Nanodollars already spent on escalation by every execution of the task. */
async function spentNanodollars(taskId) {
  const runs = await Run.find({ taskId: String(taskId), 'escalationCalls.0': { $exists: true } }).select('escalationCalls').lean();
  return runs.reduce((total, run) => total + run.escalationCalls.reduce((sum, call) => sum + (Number(call.nanodollars) || 0), 0), 0);
}

/** The escalation an execution of `task` may use, or undefined. */
async function forRun(task) {
  const current = await policy();
  const grant = task.codingReportAuthority?.grants?.at(-1);
  if (!current.enabled || grant?.allowCloudEscalation !== true) return undefined;
  const remaining = Math.floor(current.maxCostUsdPerTask * NANO) - await spentNanodollars(task._id);
  if (remaining <= 0) return undefined;
  return { models: current.models, maxCostNanodollars: remaining, policyRevision: current.revision };
}

/** Refuse an escalated call that this execution does not allow. */
function assertCall(run, model) {
  const escalation = run.escalation;
  if (!escalation || !escalation.models.includes(model))
    throw fail('This report execution does not allow that escalation model', 'REPORT_ESCALATION_REFUSED', 403);
  const spent = (run.escalationCalls || []).reduce((sum, call) => sum + (Number(call.nanodollars) || 0), 0);
  if (spent >= escalation.maxCostNanodollars) throw fail('The task escalation cost cap is reached', 'REPORT_ESCALATION_BUDGET', 409);
  return escalation.maxCostNanodollars - spent;
}

/**
 * Execute one escalated call. Models are tried in order from the requested
 * one; a model OpenClaw refuses or cannot reach yields to the next. Returns an
 * Ollama-shaped chat body and journals the model that answered and its cost.
 */
async function execute({ identity, messages, maxTokens, requestId, remainingNanodollars, signal, timeoutMs },
  deps = {}) {
  const run = deps.run || (async inference => require('./execution/openclawInference').executeOpenClawInference(inference, { signal, timeoutMs }));
  const value = await Run.findById(identity.requestId).select('escalation escalationCalls').lean();
  const models = value.escalation.models.slice(value.escalation.models.indexOf(identity.model));
  const attempts = [];
  for (const model of models) {
    try {
      const result = await run({ mode: 'chat', model: `openclaw:model:${model}`, messages, stream: false, requestId,
        options: { num_predict: maxTokens, temperature: 0 }, budget: { maxCalls: 1, maxCostNanodollars: remainingNanodollars } });
      if (!result.ok) throw Object.assign(new Error('Escalation model refused the request'), { code: result.body?.error?.code || `HTTP_${result.status}` });
      const receipt = result.metadata?.receipt || result.body?.executionReceipt || {};
      const call = { callId: identity.callId, step: identity.step, model, attempts, at: new Date().toISOString(),
        nanodollars: Number(receipt.cost?.nanodollars) || 0, costSource: receipt.cost?.source || 'none',
        billing: receipt.billing?.kind || null, usage: receipt.usage || null };
      await Run.updateOne({ _id: identity.requestId }, { $push: { escalationCalls: call } }, { writeConcern: WC });
      await require('./pipelineReportNotifications').publish({ pipelineId: identity.pipelineId }, 'escalated', identity.requestId,
        { model, step: identity.step, usd: call.nanodollars / NANO }).catch(() => null);
      return { body: result.body, model, call };
    } catch (error) {
      if (signal?.aborted) throw error;
      attempts.push({ model, code: String(error.code || 'ESCALATION_FAILED').slice(0, 80) });
    }
  }
  throw Object.assign(new Error('No escalation model answered'), { code: 'REPORT_ESCALATION_UNAVAILABLE', statusCode: 502, attempts });
}

async function configure(input) {
  if (input.confirm !== true || typeof input.enabled !== 'boolean' || !Number.isInteger(input.expectedRevision))
    throw fail('Confirm the escalation switch and its current revision', 'REPORT_ESCALATION_INVALID', 400);
  const models = input.models === undefined ? undefined : input.models;
  if (models !== undefined && (!Array.isArray(models) || !models.length || models.length > 4 || models.some(model => !MODEL.test(model))))
    throw fail('Name one to four provider/model ids in order', 'REPORT_ESCALATION_INVALID', 400);
  const cap = input.maxCostUsdPerTask;
  if (cap !== undefined && (!Number.isFinite(cap) || cap < 0 || cap > 1000))
    throw fail('The cost cap per task must be between 0 and 1000 dollars', 'REPORT_ESCALATION_INVALID', 400);
  const set = { 'escalation.enabled': input.enabled, actor: 'operator', ...(models && { 'escalation.models': models }),
    ...(cap !== undefined && { 'escalation.maxCostUsdPerTask': cap }) };
  const current = await policy();
  const saved = await Settings.findOneAndUpdate(
    { _id: ID, ...(current.revision ? { 'escalation.revision': input.expectedRevision } : {}) },
    { $set: set, $inc: { 'escalation.revision': 1 } },
    { new: true, upsert: current.revision === 0 && input.expectedRevision === 0, writeConcern: WC }).lean();
  if (!saved || (current.revision && saved.escalation.revision !== input.expectedRevision + 1))
    throw fail('The escalation policy changed; refresh it', 'REPORT_ESCALATION_CHANGED', 409);
  return policy();
}

module.exports = { policy, forRun, assertCall, execute, configure, spentNanodollars, NANO };
