'use strict';
const { createHash } = require('node:crypto');
const workerScope = require('../helpers/workerTaskScope');
const STATES = ['proposed', 'needs_clarification', 'accepted', 'deferred', 'declined'];
const LABELS = { proposed: 'Proposition à trier', needs_clarification: 'Besoin à clarifier', accepted: 'Engagement accepté',
  deferred: 'Demande reportée', declined: 'Demande non retenue', legacy_unrecorded: 'Décision historique non documentée',
  superseded: 'Demande remplacée', native_domain: 'Décision du domaine personnel ou familial' };
const applicable = task => workerScope.contains(task) && !task.profileId && task.origin !== 'family';
const scopeFingerprint = task => createHash('sha256').update(JSON.stringify([task.title || '', task.spec || ''])).digest('hex');
const error = (message, code = 'TASK_INTAKE_REQUIRED', status = 409) => Object.assign(new Error(message), { status, statusCode: status, code });

function stateOf(task) {
  if (!applicable(task)) return 'native_domain';
  if (task.resolution?.kind === 'superseded') return 'superseded';
  if (!task.intake) return 'legacy_unrecorded';
  if (!STATES.includes(task.intake.state)) return 'needs_clarification';
  return task.intake.state === 'accepted' && task.intake.scopeFingerprint !== scopeFingerprint(task)
    ? 'needs_clarification' : task.intake.state;
}
function accepted(task) { return ['native_domain', 'legacy_unrecorded', 'accepted'].includes(stateOf(task)); }
function assertAccepted(task) {
  if (!accepted(task)) throw error('Review and accept the current request before preparing or claiming work. Acceptance grants no execution authority.');
}
// No decision cancels effects or releases authority. Expired/unknown work and
// allocated report identities must be reconciled through their original owner.
function fenced(task) {
  return Boolean(task.assignee || !['queued', 'blocked'].includes(task.status) || task.automationLease || task.codingCapacity
    || task.automationAttempts?.some(attempt => attempt.finalState === 'active' || ['UNKNOWN', 'RECOVERY_REQUIRED'].includes(String(attempt.evidence?.inference?.state).toUpperCase()))
    || task.codingAutonomy?.authorized || task.codingAutonomy?.runs?.some(run => !run.finishedAt || run.pendingInferences?.length
      || run.modelReceipts?.some(receipt => !['completed', 'refused'].includes(receipt.state)))
    || task.reportContinuation?.runs?.some(run => !run.finishedAt));
}
function initial(task, at = new Date(), acceptance = null) {
  if (!applicable(task)) return undefined;
  if (acceptance && (typeof acceptance.by !== 'string' || !acceptance.by.trim() || acceptance.by.length > 120
    || typeof acceptance.reason !== 'string' || acceptance.reason.length < 8 || acceptance.reason.length > 1000
    || typeof acceptance.ref !== 'string' || !acceptance.ref.trim() || acceptance.ref.length > 500))
    throw error('The native intake review needs its bounded actor, reason and evidence reference.', 'INVALID_NATIVE_INTAKE_REVIEW', 400);
  const fingerprint = scopeFingerprint(task);
  const state = acceptance ? 'accepted' : 'proposed';
  return { state, revision: 1, scopeFingerprint: fingerprint, history: [{ revision: 1,
    from: null, to: state, reason: acceptance?.reason || 'Engineering request recorded for triage; no commitment or execution authority granted.',
    ...(acceptance && { evidenceRef: acceptance.ref }), scopeFingerprint: fingerprint,
    actor: { declared: acceptance?.by || task.source || 'api', authenticated: null, channel: acceptance ? 'domain_review' : 'task_create' }, at }] };
}
function view(task) {
  const state = stateOf(task), latest = task.intake?.history?.at(-1);
  return { schema: 'agentx.task-intake/v1', state, recordedState: task.intake?.state || null,
    revision: task.intake?.revision || 0, label: LABELS[state], scopeFingerprint: scopeFingerprint(task),
    reviewedScopeFingerprint: task.intake?.scopeFingerprint || null,
    reason: state === 'needs_clarification' && task.intake?.state === 'accepted'
      ? 'Le besoin a changé depuis son acceptation. Relisez le périmètre actuel.' : latest?.reason || null,
    canDecide: applicable(task) && state !== 'superseded' && !fenced(task),
    claimGate: accepted(task) ? state === 'legacy_unrecorded' ? 'existing_policy' : 'accepted_scope' : 'decision_required',
    authorization: 'not_granted', actor: latest?.actor || null, decidedAt: latest?.at || null };
}
// Bind selection to both the decision and the exact accepted content. A decision
// or edit racing a claim cannot be overwritten by a stale worker read.
function guard(query, task) {
  query['intake.revision'] = task.intake?.revision ?? null;
  if (task.intake) Object.assign(query, { 'intake.state': 'accepted',
    'intake.scopeFingerprint': scopeFingerprint(task), title: task.title, spec: task.spec ?? null });
  return query;
}
module.exports = { STATES, LABELS, applicable, scopeFingerprint, stateOf, accepted, assertAccepted, fenced, initial, view, guard, error };
