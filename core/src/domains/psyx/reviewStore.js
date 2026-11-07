'use strict';

const proposals = require('./proposals');
const { normalizeNotes, sameTarget, NOTE_LIMIT } = require('./supervision');
const { normalizeProgress, sameReviewAttempt } = require('./reviewProgress');

function createReviewStore({ collection, read, ensureDocument, stateItemKeys, version }) {
  // Background review output: a digest replaces the conversation's previous one;
  // proposals already known (memory, pending or settled by the user) are dropped.
  async function recordReview(userId, input) {
    const { conversationId, resetAt = null, stillWanted = null, receipt = null } = input;
    await ensureDocument(userId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const state = await read(userId);
      if ((state.resetAt || null) !== (resetAt || null)) return { added: 0, digest: null, skipped: 'reset', state };
      // Recompute asynchronous preference/source checks after every CAS
      // conflict, rather than reusing an already-obsolete projection.
      const candidate = input.prepare ? await input.prepare() : input;
      if (!candidate) return { added: 0, digest: null, skipped: 'gone', state };
      let { digest = null, proposals: incoming = [] } = candidate;
      const { supervision = null, applyConversationReview = true } = candidate;
      const note = normalizeNotes([supervision]).find(item => item.conversationId === conversationId) || null;
      const progress = normalizeProgress(state.reviewProgress);
      const cursor = progress[conversationId];
      if (receipt && (cursor?.active?.phase !== 'result_ready' || !sameReviewAttempt(cursor.active, receipt) || !sameTarget(cursor.active.target, note))) {
        return { added: 0, digest: null, skipped: 'receipt', state };
      }
      const duplicateNote = note && state.supervisionNotes.some(item => sameTarget(item, note));
      if (duplicateNote && !receipt) {
        return { added: 0, digest: null, skipped: 'duplicate', state };
      }
      const newer = note && (state.sessionDigests.some(item => item.conversationId === conversationId && item.reviewedReplyOrdinal > note.replyOrdinal)
        || state.supervisionNotes.some(item => item.conversationId === conversationId && item.replyOrdinal > note.replyOrdinal));
      if (!applyConversationReview || newer) { digest = null; incoming = []; }
      const known = new Set([
        ...state.proposals.map((item) => item.fingerprint), ...state.settledProposals,
        ...stateItemKeys.flatMap((key) => state[key].map((item) => proposals.proposalFingerprint(key, item.text))),
        ...state.experiments.map((item) => proposals.proposalFingerprint('experiments', item.hypothesis, item.action))
      ]);
      const fresh = incoming.filter((item) => !known.has(item.fingerprint));
      if (stillWanted && !await stillWanted()) return { added: 0, digest: null, skipped: 'gone', state };
      if (!fresh.length && !digest && !note) return { added: 0, digest: null, state };
      const set = { updatedAt: new Date(), version };
      if (note && !duplicateNote) set.supervisionNotes = [...state.supervisionNotes, note].slice(-NOTE_LIMIT);
      if (receipt) {
        progress[conversationId] = { throughOrdinal: note.replyOrdinal, active: null };
        set.reviewProgress = progress;
      }
      if (fresh.length) set.proposals = [...state.proposals, ...fresh].slice(-proposals.PROPOSAL_LIMITS.pending);
      if (digest) set.sessionDigests = [...state.sessionDigests.filter(item => item.conversationId !== conversationId),
        { ...digest, ...(note ? { reviewedReplyOrdinal: note.replyOrdinal } : {}) }].slice(-proposals.PROPOSAL_LIMITS.digests);
      // Reset, erasure and proposal decisions change the revision. Replace the
      // derived arrays together, or reread; stale model output cannot undo them.
      const result = await collection.updateOne({ userId, revision: state.revision }, { $set: set, $inc: { revision: 1 } });
      if (result.modifiedCount) return { added: fresh.length, digest, state: await read(userId),
        ...(receipt ? { error: candidate.error || null } : {}) };
    }
    throw Object.assign(new Error('PsyX state changed during review'), { statusCode: 409, code: 'PSYX_REVIEW_STATE_CONFLICT' });
  }

  // Remove linked review state; accepted memory retains its existing lifecycle.
  async function forgetConversation(userId, conversationId) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await read(userId);
      const progress = normalizeProgress(state.reviewProgress);
      delete progress[conversationId];
      const result = await collection.updateOne({ userId, revision: state.revision }, {
        $pull: { sessionDigests: { conversationId }, proposals: { conversationId }, supervisionNotes: { conversationId } },
        $inc: { revision: 1 }, $set: { reviewProgress: progress, updatedAt: new Date() }
      });
      if (result.modifiedCount) return { removed: true };
      if (!await collection.findOne({ userId })) return { removed: false };
    }
    throw Object.assign(new Error('PsyX state changed during conversation deletion'), { code: 'PSYX_REVIEW_STATE_CONFLICT' });
  }

  return { recordReview, forgetConversation };
}

module.exports = { createReviewStore };
