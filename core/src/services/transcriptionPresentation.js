'use strict';
const { presentation } = require('./heavyWorkQueueReadModel');
// Queue projection is planning evidence; it is never a fresh GPU measurement.
function planning(job, now = Date.now()) {
  if (!job) return { available: false };
  const view = presentation(job, { now });
  const times = [job.notBefore, job.reservation?.start].filter(Boolean).map(Date.parse).filter(Number.isFinite);
  return { available: true, observedAt: view.observedAt, state: job.state, startMode: view.startMode,
    scheduleState: view.schedule.state, nextAction: view.nextAction.code,
    earliestStartAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    slotEnd: job.reservation?.end || null };
}
module.exports = { planning };
