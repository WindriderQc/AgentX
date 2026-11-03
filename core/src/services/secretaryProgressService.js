'use strict';

const UUID = /^[a-f0-9-]{36}$/;

// Read the existing queue owner. An objective's last page status is not proof
// of a running campaign, and a released failed chunk is not a completed goal.
async function reconcile(body, { readQueue = id => require('./heavyWorkQueueService').get(id) } = {}) {
  if (!Array.isArray(body?.objectiveReviews)) return body;
  const jobs = new Map();
  const objectiveReviews = await Promise.all(body.objectiveReviews.slice(0, 100).map(async review => {
    const c = review.controller;
    if (!UUID.test(c?.queueId || '')) return review;
    if (!jobs.has(c.queueId)) jobs.set(c.queueId, Promise.resolve().then(() => readQueue(c.queueId)).catch(() => null));
    const job = await jobs.get(c.queueId);
    if (!job || job.id !== c.queueId || (c.dispatchId && c.dispatchId !== job.dispatchId)) return review;
    if (!['completed', 'failed', 'cancelled'].includes(job.state) || !job.releaseReceipt) return review;
    return { ...review, phase: job.state === 'completed' ? 'paused' : job.state === 'failed' ? 'failed' : 'stopped',
      controller: { ...c, reconciled: true, released: true, queueState: job.state,
        reconciledAt: job.finishedAt || job.updatedAt || null } };
  }));
  return { ...body, objectiveReviews };
}

module.exports = { reconcile };
