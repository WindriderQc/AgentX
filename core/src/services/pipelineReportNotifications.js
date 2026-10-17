'use strict';

/**
 * Owner alerts for private reports (#835). One stable alert per report outcome
 * and kind, so a repeated observation never duplicates it and acknowledgment
 * survives restarts. They appear in the existing Core alert feed, the morning
 * brief and Nestor's work-queue notifications.
 */

const crypto = require('node:crypto');
const Alert = require('../../models/Alert');
const RULE = 'pipeline_report';
const WC = { w: 1, j: true };
// Alerts already written by this process; the stable id makes a second write
// harmless, this only avoids repeating it on every 15-second observation.
const written = new Set();

const KINDS = Object.freeze({
  documents_blocked: { severity: 'warning', title: 'Report documents blocked',
    message: d => `${d.paths.length} document${d.paths.length === 1 ? '' : 's'} failed two review steps and need attention: ${d.paths.slice(0, 5).join(', ')}${d.paths.length > 5 ? '…' : ''}.` },
  execution_failed: { severity: 'warning', title: 'Report execution stopped',
    message: d => `The worker stopped with "${d.reason}". Read its saved report before any relaunch; automatic continuation does not retry this.` },
  no_progress: { severity: 'warning', title: 'Report made no progress',
    message: () => 'Two executions in a row ended with the same saved report. Automatic continuation stopped for this task.' },
  needs_grant: { severity: 'info', title: 'Report waits for a new grant or window',
    message: d => ({
      grant_runs_used: 'The current grant has no execution left.',
      credits_exhausted: 'The cumulative calls or work time granted are used.',
      campaign_window_closed: 'The approved campaign window is not open.',
      no_grant: 'No report grant exists for this task.'
    }[d.reason] || d.reason) + ' Grant more or approve a window to continue the saved report.' },
  outcome_unknown: { severity: 'error', title: 'Report continuation outcome unknown',
    message: () => 'The automatic continuation could not prove what happened. Reconcile the same request; nothing will relaunch it.' },
  escalated: { severity: 'info', title: 'Report step escalated to a cloud model',
    message: d => `Step ${d.step} was retried on ${d.model} after failing locally (cost $${Number(d.usd || 0).toFixed(4)}). Its findings are marked in the report.` },
  completed: { severity: 'info', title: 'Report ready for review',
    message: () => 'Every document is reviewed or explicitly blocked. The report waits for independent review.' }
});

function alertId(fingerprint) {
  return crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);
}

/** Record one alert for `requestId` and `kind`; repeated calls are no-ops. */
async function publish(task, kind, requestId, details = {}) {
  const spec = KINDS[kind];
  if (!spec || !task?.pipelineId || !requestId) return null;
  const fingerprint = `pipeline-report:${task.pipelineId}:${requestId}:${kind}`;
  const id = alertId(fingerprint);
  if (written.has(id)) return id;
  const now = new Date();
  const changes = { ruleId: RULE, ruleName: 'Private reports', fingerprint, severity: spec.severity, status: 'active',
    title: `${spec.title} — task ${task.pipelineId}`, message: spec.message(details),
    context: { component: 'pipeline-report', relatedEvents: [requestId], additionalData: {
      pipelineId: task.pipelineId, requestId, kind, path: `/pipeline?task=${encodeURIComponent(task.pipelineId)}`, ...details } },
    channels: [], firstOccurrence: now, lastOccurrence: now };
  try { await Alert.updateOne({ _id: id }, { $setOnInsert: changes }, { upsert: true, writeConcern: WC }); }
  catch (error) { if (error.code !== 11000) throw error; }
  written.add(id);
  return id;
}

module.exports = { publish, RULE, KINDS, alertId, _forget: () => written.clear() };
