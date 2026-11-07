'use strict';

const { randomUUID } = require('node:crypto');
const { sameTarget } = require('./supervision');
const reviewEpoch = state => state.reviewEpoch || state.resetAt || null;

// One compact cursor and at most one bounded result per canonical conversation.
// No transcript copy or list of pending replies: those stay in Core.
function normalizeProgress(raw) {
  return Object.fromEntries(Object.entries(raw || {}).filter(([id, item]) =>
    /^[a-zA-Z0-9_-]{1,80}$/.test(id) && item && Number.isSafeInteger(item.throughOrdinal) && item.throughOrdinal >= 0
  ).map(([id, item]) => [id, { throughOrdinal: item.throughOrdinal,
    active: item.active?.requestId && ['dispatched', 'waiting', 'result_ready', 'uncertain'].includes(item.active.phase) ? item.active : null }]));
}

function createReviewProgress({ collection, read, ensureDocument }) {
  async function mutate(userId, resetAt, epoch, operation) {
    await ensureDocument(userId);
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await read(userId);
      if ((state.resetAt || null) !== (resetAt || null) || reviewEpoch(state) !== (epoch || null)) return { skipped: 'reset', state };
      const progress = normalizeProgress(state.reviewProgress);
      const outcome = operation(progress);
      if (outcome.skipped) return { ...outcome, state };
      const result = await collection.updateOne({ userId, revision: state.revision },
        { $set: { reviewProgress: progress, updatedAt: new Date() }, $inc: { revision: 1 } });
      if (result.modifiedCount) return { ...outcome, state: await read(userId) };
    }
    throw Object.assign(new Error('PsyX review cursor changed concurrently'), { code: 'PSYX_REVIEW_STATE_CONFLICT' });
  }

  async function claimReview(userId, { target, resetAt = null, epoch = resetAt, preferencesRevision = null }) {
    const requestId = randomUUID();
    return mutate(userId, resetAt, epoch, progress => {
      const cursor = progress[target.conversationId] || { throughOrdinal: 0, active: null };
      if (cursor.throughOrdinal >= target.replyOrdinal) return { skipped: 'duplicate' };
      if (cursor.active) {
        if (cursor.active.phase !== 'waiting' || !sameTarget(cursor.active.target, target)
          || Date.parse(cursor.active.retryAt) > Date.now()) return { skipped: 'active', work: cursor.active };
        Object.assign(cursor.active, { phase: 'dispatched', preferencesRevision, startedAt: new Date().toISOString() });
        return { work: cursor.active };
      }
      cursor.active = { requestId, target, phase: 'dispatched', preferencesRevision, resetAt, epoch,
        startedAt: new Date().toISOString() };
      progress[target.conversationId] = cursor;
      return { work: cursor.active };
    });
  }

  async function saveReviewResult(userId, { work, output = null, error = null, retryAt = null }) {
    return mutate(userId, work.resetAt, work.epoch, progress => {
      const active = progress[work.target.conversationId]?.active;
      if (!active || active.requestId !== work.requestId || !sameTarget(active.target, work.target)) return { skipped: 'gone' };
      if (active.phase === 'result_ready') return { skipped: 'duplicate', work: active };
      Object.assign(active, output ? { phase: 'result_ready', output, error: null }
        : retryAt ? { phase: 'waiting', retryAt, error }
          : { phase: 'uncertain', error: error || 'PSYX_REVIEW_EXECUTION_UNKNOWN' });
      return { work: active };
    });
  }

  return { claimReview, saveReviewResult };
}

module.exports = { normalizeProgress, createReviewProgress, reviewEpoch };
