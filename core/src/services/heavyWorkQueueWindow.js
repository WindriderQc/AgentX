'use strict';

/** A durable dispatch must start in time; admitted work keeps its reserved end. */
function executionWindowOpen(job, now = Date.now()) {
  if (!job || !['dispatching', 'running'].includes(job.state) || !job.dispatchId) return false;
  const time = typeof now === 'number' ? now : Date.parse(now);
  const start = Date.parse(job.reservation?.start), end = Date.parse(job.reservation?.end);
  const dispatched = Date.parse(job.dispatchedAt);
  const notBefore = job.notBefore == null ? -Infinity : Date.parse(job.notBefore);
  const startBefore = job.startBefore == null ? Infinity : Date.parse(job.startBefore);
  return [time, start, end, dispatched].every(Number.isFinite)
    && !Number.isNaN(notBefore) && !Number.isNaN(startBefore)
    && start <= dispatched && dispatched <= time && time < end
    && notBefore <= dispatched && dispatched < startBefore;
}

module.exports = { executionWindowOpen };
