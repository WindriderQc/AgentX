'use strict';

const { reviewMessages, readReview } = require('../../../src/domains/psyx/review');

// Runs the background review after completed turns. At most one review runs per
// conversation; turns that complete meanwhile coalesce into a single follow-up.
// An admitted inference is never cancelled: aborting leaves the host runtime
// state unknown and Core quarantines it, so a stale result is simply superseded.
function createReviewer({ config, provider, stateRepository, conversationRepository, logger = console }) {
  const enabled = config.review?.enabled !== false && typeof provider.complete === 'function';
  const delayMs = config.review?.delayMs ?? 4000;
  const jobs = new Map();
  const key = (userId, conversationId) => `${userId}:${conversationId}`;

  async function run(userId, conversationId) {
    const turns = await conversationRepository.context(userId, conversationId, 40);
    if (!turns?.length) return { added: 0, digest: null };
    const state = await stateRepository.read(userId);
    const result = await provider.complete({
      messages: reviewMessages({ state, turns }),
      taskType: config.review?.taskType || 'deep_reasoning',
      timeoutMs: config.requestTimeoutMs
    });
    const review = readReview(result.content, { conversationId, settled: state.settledProposals });
    if (!review) throw Object.assign(new Error('The background review returned no usable result'), { code: 'PSYX_REVIEW_UNUSABLE' });
    const recorded = await stateRepository.recordReview(userId, { conversationId, ...review });
    return { added: recorded.added, digest: Boolean(review.digest), model: result.model || null };
  }

  function start(userId, conversationId) {
    const job = jobs.get(key(userId, conversationId));
    job.status = 'queued';
    job.rerun = false;
    job.timer = setTimeout(async () => {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      try {
        const outcome = await run(userId, conversationId);
        Object.assign(job, { status: 'done', error: null, lastAdded: outcome.added, model: outcome.model, completedAt: new Date().toISOString() });
      } catch (error) {
        Object.assign(job, { status: 'failed', error: error.code || 'PSYX_REVIEW_FAILED', completedAt: new Date().toISOString() });
        logger.warn?.('PsyX background review failed', { code: error.code, message: error.message });
      }
      if (job.rerun) start(userId, conversationId);
    }, delayMs);
    job.timer.unref?.();
  }

  function schedule(userId, conversationId) {
    if (!enabled || !conversationId) return false;
    const id = key(userId, conversationId);
    const job = jobs.get(id);
    if (!job) {
      jobs.set(id, { status: 'queued', rerun: false, sequence: 1 });
      start(userId, conversationId);
      return true;
    }
    job.sequence += 1;
    if (job.status === 'running') job.rerun = true;
    else {
      clearTimeout(job.timer);
      start(userId, conversationId);
    }
    return true;
  }

  function status(userId, conversationId) {
    const job = jobs.get(key(userId, conversationId));
    if (!enabled) return { enabled: false, status: 'disabled' };
    if (!job) return { enabled: true, status: 'idle' };
    const { status: current, sequence, lastAdded = 0, error = null, model = null, completedAt = null } = job;
    return { enabled: true, status: job.rerun ? 'running' : current, sequence, lastAdded, error, model, completedAt };
  }

  return { enabled, schedule, status };
}

module.exports = { createReviewer };
