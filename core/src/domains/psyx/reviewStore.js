'use strict';

const proposals = require('./proposals');
const { normalizeNotes, sameTarget, NOTE_LIMIT } = require('./supervision');

function createReviewStore({ collection, read, ensureDocument, stateItemKeys, version }) {
  // Background review output: a digest replaces the conversation's previous one;
  // proposals already known (memory, pending or settled by the user) are dropped.
  async function recordReview(userId, { conversationId, digest = null, proposals: incoming = [], supervision = null, resetAt = null, stillWanted = null }) {
    await ensureDocument(userId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const state = await read(userId);
      if ((state.resetAt || null) !== (resetAt || null)) return { added: 0, digest: null, skipped: 'reset', state };
      const note = normalizeNotes([supervision]).find(item => item.conversationId === conversationId) || null;
      if (note && state.supervisionNotes.some(item => sameTarget(item, note))) {
        return { added: 0, digest: null, skipped: 'duplicate', state };
      }
      if (note && state.supervisionNotes.some(item => item.conversationId === conversationId && item.replyOrdinal >= note.replyOrdinal)) {
        return { added: 0, digest: null, skipped: 'superseded', state };
      }
      const known = new Set([
        ...state.proposals.map((item) => item.fingerprint), ...state.settledProposals,
        ...stateItemKeys.flatMap((key) => state[key].map((item) => proposals.proposalFingerprint(key, item.text))),
        ...state.experiments.map((item) => proposals.proposalFingerprint('experiments', item.hypothesis, item.action))
      ]);
      const fresh = incoming.filter((item) => !known.has(item.fingerprint));
      if (stillWanted && !await stillWanted()) return { added: 0, digest: null, skipped: 'gone', state };
      if (!fresh.length && !digest && !note) return { added: 0, digest: null, state };
      const set = { updatedAt: new Date(), version };
      if (note) set.supervisionNotes = [...state.supervisionNotes, note].slice(-NOTE_LIMIT);
      if (fresh.length) set.proposals = [...state.proposals, ...fresh].slice(-proposals.PROPOSAL_LIMITS.pending);
      if (digest) set.sessionDigests = [...state.sessionDigests.filter(item => item.conversationId !== conversationId), digest].slice(-proposals.PROPOSAL_LIMITS.digests);
      // Reset, erasure and proposal decisions change the revision. Replace the
      // derived arrays together, or reread; stale model output cannot undo them.
      const result = await collection.updateOne({ userId, revision: state.revision }, { $set: set, $inc: { revision: 1 } });
      if (result.modifiedCount) return { added: fresh.length, digest, state: await read(userId) };
    }
    throw Object.assign(new Error('PsyX state changed during review'), { statusCode: 409, code: 'PSYX_REVIEW_STATE_CONFLICT' });
  }

  // A permanently deleted conversation leaves nothing derived from it in PsyX memory.
  async function forgetConversation(userId, conversationId) {
    const result = await collection.updateOne({ userId }, {
      $pull: { sessionDigests: { conversationId }, proposals: { conversationId }, supervisionNotes: { conversationId } },
      $inc: { revision: 1 },
      $set: { updatedAt: new Date() }
    });
    return { removed: result.modifiedCount > 0 };
  }

  return { recordReview, forgetConversation };
}

module.exports = { createReviewStore };
