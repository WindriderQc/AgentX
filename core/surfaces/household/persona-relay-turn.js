'use strict';

// Reuse the existing detached member transport and result delivery. The native
// Hermes journal remains the sole run/receipt owner; this starts no worker.
async function prepare({ entry, session, backend, conversationEnv, clientTurnId, streaming, memberWork, activePersonaTurns, res, conversations, userText, channel, speechLanguage }) {
  if (conversationEnv.HOUSEHOLD_CONVERSATION_RELAY_ENABLED !== 'true' || session.llmx || session.ephemeral || !clientTurnId
      || !(backend === 'hermes' && session.packId === 'personal_operator' && session.scopeId === 'personal'
        || backend === 'agentx' && session.packId === 'kidx_nestor' && session.scopeId === 'family')) return;
  const accepted = await conversations.acceptTurn({ sessionId: session.sessionId, packId: session.packId, scopeId: session.scopeId,
    modeId: session.modeId, traceId: clientTurnId, clientTurnId, inputText: userText, attachments: entry.attachments,
    channel: channel === 'voice' ? 'voice' : 'text', speechLanguage });
  entry.relayIntake = true; entry.relayDuplicate = accepted.duplicate;
  if (accepted.duplicate) entry.auditWritten = true;
  if (backend !== 'hermes' || !streaming || !memberWork || accepted.duplicate) return;
  entry.detach = () => {
    const native = entry.auditContext?.toolEvidence;
    if (entry.detached || entry.executionSettled || entry.abort.signal.aborted || native?.authority !== 'hermes'
        || !native.runId || native.sessionKey !== 'agentx:personal:' + session.sessionId) return false;
    memberWork.start(session.sessionId, clientTurnId, { agentId: 'main', name: session.persona?.name || 'Nestor',
      question: userText, cancel: () => { entry.interrupted = true; entry.abort.abort(); } });
    entry.detached = true;
    if (activePersonaTurns.get(session.sessionId) === entry) activePersonaTurns.delete(session.sessionId);
    if (!res.writableEnded) res.end();
    return true;
  };
}
module.exports = { prepare };
