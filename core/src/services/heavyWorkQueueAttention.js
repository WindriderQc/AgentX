'use strict';

const GRACE_MS = 5 * 60 * 1000;

// A deadline requests operator attention; it never proves termination or frees
// resources. Operator/island dispatch marks are their whole execution window.
function stalled(job, now = Date.now()) {
  if (!['dispatching', 'running'].includes(job.state)) return null;
  const started = Date.parse(job.dispatchedAt);
  if (!Number.isFinite(started)) return null;
  const operator = ['operator', 'island'].includes(job.executor?.mode);
  const launch = job.state === 'dispatching' && !operator;
  const duration = launch ? 0 : Number(job.estimatedMinutes) * 60000;
  if (!Number.isFinite(duration) || duration < 0 || (!launch && duration === 0)) return null;
  const deadline = started + duration + GRACE_MS;
  return now >= deadline ? {
    code: launch ? 'launch_receipt_overdue' : 'completion_receipt_overdue',
    at: new Date(deadline).toISOString(), actor: operator ? 'operator' : 'native_executor',
    detail: 'Inspect the original request and native receipt; no replacement launch or automatic release is authorized.'
  } : null;
}
module.exports = { stalled, GRACE_MS };
