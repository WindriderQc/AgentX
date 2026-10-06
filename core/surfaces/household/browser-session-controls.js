'use strict';

// Browser session controls shared by the Household persona routers: session
// listing and paging, history, rename, erase, open-hold and audio routes for
// one pack and scope, registered on a given router.

const llmx = require('./llmx-conversation');
const personaCatalog = require('./persona-catalog');
const { packById } = require('./packs');
const { publicSession, loadSessionAuditRows, publicAudit, sessionHistoryMessages } = require('./persona-records');
const { spokenReplyLanguage } = require('./persona-prompt');
const { normalizeVoiceTimings } = require('../../src/services/voice/timeline');

function createBrowserSessionControls({
  personas, conversations, envelope, cleanText, fail, activePersonaTurns,
  validClientTurnId, nestorClient, memberWork = null
}) {
  function registerBrowserSessionControls(prefix, packId, scopeId, router = personas, consumer = null) {
    const sessionScope = consumer === 'llmx' ? llmx.sessionScope(scopeId === 'family' ? 'family' : 'personal')
      : { packId, ...(scopeId ? { scopeId } : {}) };
    router.get(`${prefix}/sessions/recent`, async (req, res) => {
      try {
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 3, 5));
        const pack = packById(packId);
        const personaOnly = req.query.personaOnly === 'true';
        const sessions = await conversations.listSessions({
          ...sessionScope,
          status: 'active',
          turnCount: { $gt: 0 }, ...(Date.parse(req.query.before) ? { lastTurnAt: { $lt: new Date(req.query.before) } } : {}), // older page
          ...(personaOnly ? { 'persona.id': { $exists: true, $ne: '' } } : {})
        }, { sort: { lastTurnAt: -1, createdAt: -1 }, limit: limit * 3 });
        const resumable = sessions.filter((session) => pack.modes.some((mode) => mode.id === session.modeId)
          && (!personaOnly || session.persona?.id)).slice(0, limit);
        return envelope(res, {
          sessions: await Promise.all(resumable.map(async session => {
            const result = publicSession(session);
            if (!personaOnly && req.query.preview !== 'true') return result; // previews without narrowing
            // At most five indexed, session-scoped reads of the latest audit row.
            const [last] = await loadSessionAuditRows(conversations, session, { historyTurns: 2 });
            return { ...result, lastTurn: last ? {
              inputPreview: cleanText(last.inputText || last.inputPreview, 240),
              replyPreview: cleanText(last.replyText || last.replyPreview, 240)
            } : null };
          })),
          policy: {
            historyAuthority: 'agentx.core.conversations',
            automaticResume: consumer === 'llmx' ? 'exact-client-stored-session-only' : false,
            childResume: packId === 'kidx_nestor',
            maximumSessions: 5
          }
        });
      } catch (error) {
        return fail(res, 500, error.message, 'VOICE_PERSONA_PRIVATE_SESSIONS_FAILED');
      }
    });
    router.get(`${prefix}/sessions/:sessionId/history`, async (req, res) => {
      try {
        const session = await conversations.getSession({
          sessionId: cleanText(req.params.sessionId, 64),
          ...sessionScope,
          status: 'active'
        });
        if (!session) return fail(res, 404, 'Conversation not found in this space', 'VOICE_PERSONA_SESSION_NOT_FOUND');
        const pack = packById(packId);
        if (!pack.modes.some((mode) => mode.id === session.modeId)) {
          return fail(res, 409, 'This session uses a retired mode and cannot be resumed.', 'VOICE_PERSONA_SESSION_MODE_UNAVAILABLE');
        }
        const rows = await loadSessionAuditRows(conversations, session, pack);
        let lastReply = null;
        if (consumer === 'llmx') {
          const [completed] = await conversations.listTurns({ sessionId: session.sessionId, packId, scopeId: session.scopeId,
            source: 'graphysx-llmx', outcome: 'completed' }, { sort: { createdAt: -1 }, limit: 1 });
          if (completed?.replyText?.trim()) {
            const language = spokenReplyLanguage(completed.replyText, completed.inputText || '');
            lastReply = { turnId: completed.clientTurnId, reply: { text: completed.replyText, language,
              speech: personaCatalog.speechFor(session.persona, language, session.voice) } };
          }
        }
        return envelope(res, {
          session: { ...publicSession(session), ...(consumer === 'llmx' ? { llmx: { schemaVersion: 1, opening: llmx.publicOpening(session.llmx.opening, activePersonaTurns.has(session.sessionId)) } } : {}) },
          turns: rows.slice().reverse().map(publicAudit),
          history: sessionHistoryMessages(rows, pack),
          ...(consumer === 'llmx' ? { lastReply } : {}),
          policy: {
            historyAuthority: 'agentx.core.conversations',
            automaticResume: consumer === 'llmx' ? 'exact-client-stored-session-only' : false,
            childResume: packId === 'kidx_nestor',
            maximumMessages: pack.historyTurns
          }
        });
      } catch (error) {
        return fail(res, 500, error.message, 'VOICE_PERSONA_PRIVATE_HISTORY_FAILED');
      }
    });

    router.post(`${prefix}/sessions/:sessionId/interrupt`, async (req, res) => {
      const clientTurnId = req.body?.turnId;
      if (!validClientTurnId(clientTurnId)) return fail(res, 400, 'A valid turnId is required', 'VOICE_INTERRUPTION_INVALID');
      const entry = activePersonaTurns.get(req.params.sessionId);
      let timer;
      // A stop reaches the team members still working in the background as well.
      if (req.body?.stop === true) memberWork?.cancel(req.params.sessionId);
      try {
        if (entry) {
          if (entry.clientTurnId !== clientTurnId) {
            return fail(res, 409, 'This is not the current browser turn', 'VOICE_INTERRUPTION_MISMATCH');
          }
          let wrongScope = false, detached = false;
          const settlement = (async () => {
            // Admission owns the turn synchronously, before Mongo resolves its
            // session. A correlated interruption waits for that validation;
            // an absent snapshot is not evidence of an absent conversation.
            const snapshot = entry.snapshot || await entry.ready;
            if (!snapshot || snapshot.packId !== packId || (scopeId && snapshot.scopeId !== scopeId)
                || (consumer === 'llmx' && (!entry.llmx || snapshot.modeId !== sessionScope.modeId))) {
              wrongScope = true; return true;
            }
            // Speaking over a team member does not cancel it; only an explicit stop does.
            if (req.body?.stop !== true && entry.detach?.()) { detached = true; return true; }
            entry.interrupted = true;
            entry.abort.abort();
            await entry.finished;
            return true;
          })();
          const settled = await Promise.race([settlement, new Promise(resolve => {
            timer = setTimeout(() => resolve(false), 10000);
          })]);
          if (!settled) return envelope(res, { interrupted: false, pending: true, turnId: clientTurnId }, 202);
          if (wrongScope) return fail(res, 404, 'Conversation not found in this space', 'VOICE_PERSONA_SESSION_NOT_FOUND');
          if (detached) return envelope(res, { interrupted: false, detached: true, turnId: clientTurnId });
          if (entry.error && !entry.executionSettled) throw entry.error;
        }
        if (consumer === 'llmx' && !await conversations.getSession({ sessionId: cleanText(req.params.sessionId, 64),
          ...sessionScope, status: 'active' })) return fail(res, 404, 'Conversation not found in this space', 'VOICE_PERSONA_SESSION_NOT_FOUND');
        // Short replies may have finished generating before playback is interrupted.
        // Mark the same existing audit so history never implies it was fully heard.
        const audit = await conversations.updateTurn({
          sessionId: cleanText(req.params.sessionId, 64), clientTurnId,
          packId, ...(scopeId ? { scopeId } : {}), ...(consumer === 'llmx' ? { source: 'graphysx-llmx' } : { channel: 'voice' })
        }, { $set: { interrupted: true } });
        if (!audit) return fail(res, 409, 'The voice turn is no longer available', 'VOICE_INTERRUPTION_UNAVAILABLE');
        if (audit.interruptionState === 'failed') {
          const native = audit.toolEvidence;
          if (native?.sessionKey?.endsWith(`:household:direct:${audit.sessionId}`) && /^resp_[a-f0-9-]{36}$/.test(native.runId || '')) {
            // A hook can arrive after the original stop deadline. Observe only
            // this recorded run; never retry inference or adopt another session.
            const evidence = await nestorClient({ operation: 'turn', sessionKey: native.sessionKey, runId: native.runId });
            if (evidence?.run?.runId === native.runId && evidence.run.sessionKey === native.sessionKey
                && ['completed', 'failed'].includes(evidence.run.status)) {
              await conversations.updateTurn({ _id: audit._id, interruptionState: 'failed' },
                { $set: { interruptionState: 'confirmed', 'toolEvidence.run': evidence.run } });
              return envelope(res, { interrupted: true, turnId: clientTurnId });
            }
          }
          return fail(res, 503, 'La fin du tour précédent reste non confirmée. Son historique est conservé. Utilise Nouvelle conversation pour reprendre.'
            + (consumer === 'llmx' ? ' Le monde 3D sera conservé.' : ''), 'VOICE_INTERRUPTION_FAILED');
        }
        return envelope(res, { interrupted: true, turnId: clientTurnId });
      } catch (error) {
        return fail(res, 503, error.message || 'Unable to stop the previous turn', 'VOICE_INTERRUPTION_FAILED');
      } finally { clearTimeout(timer); }
    });

    // The browser's timeline of one spoken turn (#9), kept on that recorded turn.
    // The turn is recorded just before its `done`: until then the page is told
    // to send the timeline again once the turn's request has ended.
    if (consumer !== 'llmx') router.post(`${prefix}/sessions/:sessionId/voice-timings`, async (req, res) => {
      const clientTurnId = req.body?.turnId, sessionId = cleanText(req.params.sessionId, 64);
      const voiceTimings = normalizeVoiceTimings(req.body?.timings);
      if (!validClientTurnId(clientTurnId) || !voiceTimings) {
        return fail(res, 400, 'A valid turnId and bounded timings are required', 'VOICE_TIMINGS_INVALID');
      }
      try {
        const audit = await conversations.updateTurn({ sessionId, clientTurnId, packId, ...(scopeId ? { scopeId } : {}), channel: 'voice' },
          { $set: { voiceTimings } });
        if (audit) return envelope(res, { turnId: clientTurnId, voiceTimings: audit.voiceTimings });
        const active = activePersonaTurns.get(sessionId);
        if (active?.clientTurnId === clientTurnId && active.snapshot?.packId === packId && (!scopeId || active.snapshot.scopeId === scopeId)) {
          return envelope(res, { pending: true, turnId: clientTurnId }, 202);
        }
        return fail(res, 404, 'This voice turn is not recorded', 'VOICE_TIMINGS_TURN_NOT_RECORDED');
      } catch (error) {
        return fail(res, 503, error.message || 'Voice timings are unavailable', 'VOICE_TIMINGS_FAILED');
      }
    });
  }
  return registerBrowserSessionControls;
}

module.exports = { createBrowserSessionControls };
