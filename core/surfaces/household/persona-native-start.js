'use strict';

const { agentIdFor } = require('./conversation-agent');

// Persist the exact foreground native identity without moving another role's
// session key. Background Main uses its original work observer's own binding.
function nativeTurnStarted({ entry, session, turnSession, member, guardianSession, backend, inputOnly, conversations, conversationWorks }) {
  return async (key, runId) => {
    if (entry.workId && runId) await conversationWorks.guardianStarted(entry.workId, key, runId, agentIdFor(turnSession));
    if (runId) entry.auditContext = { ...entry.auditContext,
      toolEvidence: { authority: backend === 'hermes' ? 'hermes' : `openclaw/${agentIdFor(turnSession)}`, sessionKey: key, runId } };
    if (inputOnly && backend === 'openclaw' && session.scopeId === 'personal' && session.packId === 'personal_operator'
        && agentIdFor(turnSession) === 'main' && !entry.workId && !member && !guardianSession
        && key === 'agent:main:household:direct:' + session.sessionId) {
      entry.foregroundRunId = runId;
    }
    if (member || guardianSession) {
      const keys = { ...(session.agentSessionKeys || {}), [agentIdFor(turnSession)]: key };
      await conversations.updateSession({ sessionId: session.sessionId }, { $set: { agentSessionKeys: keys } });
      session.agentSessionKeys = keys;
    } else {
      await conversations.updateSession({ sessionId: session.sessionId }, { $set: { agentSessionKey: key } });
      session.agentSessionKey = key;
    }
    turnSession.agentSessionKey = key;
  };
}

function isForegroundRun(activeTurns, context) {
  if (context?.agentId !== 'main' || typeof context.sessionKey !== 'string'
      || !/^resp_[a-f0-9-]{36}$/.test(context.runId || '')) return false;
  const session = /^agent:main:household:direct:([a-f0-9-]{36})$/.exec(context.sessionKey);
  const entry = session && activeTurns?.get(session[1]);
  return Boolean(entry && entry.foregroundRunId === context.runId && !entry.executionSettled
    && !entry.interrupted && !entry.abort.signal.aborted);
}

module.exports = { nativeTurnStarted, isForegroundRun };
