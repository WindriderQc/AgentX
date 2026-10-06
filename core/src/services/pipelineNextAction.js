'use strict';

const { describePipelineFailures } = require('../../../shared/failureDiagnostics');
const { taskEligibilityReasons } = require('./pipelineTaskEligibility');
const workerTaskScope = require('../helpers/workerTaskScope');
const STALE_HEARTBEAT_MS = 60 * 60 * 1000;

function timestamp(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

// Observation only: neither elapsed time nor a receipt grants effect authority.
function taskNextAction(task, { now = new Date(), dependencyStatuses = new Map(), staleHeartbeatMs = STALE_HEARTBEAT_MS } = {}) {
  const attempts = Array.isArray(task.automationAttempts) ? task.automationAttempts : [];
  const latest = attempts.reduce((result, attempt) => !result || Number(attempt.attempt) > Number(result.attempt) ? attempt : result, null);
  const heartbeat = timestamp(task.heartbeatAt);
  const freshness = !heartbeat || heartbeat > now ? 'unknown'
    : now - heartbeat > staleHeartbeatMs ? 'stale' : 'fresh';
  const evidenceDates = [heartbeat, timestamp(latest?.completedAt), timestamp(latest?.reviewedAt)]
    .filter(date => date && date <= now).sort((a, b) => b - a);
  const base = { schema: 'agentx.pipeline-next-action/v1', authority: 'core.pipeline',
    observedAt: now.toISOString(), lastEvidenceAt: evidenceDates[0]?.toISOString() || null,
    heartbeatFreshness: task.status === 'in_progress' ? freshness : 'not_applicable',
    authorization: 'not_granted', reference: /^\d{3,4}$/.test(task.pipelineId) ? `/pipeline?task=${task.pipelineId}` : null,
    diagnostics: [], attention: false, rank: 9, icon: 'fa-circle-info', tone: 'attention' };
  const action = (code, actor, label, detail, next, extra = {}) => ({ ...base, code, actor, label, detail, action: next, ...extra });
  if (task.status === 'done') return action('none', 'none', 'Closed task record',
    'Closure is recorded; it does not prove merge, deployment or device acceptance.', 'Consult the separate delivery receipts.');
  if (task.status === 'blocked') {
    const diagnostics = describePipelineFailures(latest?.evidence);
    return action('inspect_blocker', 'human', 'Blocked task needs inspection',
      diagnostics.length ? `Recorded failure category: ${diagnostics[0].category}.` : 'The blocking cause has no structured evidence.',
      'Inspect the dossier and reconcile the recorded effects before deciding a correction or retry.',
      { attention: true, rank: 0, icon: 'fa-hand', tone: 'blocked', diagnostics });
  }
  if (task.status === 'review') {
    const receipt = Boolean(latest?.completedAt && latest?.evidence?.schema && latest.finalState === 'review');
    return action('human_review', 'human', receipt ? 'Human review required · Coding Team receipt present' : 'Human review required · interactive task',
      receipt ? 'A guarded attempt receipt is ready for an independent human decision.' : 'This task has no current automated attempt receipt. Inspect the recorded work directly.',
      'Inspect the dossier, then record an independent decision. Merge and deployment remain separate.',
      { attention: true, rank: 1, icon: 'fa-magnifying-glass', tone: 'review', receiptPresent: receipt });
  }
  if (task.status === 'in_progress') {
    if (!task.assignee) return action('inspect_owner', 'human', 'In progress without owner',
      'The task state has no assignee; worker activity is unknown.',
      'Inspect the claim and recorded effects before assigning or re-queuing.', { attention: true, rank: 2, icon: 'fa-user-slash' });
    const leaseExpiry = timestamp(task.automationLease?.expiresAt);
    if (leaseExpiry && leaseExpiry <= now) return action('inspect_worker', 'human', 'Automation lease expired · worker state unknown',
      'Core refuses late results from this lease, but expiry does not prove that execution stopped.',
      'Inspect the worker and recorded effects before re-queuing or deciding any recovery.', { attention: true, rank: 3, icon: 'fa-heart-crack' });
    if (freshness !== 'fresh') return action('inspect_worker', 'human',
      freshness === 'stale' ? 'Stale heartbeat · worker state unknown' : 'Heartbeat unavailable · worker state unknown',
      'A missing, future or old heartbeat does not prove that execution stopped.',
      'Inspect the worker and recorded effects before deciding any recovery.', { attention: true, rank: 3, icon: 'fa-heart-crack' });
    if (!timestamp(task.dueAt) || timestamp(task.dueAt) >= now) return action('observe_progress', 'worker', 'Recent heartbeat observed',
      'A recent heartbeat was recorded; it does not prove current execution or completion.', 'Observe the existing task and attempt evidence.');
  }
  if (task.status === 'queued') {
    if (!workerTaskScope.contains(task)) return action('human_lane', 'human', 'Human task lane',
      'This task is outside the coding worker queue.', 'Review it in its existing human workflow.');
    const reasons = taskEligibilityReasons(task, { now, dependencyStatuses });
    if (reasons.some(reason => reason.code === 'not_before')) return action('wait_not_before', 'worker', 'Deferred task',
      'The earliest claim time has not arrived.', 'Wait for the recorded not-before time; claim revalidates the task.');
    if (reasons.some(reason => reason.code === 'dependencies_incomplete')) return action('inspect_dependencies', 'human', 'Dependencies incomplete or unavailable',
      'The scoped dependency records do not all show done.', 'Inspect the dependencies in the task dossier.', { attention: true, rank: 5 });
    if (task.codingCapacity) return action('wait_coding_capacity', 'worker', 'Waiting for coding model capacity',
      task.codingCapacity.reason || 'The selected model host is being reserved.',
      'Resume the same launch request when capacity is available, or cancel its wait.',
      { capacity: { model: task.codingCapacity.model, host: task.codingCapacity.host,
        waitingSince: task.codingCapacity.waitingSince, requestId: task.codingCapacity.requestId } });
  }
  if (task.status !== 'done' && timestamp(task.dueAt) && timestamp(task.dueAt) < now) return action('review_due_date', 'human', 'Past due',
    'The recorded due date has passed.', 'Review priority and the due date deliberately.', { attention: true, rank: 4, icon: 'fa-hourglass-end' });
  if (task.status === 'queued') return action('await_claim', 'worker', 'Queued · manual claim conditions observed',
    'Observed queue conditions do not grant permission to launch automation.', 'Use the eligibility read for automation policy; claim revalidates current state.');
  return action('inspect_state', 'human', 'Task state unknown', 'No supported task state is recorded.', 'Inspect the authoritative task record.');
}

module.exports = { taskNextAction, STALE_HEARTBEAT_MS };
