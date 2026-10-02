'use strict';

// The Household voice memory audit worker: turns recorded from native voice
// are processed into memory (explicit saves, forgets and inferred candidates)
// with bounded retries, and drained in small batches.

const { assessSafety } = require('./persona-prompt');
const { forgetMemoryStatement, explicitMemoryStatement, voiceMemoryCandidateId, inferredMemoryCandidate } = require('./voice-memory-turns');

function createVoixMemoryAuditWorker({
  conversations, personalNotes, models, cleanText, logger
}) {
  const processVoixMemoryAudit = async (traceId) => {
    const now = new Date();
    const claimed = await conversations.updateTurn(
      {
        traceId,
        source: 'voix-native',
        memoryState: 'captured',
        $or: [{ memoryNextAttemptAt: null }, { memoryNextAttemptAt: { $lte: now } }]
      },
      { $set: { memoryState: 'processing', memoryClaimedAt: new Date(), memoryError: '' } });
    if (!claimed) return null;
    const audit = typeof claimed.toObject === 'function' ? claimed.toObject() : claimed;
    const safety = assessSafety(audit.inputText);
    const blocked = safety.flagIds.some((id) => [
      'private_information', 'self_harm', 'immediate_danger', 'abuse_or_threat'
    ].includes(id));
    const forget = blocked ? '' : forgetMemoryStatement(audit.inputText);
    const explicit = blocked || forget ? '' : explicitMemoryStatement(audit.inputText);
    const memoryIds = [];
    try {
      if (forget) {
        // A spoken phrase is a substring query: forget only an unambiguous
        // match of a real phrase ("oublie ça" names nothing). Several matches
        // stay active; the owner forgets them from the memory view.
        const matches = forget.replace(/\s/g, '').length < 4
          ? { notes: [], total: 0 } : await personalNotes.list({ query: forget, limit: 2 });
        if (matches.total === 1) {
          await personalNotes.forget(matches.notes[0].id);
          memoryIds.push(`forgotten:${String(matches.notes[0].id)}`);
        } else {
          memoryIds.push(matches.total ? `forget:ambiguous:${matches.total}` : 'forgotten:no-match');
        }
      } else if (explicit) {
        const memory = await personalNotes.record({ text: explicit, type: 'fact',
          source: 'voix-explicit', sourceTraceId: traceId });
        const memoryId = memory.id;
        if (memoryId) memoryIds.push(memoryId);
        const candidateId = voiceMemoryCandidateId(traceId, 'explicit_memory', explicit);
        await models.MemoryCandidate.findOneAndUpdate(
          { candidateId },
          {
            $setOnInsert: {
              candidateId,
              traceId,
              sessionId: audit.sessionId,
              turnId: audit.sourceTurnId,
              scopeId: audit.scopeId,
              persona: audit.persona,
              type: 'explicit_memory',
              statement: explicit,
              rationale: 'Explicit voice memory request from a completed Dad turn.',
              confidence: 1,
              status: 'applied',
              review: { by: 'explicit-owner-request', at: new Date() },
              memoryId
            }
          },
          { new: true, upsert: true }
        );
      } else if (!blocked) {
        const inferred = inferredMemoryCandidate(audit.inputText);
        if (inferred) {
          const candidateId = voiceMemoryCandidateId(traceId, inferred.type, inferred.statement);
          await models.MemoryCandidate.findOneAndUpdate(
            { candidateId },
            {
              $setOnInsert: {
                candidateId,
                traceId,
                sessionId: audit.sessionId,
                turnId: audit.sourceTurnId,
                scopeId: audit.scopeId,
                persona: audit.persona,
                ...inferred,
                status: 'proposed'
              }
            },
            { new: true, upsert: true }
          );
          memoryIds.push(`candidate:${candidateId}`);
        }
      }
      await conversations.updateTurn(
        { traceId },
        {
          $set: {
            memoryState: 'processed',
            memoryProcessedAt: new Date(),
            memoryNextAttemptAt: null,
            memoryError: blocked ? `skipped:${safety.flagIds.join(',')}` : '',
            memoryIds
          }
        }
      );
      return { traceId, memoryIds, explicit: Boolean(explicit), forget: Boolean(forget), blocked };
    } catch (error) {
      const attempts = Math.max(0, Number(audit.memoryAttempts) || 0) + 1;
      const terminal = attempts >= 5;
      const retryDelaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
      await conversations.updateTurn(
        { traceId },
        {
          $set: {
            memoryState: terminal ? 'failed' : 'captured',
            memoryAttempts: attempts,
            memoryNextAttemptAt: terminal ? null : new Date(Date.now() + retryDelaySeconds * 1000),
            memoryError: cleanText(error.message, 500)
          }
        }
      ).catch(() => {});
      throw error;
    }
  };

  const drainVoixMemoryAudits = async (limit = 10) => {
    const staleClaimBefore = new Date(Date.now() - 5 * 60 * 1000);
    await conversations.updateTurns(
      {
        source: 'voix-native',
        memoryState: 'processing',
        memoryClaimedAt: { $lt: staleClaimBefore }
      },
      { $set: { memoryState: 'captured', memoryError: 'recovered_stale_processing_claim' } }
    );
    const rows = await conversations.listTurns({
      source: 'voix-native',
      memoryState: 'captured',
      $or: [{ memoryNextAttemptAt: null }, { memoryNextAttemptAt: { $lte: new Date() } }]
    }, { sort: { sourceCompletedAt: 1, sequence: 1 }, limit: Math.max(1, Math.min(Number(limit) || 10, 50)) });
    const results = [];
    for (const row of rows) {
      try { results.push(await processVoixMemoryAudit(row.traceId)); }
      catch (error) { logger?.error?.('VoiX memory processing failed', { traceId: row.traceId, error: error.message }); }
    }
    return results.filter(Boolean);
  };
  return { processVoixMemoryAudit, drainVoixMemoryAudits };
}

module.exports = { createVoixMemoryAuditWorker };
