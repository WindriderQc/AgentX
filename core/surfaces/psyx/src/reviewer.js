'use strict';

const { REVIEW_PROMPT_VERSION, selectReviewTurns, reviewMessages, readReview } = require('../../../src/domains/psyx/review');
const { NOTE_LIMIT, replyTarget, sameTarget, supervisionNote } = require('../../../src/domains/psyx/supervision');
const { reviewEpoch } = require('../../../src/domains/psyx/reviewProgress');

// One serial worker per conversation. Core's transcript is the pending queue;
// PsyX's existing state owns the durable cursor, dispatch fence and bounded
// result. An admitted inference is never cancelled or blindly replayed.
function createReviewer({ config, provider, stateRepository, conversationRepository, logger = console,
  isBusy = () => false, locationFor = () => 'local', preferencesFor = null }) {
  const enabled = Boolean(preferencesFor || config.review?.enabled !== false) && typeof provider.complete === 'function';
  const jobs = new Map(), runningRequests = new Set();
  let stopped = false;
  const key = (user, conversation) => user + ':' + conversation;
  const preferences = user => preferencesFor ? preferencesFor(user) : Promise.resolve(null);
  const delay = settings => settings ? settings.values.reviewDelaySeconds * 1000 : config.review?.delayMs ?? 4000;

  async function plan(userId, conversationId) {
    const state = await stateRepository.read(userId);
    const snapshot = await conversationRepository.context(userId, conversationId, Number.MAX_SAFE_INTEGER,
      { timestamps: true, withIdentity: true, withCoverage: true });
    const turns = Array.isArray(snapshot) ? snapshot : snapshot?.messages;
    const cursor = state.reviewProgress?.[conversationId] || { throughOrdinal: 0, active: null };
    const targets = (turns || []).filter(turn => turn.role === 'assistant' && turn.control?.reviewRequested === true
      && (turn.control.reviewEpoch || null) === reviewEpoch(state)).map(turn => replyTarget(conversationId, [turn])).filter(Boolean);
    return { state, turns, cursor, targets,
      pending: targets.filter(target => target.replyOrdinal > cursor.throughOrdinal) };
  }

  function coverage(current) {
    const enrolledIds = new Set(current.targets.map(target => target.replyId));
    const notes = (current.state.supervisionNotes || []).filter(note => note.conversationId === current.targets[0]?.conversationId
      && enrolledIds.has(note.replyId));
    return { scope: 'explicitly_enrolled_replies_in_current_reset_epoch', eligibleReplies: current.targets.length,
      settledReviewAttempts: current.targets.length - current.pending.length, pendingReplies: current.pending.length,
      retainedNotes: notes.length, retainedModelCritiques: notes.filter(note => note.modelReview.status === 'available').length,
      retentionLimit: NOTE_LIMIT, excludedReplies: (current.turns || []).filter(turn => turn.role === 'assistant').length - current.targets.length };
  }

  const targetIn = (target, turns) => (turns || []).findIndex(turn => sameTarget(target, replyTarget(target.conversationId, [turn])));
  async function stillExists(userId, conversationId, target) {
    const current = await plan(userId, conversationId);
    return Boolean(current.turns) && targetIn(target, current.turns) >= 0;
  }

  function discarded(output) {
    return { ...output, digest: null, proposals: [], applyConversationReview: false,
      supervision: { ...output.supervision, modelReview: { ...output.supervision.modelReview,
        status: 'discarded', observations: null, adjustment: '', discardReason: 'PREFERENCES_CHANGED' } } };
  }

  async function project(userId, conversationId, work) {
    let output = work.output;
    const settings = await preferences(userId);
    if (settings && (settings.revision !== work.preferencesRevision || !settings.values.backgroundReview)) output = discarded(output);
    const current = await plan(userId, conversationId);
    if (!current.turns || targetIn(work.target, current.turns) < 0) return { unavailable: true };
    const latest = sameTarget(work.target, replyTarget(conversationId, current.turns));
    const result = await stateRepository.recordReview(userId, { conversationId, ...output,
      applyConversationReview: latest && output.applyConversationReview !== false,
      resetAt: work.resetAt, receipt: work,
      stillWanted: () => stillExists(userId, conversationId, work.target) });
    return { added: result.added, error: output.error || null, skipped: result.skipped };
  }

  async function one(userId, conversationId, current, settings, job) {
    let work = current.cursor.active;
    if (work) {
      if (work.phase === 'result_ready') return project(userId, conversationId, work);
      if (runningRequests.has(work.requestId)) return { waitMs: 1000 };
      if (work.phase !== 'waiting') return { uncertain: true, error: work.error || 'PSYX_REVIEW_EXECUTION_UNKNOWN', work };
      const remaining = Date.parse(work.retryAt) - Date.now();
      if (remaining > 0) return { waitMs: remaining };
    }
    if (!current.turns) return { drained: true };
    const target = work?.target || current.pending[0];
    if (!target) return { drained: true };
    const due = new Date(target.repliedAt || 0).getTime() + delay(settings);
    if (due > Date.now()) return { waitMs: due - Date.now() };
    const index = targetIn(target, current.turns);
    const prefix = current.turns.slice(0, index + 1);
    // Always include the complete target, including unusually long replies.
    // Core's existing admission/context-overflow refusal remains authoritative.
    const selected = selectReviewTurns(prefix.slice(-40), Math.max(24000, prefix.at(-1).content.length));
    const included = { availableMessages: prefix.length, includedMessages: selected.length,
      omittedMessages: prefix.length - selected.length, complete: selected.length === prefix.length };
    const claim = await stateRepository.claimReview(userId, { target, resetAt: current.state.resetAt,
      epoch: reviewEpoch(current.state),
      preferencesRevision: settings?.revision ?? null });
    if (claim.skipped) return { retry: true };
    work = claim.work;
    const fresh = await plan(userId, conversationId);
    if (fresh.cursor.active?.requestId !== work.requestId) return { skipped: 'gone' };
    const latestSettings = await preferences(userId);
    if (stopped || jobs.get(key(userId, conversationId)) !== job
      || !fresh.turns || targetIn(target, fresh.turns) < 0
      || (latestSettings && (!latestSettings.values.backgroundReview || latestSettings.revision !== work.preferencesRevision))) {
      // No provider call has started: preserve this exact identity as safely
      // deferred, rather than losing it or treating it as an uncertain dispatch.
      await stateRepository.saveReviewResult(userId, { work, error: 'PSYX_REVIEW_DEFERRED_BEFORE_DISPATCH',
        retryAt: new Date().toISOString() });
      return { waitMs: 1000 };
    }
    runningRequests.add(work.requestId);
    try {
      const result = await provider.complete({
        requestId: work.requestId,
        messages: reviewMessages({ state: settings ? require('../../../src/services/conversationPreferences/catalog').selectPsyxState(current.state, settings.values) : current.state,
          turns: selected, target, coverage: included, maxCharacters: Math.max(24000, prefix.at(-1).content.length) }),
        taskType: config.review?.taskType || 'deep_reasoning', timeoutMs: config.requestTimeoutMs, location: locationFor(current.state)
      });
      const review = readReview(result?.content, { conversationId, settled: current.state.settledProposals,
        openExperimentIds: current.state.experiments.filter(item => ['planned', 'active'].includes(item.status)).map(item => item.id) });
      const note = supervisionNote(review ? review.supervision : {}, { target, reply: prefix.at(-1).content,
        model: result?.model, promptVersion: REVIEW_PROMPT_VERSION, coverage: included });
      const output = { digest: review?.digest || null, proposals: review?.proposals || [], supervision: note,
        error: !review ? 'PSYX_REVIEW_UNUSABLE' : note.modelReview.status === 'available'
          ? null : 'PSYX_SUPERVISION_' + note.modelReview.status.toUpperCase() };
      const saved = await stateRepository.saveReviewResult(userId, { work, output });
      if (saved.skipped && saved.skipped !== 'duplicate') return { skipped: saved.skipped };
      return project(userId, conversationId, saved.work);
    } catch (error) {
      // The transport has no idempotent inference-replay contract. Keep the exact
      // dispatch identity uncertain; later turns and restarts cannot repeat it.
      if (error.reviewNotDispatched === true) {
        const waitMs = Math.max(1000, delay(settings));
        await stateRepository.saveReviewResult(userId, { work, error: error.code,
          retryAt: new Date(Date.now() + waitMs).toISOString() });
        return { waitMs };
      }
      await stateRepository.saveReviewResult(userId, { work, error: error.code || 'PSYX_REVIEW_EXECUTION_UNKNOWN' });
      return { uncertain: true, error: error.code || 'PSYX_REVIEW_EXECUTION_UNKNOWN', work };
    } finally { runningRequests.delete(work.requestId); }
  }

  async function attempt(userId, conversationId, job) {
    if (jobs.get(key(userId, conversationId)) !== job) return;
    job.status = 'running';
    try {
      while (jobs.get(key(userId, conversationId)) === job) {
        const settings = await preferences(userId);
        if (settings && !settings.values.backgroundReview) { forget(userId, conversationId); return; }
        const current = await plan(userId, conversationId);
        job.coverage = coverage(current);
        // A saved result needs no model and can settle even while a reply streams.
        if (isBusy(userId) && current.cursor.active?.phase !== 'result_ready') {
          job.status = 'queued'; arm(userId, conversationId, job, Math.max(1000, delay(settings))); return;
        }
        const outcome = await one(userId, conversationId, current, settings, job);
        if (jobs.get(key(userId, conversationId)) !== job) { schedule(userId, conversationId); return; }
        if (outcome.waitMs != null) { job.status = 'queued'; arm(userId, conversationId, job, outcome.waitMs); return; }
        if (outcome.uncertain || outcome.unavailable) {
          Object.assign(job, { status: 'uncertain', error: outcome.error || 'PSYX_REVIEW_TARGET_UNAVAILABLE',
            work: outcome.work || current.cursor.active }); return;
        }
        if (outcome.error) job.error = outcome.error;
        job.lastAdded = outcome.added ?? job.lastAdded ?? 0;
        if (outcome.drained || !current.turns) break;
      }
      Object.assign(job, { status: job.error ? 'failed' : 'done', completedAt: new Date().toISOString() });
    } catch (error) {
      Object.assign(job, { status: 'failed', error: error.code || 'PSYX_REVIEW_FAILED' });
      logger.warn?.('PsyX review failed', { code: error.code });
    }
    job.timer = setTimeout(() => { if (jobs.get(key(userId, conversationId)) === job) jobs.delete(key(userId, conversationId)); }, 15 * 60000);
    job.timer.unref?.();
  }

  function arm(userId, conversationId, job, waitMs = null) {
    const token = job.armId = (job.armId || 0) + 1;
    void preferences(userId).then(settings => {
      if (jobs.get(key(userId, conversationId)) !== job || job.armId !== token) return;
      if (settings && !settings.values.backgroundReview) { forget(userId, conversationId); return; }
      job.timer = setTimeout(() => void attempt(userId, conversationId, job), waitMs ?? delay(settings));
      job.timer.unref?.();
    }).catch(error => {
      Object.assign(job, { status: 'failed', error: 'PSYX_REVIEW_SETTINGS_UNAVAILABLE' });
      logger.warn?.('PsyX review settings unavailable', { code: error.code });
    });
  }

  function schedule(userId, conversationId) {
    if (!enabled || stopped || !conversationId) return false;
    const id = key(userId, conversationId);
    let job = jobs.get(id);
    if (job && ['running', 'queued'].includes(job.status)) { job.sequence++; return true; }
    if (job) clearTimeout(job.timer);
    job = { userId, status: 'queued', sequence: (job?.sequence || 0) + 1 };
    jobs.set(id, job);
    arm(userId, conversationId, job);
    return true;
  }

  function status(userId, conversationId) {
    if (!enabled) return { enabled: false, status: 'disabled' };
    const job = jobs.get(key(userId, conversationId));
    if (!job) return { enabled: true, status: 'idle' };
    const { status: current, sequence, lastAdded = 0, error = null, completedAt = null, coverage = null, work = null } = job;
    return { enabled: true, status: current, sequence, lastAdded, error, completedAt, coverage,
      ...(work ? { requestId: work.requestId, target: work.target } : {}) };
  }
  async function inspect(userId, conversationId) {
    if (!enabled || !conversationId) return status(userId, conversationId);
    const current = await plan(userId, conversationId);
    const work = current.cursor.active;
    const report = status(userId, conversationId);
    return { ...report,
      ...(!work && !current.pending.length && report.status === 'uncertain' ? { status: 'done', error: null } : {}),
      ...((work?.phase === 'waiting' || work?.phase === 'result_ready') ? { status: 'queued' } : {}),
      ...(work?.phase === 'waiting' ? { error: work.error, retryAt: work.retryAt } : {}),
      ...(work && !runningRequests.has(work.requestId) && !['result_ready', 'waiting'].includes(work.phase)
      ? { status: 'uncertain', error: work.error || 'PSYX_REVIEW_EXECUTION_UNKNOWN' } : {}), coverage: coverage(current),
      ...(work ? { requestId: work.requestId, target: work.target, execution: work.phase } : {}) };
  }
  function forget(userId, conversationId) {
    const id = key(userId, conversationId), job = jobs.get(id);
    if (job) clearTimeout(job.timer);
    jobs.delete(id);
  }
  function forgetUser(userId) {
    for (const [id, job] of jobs) if (job.userId === userId) { clearTimeout(job.timer); jobs.delete(id); }
  }

  let clock = null, scanning = false;
  async function scan() {
    if (!enabled || scanning || !conversationRepository.listSessionMetadata) return;
    scanning = true;
    try {
      const users = new Set(['default', ...await stateRepository.dreamUserIds?.() || []]);
      for (const userId of users) {
        const settings = await preferences(userId);
        if (settings && !settings.values.backgroundReview) continue;
        for (const session of await conversationRepository.listSessionMetadata(userId)) {
          if (session.lifecycle?.status === 'archived') continue;
          const current = await plan(userId, session.id);
          if (current.pending.length || current.cursor.active) schedule(userId, session.id);
        }
      }
    } finally { scanning = false; }
  }
  function start() {
    if (!enabled || clock) return;
    stopped = false;
    const check = () => void scan().catch(error => logger.warn?.('PsyX review recovery failed', { code: error.code }));
    check(); clock = setInterval(check, 60000); clock.unref?.();
  }
  function stop() {
    stopped = true;
    clearInterval(clock); clock = null;
    for (const job of jobs.values()) clearTimeout(job.timer);
    jobs.clear();
  }

  return { enabled, schedule, status, inspect, forget, forgetUser, start, stop, scan };
}

module.exports = { createReviewer };
