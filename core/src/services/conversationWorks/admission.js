'use strict';

// Leave room for the next turn before admitting a review of an answered turn.
// The age cap is eligibility at the next free dispatch gate, never a timeout
// of a native owner. An overdue review alternates with awaited work.
const REVIEW_IDLE_MS = 30000;
const REVIEW_MAX_WAIT_MS = 120000;
const timestamp = value => Number.isFinite(new Date(value).getTime()) ? new Date(value).getTime() : 0;
const settledAt = row => Math.max(timestamp(row.receivedAt), ...(row.events || [])
  .filter(event => ['guardian_settled', 'context_ready', 'intake_recovered'].includes(event.type))
  .map(event => timestamp(event.at)));

async function selectQueuedWork(repo, { now, lastClassification } = {}) {
  const queued = { state: 'queued', contextReady: true };
  const [first] = await repo.find(queued, 1);
  if (!first) return null;
  const [review] = first.classification === 'native_review' ? [first]
    : await repo.find({ ...queued, classification: 'native_review' }, 1);
  // Acceptance is immutable across duplicate delivery, guardian settlement,
  // pause/resume and restart; none can move this eligibility cap forward.
  const overdue = review && now - timestamp(review.receivedAt) >= REVIEW_MAX_WAIT_MS;
  const [awaited] = first.classification !== 'native_review' ? [first]
    : await repo.find({ ...queued, classification: { $ne: 'native_review' } }, 1);
  if (awaited) return overdue && lastClassification !== 'native_review' ? review : awaited;
  if (!review || overdue) return review || null;
  // Interrupted, failed, uncertain and legacy guardian outcomes do not attest
  // an answered turn. Keep their existing reconciliation/dispatch behavior.
  if (review.mode !== 'native' || review.guardian?.state !== 'completed'
      || review.guardian?.disposition !== 'answered') return review;
  const [latest] = await repo.find({}, 1, { receivedAt: -1, _id: -1 });
  const activity = Math.max(settledAt(review), latest ? settledAt(latest) : 0);
  const foregroundPending = latest && ['pending', 'running', 'uncertain'].includes(latest.guardian?.state);
  return !foregroundPending && now - activity >= REVIEW_IDLE_MS ? review : null;
}

module.exports = { selectQueuedWork, REVIEW_IDLE_MS, REVIEW_MAX_WAIT_MS };
