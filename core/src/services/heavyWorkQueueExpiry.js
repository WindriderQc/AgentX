'use strict';

// Observation only. A missed planning window never proves native release and
// must not cancel, dispatch or retry an executor.
function unstartedExpiry(job, now = Date.now()) {
  if (job.dispatchedAt || job.dispatchId || job.operation) return null;
  if (job.state === 'cancelled') {
    return job.cancellationReason?.code === 'window_expired_before_start'
      ? job.cancellationReason : null;
  }
  if (!['requested', 'reserved'].includes(job.state)) return null;
  const bounds = [['startBefore', job.startBefore], ['reservation.end', job.reservation?.end]]
    .map(([bound, value]) => ({ bound, time: Date.parse(value) }))
    .filter(({ time }) => Number.isFinite(time) && time <= now)
    .sort((a, b) => a.time - b.time);
  if (!bounds.length) return null;
  return { code: 'window_expired_before_start', bound: bounds[0].bound,
    at: new Date(bounds[0].time).toISOString() };
}

module.exports = { unstartedExpiry };
