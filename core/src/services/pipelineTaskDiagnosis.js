'use strict';

const crypto = require('crypto');
const workerTaskScope = require('../helpers/workerTaskScope');
const { taskEligibilityReasons } = require('./pipelineTaskEligibility');
const { leaseReference } = require('./pipelineEvidenceReferences');
const { STALE_HEARTBEAT_MS } = require('./pipelineNextAction');

// Read-only answer to "why is this task not advancing?". It classifies the
// recorded state, names who owns the next step and which evidence is missing,
// and never changes a task, a lease or the automation slot. Elapsed time, an
// expired lease or an old heartbeat never prove that a worker stopped, and a
// task status never proves the fate of a runtime (GPU/Ollama) operation:
// runtime recovery stays a separate owner and is not consulted here.
const SCHEMA = 'agentx.pipeline-task-diagnosis/v1';
const CATEGORIES = ['execution_observed', 'planned_wait', 'human_decision', 'dependency',
  'recovery_required', 'unknown', 'closed'];
// Only ambiguous states escalate. Their key is derived from durable task state,
// so repeated reads of the same situation yield the same key and a consumer
// escalates it once; a new episode (new attempt, lease, heartbeat or status
// transition) yields a new key.
const ESCALATING = new Set(['recovery_required', 'unknown']);
const HUMAN_ADMISSION = new Set(['automation_invalid', 'risk_not_low', 'attempt_budget_exhausted', 'protected_scope']);
const WAIT_ADMISSION = new Set(['resource_lock_conflict', 'automation_slot_occupied']);
const RUNTIME_BOUNDARY = 'A task status does not prove the fate of a runtime (GPU/Ollama) operation. '
  + 'Runtime recovery has its own owner and journal and is not consulted by this diagnosis.';

const MISSING = {
  worker_process: 'Worker process state on its host (no host observation is read by Core)',
  external_effects: 'Recorded external effects of the attempt (branch, commits, PR)',
  attempt_receipt: 'Final attempt receipt from the worker',
  heartbeat: 'A recorded worker heartbeat',
  recent_heartbeat: 'A heartbeat newer than the staleness threshold',
  claim_owner: 'The owner (assignee) of this claim',
  failure_evidence: 'Structured failure evidence for the blocking cause',
  dependency_record: 'A task record for every declared dependency',
  slot_consistency: 'An automation slot that names the same lease as the task',
  runtime_outcome: 'Runtime operation outcome (owned by runtime recovery, not by the Pipeline)',
};

function timestamp(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}
const iso = value => timestamp(value)?.toISOString() || null;
// When the current status was entered, from the transition log; legacy records
// without a log fall back to their last update time.
const statusSince = task => iso((Array.isArray(task.transitions) ? task.transitions : []).at(-1)?.at) || iso(task.updatedAt);
const missing = codes => codes.map(code => ({ code, label: MISSING[code] }));

function latestAttempt(task) {
  const attempts = Array.isArray(task.automationAttempts) ? task.automationAttempts : [];
  return attempts.reduce((best, item) => (!best || Number(item?.attempt) > Number(best.attempt) ? item : best), null);
}

/** Durable state a later guarded mutation must still match (compare-and-set). */
function observedVersion(task) {
  const lease = task.automationLease?.leaseId ? task.automationLease : null;
  const seq = Number(task.transitionSeq);
  return {
    status: task.status ?? null,
    transitionSeq: Number.isSafeInteger(seq) && seq > 0 ? seq : null,
    automationAttemptCount: Number(task.automationAttemptCount || 0),
    assignee: task.assignee ?? null,
    heartbeatAt: iso(task.heartbeatAt),
    attempt: lease ? Number(lease.attempt) || null : null,
    leaseRef: lease ? leaseReference(lease.leaseId) : null,
    leaseExpiresAt: lease ? iso(lease.expiresAt) : null,
  };
}

/**
 * Mongo filter that matches the task only while it is still in the diagnosed
 * version. No route applies a repair today; any future repair must use this
 * guard so a concurrent heartbeat, lease renewal, claim or status transition
 * makes it match nothing instead of overwriting newer state.
 */
function repairGuardQuery(pipelineId, version) {
  const query = {
    pipelineId,
    status: version.status,
    transitionSeq: version.transitionSeq,
    automationAttemptCount: version.automationAttemptCount,
    assignee: version.assignee,
    heartbeatAt: version.heartbeatAt ? new Date(version.heartbeatAt) : null,
  };
  if (!version.automationAttemptCount) delete query.automationAttemptCount;
  query['automationLease.expiresAt'] = version.leaseExpiresAt ? new Date(version.leaseExpiresAt) : null;
  return query;
}

// The key names the episode, not the moment: an active lease renewing or a
// note being added does not create a new escalation, while a new attempt,
// lease, status transition or (for heartbeat cases) a new heartbeat does.
function escalationFor(pipelineId, code, version, since) {
  const episode = code.startsWith('heartbeat_') ? version.heartbeatAt : code === 'lease_expired' ? version.leaseExpiresAt : null;
  const material = [SCHEMA, pipelineId, code, version.status, version.transitionSeq ?? '-',
    version.attempt ?? '-', version.leaseRef ?? '-', episode ?? '-'].join('\0');
  return {
    key: `esc-${crypto.createHash('sha256').update(material).digest('hex').slice(0, 16)}`,
    since,
    once: 'Derived from durable task state: repeated reads return the same key; escalate a key once.',
  };
}

function heartbeatState(task, now, staleHeartbeatMs) {
  const heartbeat = timestamp(task.heartbeatAt);
  if (!heartbeat) return { state: 'absent', at: null };
  if (heartbeat > now) return { state: 'future', at: heartbeat };
  return { state: now - heartbeat > staleHeartbeatMs ? 'stale' : 'recent', at: heartbeat };
}

function dependencyView(task, dependencies) {
  const rows = (task.dependsOn || []).map((id) => {
    const record = dependencies.get(id);
    return { ref: `task-${id}`, pipelineId: id, status: record?.status || 'missing' };
  });
  return {
    rows,
    missing: rows.filter(row => row.status === 'missing'),
    blocked: rows.filter(row => row.status === 'blocked'),
    open: rows.filter(row => row.status !== 'done'),
  };
}

function inProgress(task, { now, staleHeartbeatMs, slot, version }) {
  const beat = heartbeatState(task, now, staleHeartbeatMs);
  const worker = { heartbeat: beat.state, heartbeatAt: iso(beat.at), state: 'unknown' };
  const lease = task.automationLease?.leaseId ? task.automationLease : null;
  if (!task.assignee) {
    return { category: 'unknown', code: 'owner_missing', owner: 'operator', worker,
      summary: 'In progress without an assignee; nobody is recorded as doing the work.',
      action: 'Inspect the claim and any recorded effects, then decide deliberately whether to re-queue.',
      missingEvidence: missing(['claim_owner', 'external_effects']), since: statusSince(task) };
  }
  if (lease) {
    const expiresAt = timestamp(lease.expiresAt);
    const leaseState = expiresAt && expiresAt > now ? 'active' : 'expired';
    const extra = { lease: { state: leaseState, ref: version.leaseRef, attempt: version.attempt, expiresAt: iso(expiresAt) } };
    if (leaseState === 'expired') {
      return { category: 'recovery_required', code: 'lease_expired', owner: 'operator', worker, ...extra,
        summary: 'The automation lease expired. Core refuses late results from it, but expiry does not prove the worker stopped.',
        action: 'Inspect the worker host and the attempt\'s recorded effects before re-queuing or blocking the task.',
        missingEvidence: missing(['worker_process', 'external_effects', 'attempt_receipt', 'runtime_outcome']),
        since: iso(expiresAt) };
    }
    const slotLease = slot?.leaseId ? leaseReference(slot.leaseId) : null;
    if (slot !== undefined && slotLease !== version.leaseRef) {
      return { category: 'unknown', code: 'slot_mismatch', owner: 'operator', worker, ...extra,
        slot: { leaseRef: slotLease },
        summary: 'The task holds an active lease that the automation slot does not name.',
        action: 'Refresh once; if the mismatch persists, inspect the dispatcher before any launch or recovery.',
        missingEvidence: missing(['slot_consistency', 'worker_process']), since: iso(lease.acquiredAt) };
    }
    worker.state = 'lease_renewed';
    const budgetMs = Number(task.automation?.budgets?.maxDurationMs);
    const acquiredAt = timestamp(lease.acquiredAt);
    const elapsedMs = acquiredAt ? Math.max(0, now - acquiredAt) : null;
    const overBudget = Number.isFinite(budgetMs) && elapsedMs != null && elapsedMs > budgetMs;
    return { category: 'execution_observed', code: overBudget ? 'lease_active_over_budget' : 'lease_active',
      owner: 'worker', worker, ...extra, elapsedMs, budgetMs: Number.isFinite(budgetMs) ? budgetMs : null,
      summary: overBudget
        ? 'The worker keeps renewing its lease but has run longer than the attempt duration budget.'
        : 'The worker renewed its lease recently; this shows activity, not progress or completion.',
      action: overBudget
        ? 'Observe the attempt; a slow worker is not a dead one. Decide deliberately if it should be stopped on its host.'
        : 'Wait for the worker verdict; the lease expiry bounds how long its silence can last.',
      missingEvidence: missing(['attempt_receipt']), since: iso(acquiredAt) };
  }
  if (beat.state === 'recent') {
    worker.state = 'heartbeat_recent';
    return { category: 'execution_observed', code: 'heartbeat_recent', owner: 'worker', worker,
      summary: 'An interactive worker heartbeat was recorded recently; it does not prove progress.',
      action: 'Wait for the worker verdict or its next heartbeat.', missingEvidence: [], since: iso(beat.at) };
  }
  const absent = beat.state !== 'stale';
  return { category: 'unknown', code: absent ? 'heartbeat_absent' : 'heartbeat_stale', owner: 'operator', worker,
    summary: absent ? 'The claim has no usable heartbeat; worker activity was never observed.'
      : 'The last heartbeat is old; the worker may be stopped, slow or disconnected.',
    action: `Ask ${task.assignee} or inspect its host and recorded effects before re-queuing.`,
    missingEvidence: missing([absent ? 'heartbeat' : 'recent_heartbeat', 'worker_process', 'external_effects']),
    since: beat.state === 'stale' ? new Date(beat.at.getTime() + staleHeartbeatMs).toISOString() : statusSince(task) };
}

function queued(task, { now, dependencies, slot }) {
  if (task.assignee || task.automationLease?.leaseId) {
    return { category: 'recovery_required', code: 'queued_with_owner', owner: 'operator',
      summary: 'Queued while still naming an owner or lease; no worker can claim it.',
      action: 'Inspect the previous owner\'s recorded effects, then re-queue it through the guarded status action.',
      missingEvidence: missing(['worker_process', 'external_effects']), since: statusSince(task) };
  }
  const deps = dependencyView(task, dependencies);
  const dependencyStatuses = new Map([...dependencies].map(([id, row]) => [id, row.status]));
  const automated = task.automation?.mode === 'review_only';
  const reasons = taskEligibilityReasons(task, { now, dependencyStatuses, automated });
  if (automated && slot?.leaseId && timestamp(slot.expiresAt) > now) reasons.push({ code: 'automation_slot_occupied' });
  const codes = reasons.map(reason => reason.code);
  const base = { dependencies: deps.rows, eligibility: codes };
  if (deps.missing.length) {
    return { ...base, category: 'unknown', code: 'dependency_missing', owner: 'operator',
      summary: `Dependency record(s) missing: ${deps.missing.map(row => row.pipelineId).join(', ')}.`,
      action: 'Edit the task dependencies deliberately; the task cannot become eligible otherwise.',
      missingEvidence: missing(['dependency_record']), since: statusSince(task) };
  }
  if (deps.blocked.length) {
    return { ...base, category: 'dependency', code: 'dependency_blocked', owner: 'human',
      rootRefs: deps.blocked.map(row => row.ref),
      summary: `Waiting on blocked dependency ${deps.blocked.map(row => row.pipelineId).join(', ')}.`,
      action: 'Resolve the blocked dependency; it is escalated on its own task, not repeated here.', missingEvidence: [] };
  }
  if (deps.open.length) {
    return { ...base, category: 'dependency', code: 'dependency_pending', owner: 'dependency_owner',
      rootRefs: deps.open.map(row => row.ref),
      summary: `Waiting on ${deps.open.map(row => `${row.pipelineId} (${row.status.replace(/_/g, ' ')})`).join(', ')}.`,
      action: 'No action here; the dependencies advance through their own owners.', missingEvidence: [] };
  }
  if (codes.includes('not_before')) {
    return { ...base, category: 'planned_wait', code: 'not_before', owner: 'worker',
      summary: `Deferred until ${iso(task.notBefore)}.`, action: 'Wait; claim revalidates the task after that time.',
      missingEvidence: [], until: iso(task.notBefore) };
  }
  const human = codes.filter(code => HUMAN_ADMISSION.has(code));
  if (human.length) {
    return { ...base, category: 'human_decision', code: human[0], owner: 'human',
      summary: `Coding automation cannot admit this task: ${human.join(', ').replace(/_/g, ' ')}.`,
      action: 'Correct the automation policy, budget or scope, or run it as a manual task.', missingEvidence: [] };
  }
  if (task.codingCapacity) return { ...base, category: 'planned_wait', code: 'coding_capacity_wait', owner: 'worker',
    summary: task.codingCapacity.reason || 'Waiting for the selected coding model host.',
    action: 'Resume the same launch request when capacity is available, or cancel its wait.', missingEvidence: [] };
  if (codes.some(code => WAIT_ADMISSION.has(code))) {
    return { ...base, category: 'planned_wait', code: codes.find(code => WAIT_ADMISSION.has(code)), owner: 'worker',
      summary: 'Waiting for a shared resource or the automation slot held by another attempt.',
      action: 'Wait for the other attempt to finish; launch and claim revalidate current state.', missingEvidence: [] };
  }
  return { ...base, category: 'planned_wait', code: 'awaiting_claim', owner: automated ? 'operator' : 'worker',
    summary: automated ? 'Admissible for a guarded launch; no launch has been requested.' : 'Waiting for a worker claim.',
    action: automated ? 'Launch it from the Coding Team panel when you decide to.' : 'A worker claims it through the queue.',
    missingEvidence: [] };
}

function classify(task, context) {
  // Private lanes (family, personal, household, secretary, idea drops) follow
  // their own workflow: a household routine is normally queued with its lane
  // as assignee. The engineering diagnosis never interprets their state.
  if (!workerTaskScope.contains(task)) {
    return { category: 'human_decision', code: 'human_lane', owner: 'human', scope: 'private',
      summary: 'A private task lane with its own workflow; the engineering diagnosis does not interpret it.',
      action: 'Handle it in its own human workflow.', missingEvidence: [] };
  }
  if (task.status === 'done') {
    return { category: 'closed', code: 'closed', owner: 'none', summary: 'Closed task record.',
      action: 'None. Closure does not prove merge, deployment or device acceptance.', missingEvidence: [] };
  }
  if (task.status === 'review') {
    const attempt = latestAttempt(task);
    const receipt = Boolean(attempt?.completedAt && attempt?.evidence?.schema && attempt.finalState === 'review');
    return { category: 'human_decision', code: 'human_review', owner: 'human',
      summary: receipt ? 'A worker verdict with an attempt receipt waits for human review.' : 'A result waits for human review.',
      action: 'Inspect the dossier and record an independent decision.', missingEvidence: receipt ? [] : missing(['attempt_receipt']) };
  }
  if (task.status === 'blocked') {
    const failures = latestAttempt(task)?.evidence?.failureCodes;
    return { category: 'human_decision', code: 'blocked', owner: 'human',
      summary: 'Blocked; a human decides the correction, a retry or supersession.',
      action: 'Inspect the blocker and the recorded effects before requeueing or closing.',
      missingEvidence: Array.isArray(failures) && failures.length ? [] : missing(['failure_evidence']) };
  }
  if (task.status === 'in_progress') return inProgress(task, context);
  if (task.status === 'queued') return queued(task, context);
  return { category: 'unknown', code: 'unsupported_status', owner: 'operator', summary: 'No supported task status is recorded.',
    action: 'Inspect the authoritative task record.', missingEvidence: [], since: statusSince(task) };
}

/**
 * @param {object} task lean PipelineTask document (lease id stays server-side)
 * @param {object} options
 * @param {Map<string,{status:string}>} options.dependencies dependency records by pipelineId
 * @param {object|null|undefined} options.slot automation slot document; undefined when not read
 */
function diagnoseTask(task, { now = new Date(), dependencies = new Map(), slot, staleHeartbeatMs = STALE_HEARTBEAT_MS } = {}) {
  const version = observedVersion(task);
  const result = classify(task, { now, dependencies, slot, staleHeartbeatMs, version });
  const { since = null, ...details } = result;
  const escalation = ESCALATING.has(result.category) ? escalationFor(task.pipelineId, result.code, version, since) : null;
  const due = timestamp(task.dueAt);
  return {
    schema: SCHEMA,
    pipelineId: task.pipelineId,
    taskRef: `task-${task.pipelineId}`,
    observedAt: now.toISOString(),
    authority: 'core.pipeline',
    authorization: 'not_granted',
    repair: 'none',
    ...details,
    ...(due && due < now && task.status !== 'done' ? { overdueSince: due.toISOString() } : {}),
    observedVersion: version,
    escalation,
    runtime: { consulted: false, boundary: RUNTIME_BOUNDARY },
  };
}

module.exports = { SCHEMA, CATEGORIES, MISSING, diagnoseTask, observedVersion, repairGuardQuery };
