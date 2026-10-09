'use strict';
const { createHash } = require('node:crypto');

// Structured, versioned plans for a canonical task. A plan revision is data:
// recording one, reading one or deciding on one never starts work, changes the
// automation intent or passes a PR gate. Execution keeps its existing, separate
// authority (Core's automation intent plus an explicit one-shot launch).
//
// A decision lives inside the exact revision it concerns and records the plan
// fingerprint, the automation scope fingerprint and the task basis it was made
// against. A newer revision therefore starts undecided, and a decision whose
// scope or basis has since changed is reported as stale, never as current.
const SCHEMA = 'agentx.pipeline-task-plan/v1';
const MODES = ['plan', 'research'];
const OUTCOMES = ['approved', 'changes_requested'];
const CHANNELS = ['task_preparation', 'plan_api', 'operator_api'];
const MAX_PLAN_CHARS = 8000;
const MAX_STEPS = 30;
const MAX_STEP_CHARS = 500;
const MAX_SCOPE_PATHS = 50;
const PRIVATE_LANES = ['personal', 'family', 'household', 'secretary'];
const SUBMIT_KEYS = ['expectedRevision', 'mode', 'text', 'steps', 'by'];
const DECISION_KEYS = ['revision', 'planFingerprint', 'outcome', 'by', 'reason'];
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

function planError(message, status = 400, code = 'INVALID_PLAN') {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}

function sha256(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

// Keep line breaks and tabs; drop other control characters.
function cleanText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}

function bounded(value, max) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length > max) throw planError(`The complete field exceeds ${max} characters.`, 413, 'PLAN_TOO_LONG');
  return text || null;
}

// What the plan was written against: the task's own request, not its
// scheduling fields. Editing title, spec or service changes the basis.
function basisRef(task = {}) {
  return sha256([task.title ?? null, task.spec ?? null, task.service ?? null]);
}

function currentRevision(task = {}) {
  const value = Number(task.planRevision);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isPrivateLane(task = {}) {
  return PRIVATE_LANES.includes(String(task.service || '').toLowerCase());
}

function strictKeys(body, allowed, label) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw planError(`${label} must be an object`);
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw planError(`${label} accepts only ${allowed.join(', ')}; unsupported: ${unknown.join(', ')}`, 400, 'PLAN_FIELD_UNSUPPORTED');
  }
}

/**
 * Validate an API plan submission. Oversized plans are refused rather than
 * silently cut, so a reviewer never approves a text that differs from what the
 * author sent. Only the explicit `mode` field sets the mode; text is inert.
 */
function normalizePlanSubmission(body) {
  strictKeys(body, SUBMIT_KEYS, 'A plan submission');
  const expectedRevision = body.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw planError('expectedRevision must be the current plan revision number (0 when the task has no plan)');
  }
  const mode = body.mode ?? 'plan';
  if (!MODES.includes(mode)) throw planError(`mode must be one of ${MODES.join(', ')}`);
  if (typeof body.text !== 'string') throw planError('text must be the plan text');
  const text = cleanText(body.text);
  if (!text) throw planError('text must not be empty');
  if (text.length > MAX_PLAN_CHARS) {
    throw planError(`The plan is ${text.length} characters; keep it within ${MAX_PLAN_CHARS} or split the work.`, 413, 'PLAN_TOO_LONG');
  }
  let steps;
  if (body.steps !== undefined) {
    if (!Array.isArray(body.steps) || body.steps.some((step) => typeof step !== 'string')) throw planError('steps must be a list of text items');
    steps = body.steps.map(cleanText).filter(Boolean);
    if (steps.length > MAX_STEPS || steps.some((step) => step.length > MAX_STEP_CHARS)) {
      throw planError(`Keep at most ${MAX_STEPS} steps of ${MAX_STEP_CHARS} characters each.`, 413, 'PLAN_TOO_LONG');
    }
  }
  return { expectedRevision, mode, text, steps: steps?.length ? steps : undefined, by: bounded(body.by, 120) };
}

function normalizeDecision(body) {
  strictKeys(body, DECISION_KEYS, 'A plan decision');
  if (!Number.isSafeInteger(body.revision) || body.revision < 1) throw planError('revision must name the exact plan revision reviewed');
  if (!FINGERPRINT_RE.test(String(body.planFingerprint || ''))) throw planError('planFingerprint must be the reviewed revision fingerprint');
  if (!OUTCOMES.includes(body.outcome)) throw planError(`outcome must be one of ${OUTCOMES.join(', ')}`);
  const by = bounded(body.by, 120);
  if (!by) throw planError('A decision must be signed with the reviewer name', 400, 'PLAN_DECISION_UNSIGNED');
  return { revision: body.revision, planFingerprint: body.planFingerprint, outcome: body.outcome, by, reason: bounded(body.reason, 500) };
}

/**
 * Build the next revision from the document state the guarded update will
 * match. `automation` is the intent in force once the write lands (the new
 * one when the same update replaces it). All callers refuse an oversized
 * revision; the complete stored text is fingerprinted and reviewed.
 */
function buildRevision(task, { mode = 'plan', text, steps, declaredActor = null, channel,
  automation = task?.automation, at = new Date() }) {
  if (!MODES.includes(mode)) throw new Error(`unknown plan mode: ${mode}`);
  if (!CHANNELS.includes(channel)) throw new Error(`unknown plan channel: ${channel}`);
  const full = cleanText(text);
  if (!full) throw planError('text must not be empty');
  if (full.length > MAX_PLAN_CHARS) throw planError('The plan is too long.', 413, 'PLAN_TOO_LONG');
  const stored = full;
  const scope = Array.isArray(automation?.scope) ? automation.scope.map(String) : undefined;
  if (scope?.length > MAX_SCOPE_PATHS) throw planError('The complete plan scope has too many paths.', 413, 'PLAN_TOO_LONG');
  const revision = {
    schema: SCHEMA,
    revision: currentRevision(task) + 1,
    mode,
    at,
    actor: { declared: bounded(declaredActor, 120), authenticated: null, channel },
    text: stored,
    ...(steps?.length ? { steps } : {}),
    truncated: stored.length < full.length,
    originalLength: full.length,
    ...(scope ? { scope } : {}),
    scopeFingerprint: FINGERPRINT_RE.test(String(automation?.fingerprint || '')) ? automation.fingerprint : null,
    basisRef: basisRef(task),
  };
  revision.fingerprint = sha256([SCHEMA, revision.revision, mode, stored, revision.steps || [],
    revision.scopeFingerprint, revision.basisRef]);
  return revision;
}

/**
 * Add the revision to an existing update and guard the query on the revision
 * counter it was built from. A concurrent revision makes the update match
 * nothing. The store preserves all revisions.
 */
function recordPlanRevision(query, update, task, revision) {
  query.planRevision = currentRevision(task) || null; // null also matches a task without plans
  update.$set = { ...(update.$set || {}), planRevision: revision.revision };
  update.$push = { ...(update.$push || {}), planRevisions: { $each: [revision] } };
  return { query, update };
}

// The exact request and scope the revision was read against must still hold
// when the guarded write lands.
function basisGuard(query, task) {
  for (const key of ['title', 'spec', 'service']) {
    query[key] = task[key] === undefined ? { $exists: false } : task[key];
  }
  query['automation.fingerprint'] = task.automation?.fingerprint ?? { $exists: false };
  return query;
}

function planRef(task, revision) {
  return /^\d{3,4}$/.test(String(task?.pipelineId ?? '')) ? `task-${task.pipelineId}/plan-${revision}` : null;
}

function decisionView(decision, stale = []) {
  if (!decision) return null;
  return {
    outcome: decision.outcome,
    at: decision.at ? new Date(decision.at).toISOString() : null,
    actor: { declared: decision.actor?.declared ?? null, authenticated: null, channel: decision.actor?.channel ?? null },
    reason: decision.reason ?? null,
    planFingerprint: decision.planFingerprint,
    scopeFingerprint: decision.scopeFingerprint ?? null,
    ...(stale.length ? { staleBecause: stale } : {}),
  };
}

/**
 * Read-only projection. `state` concerns the latest revision only:
 * none | undecided | approved | changes_requested | stale. A decision on an
 * earlier revision appears as `priorDecision` with `carriedOver: false`.
 * `executionAuthority` is always 'none': this projection authorizes nothing.
 */
function planView(task = {}) {
  const revisions = (Array.isArray(task.planRevisions) ? task.planRevisions : [])
    .filter((entry) => Number.isSafeInteger(entry?.revision) && FINGERPRINT_RE.test(String(entry.fingerprint || '')));
  const base = { schema: SCHEMA, executionAuthority: 'none', retained: revisions.length };
  if (!revisions.length) return { ...base, state: 'none', revision: null, current: null, priorDecision: null, history: [] };
  const latest = revisions.at(-1);
  const scopeNow = task.automation?.fingerprint ?? null;
  const basisNow = basisRef(task);
  const drift = (entry) => [
    ...((entry.scopeFingerprint ?? null) !== scopeNow ? ['scope_changed'] : []),
    ...(entry.basisRef !== basisNow ? ['task_changed'] : []),
  ];
  const decisionDrift = latest.decision ? drift(latest.decision) : [];
  const prior = revisions.slice(0, -1).reverse().find((entry) => entry.decision);
  return {
    ...base,
    state: !latest.decision ? 'undecided' : decisionDrift.length ? 'stale' : latest.decision.outcome,
    revision: latest.revision,
    current: {
      revision: latest.revision,
      planRef: planRef(task, latest.revision),
      mode: latest.mode,
      at: latest.at ? new Date(latest.at).toISOString() : null,
      actor: { declared: latest.actor?.declared ?? null, authenticated: null, channel: latest.actor?.channel ?? null },
      text: latest.text,
      steps: latest.steps || [],
      truncated: Boolean(latest.truncated),
      originalLength: latest.originalLength ?? latest.text.length,
      scope: latest.scope || [],
      scopeFingerprint: latest.scopeFingerprint ?? null,
      fingerprint: latest.fingerprint,
      changedSince: drift(latest),
      decision: decisionView(latest.decision, decisionDrift),
    },
    priorDecision: prior ? { revision: prior.revision, outcome: prior.decision.outcome, carriedOver: false } : null,
    history: revisions.map((entry) => ({
      revision: entry.revision,
      planRef: planRef(task, entry.revision),
      mode: entry.mode,
      at: entry.at ? new Date(entry.at).toISOString() : null,
      fingerprint: entry.fingerprint,
      decision: entry.decision ? entry.decision.outcome : null,
    })),
  };
}

module.exports = {
  SCHEMA,
  MODES,
  OUTCOMES,
  CHANNELS,
  MAX_PLAN_CHARS,
  MAX_STEPS,
  planError,
  basisRef,
  currentRevision,
  isPrivateLane,
  normalizePlanSubmission,
  normalizeDecision,
  buildRevision,
  recordPlanRevision,
  basisGuard,
  planView,
};
