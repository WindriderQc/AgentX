'use strict';

const { agentIdFor } = require('./conversation-agent');

// Persist the exact foreground native identity without moving another role's
// session key. Background Main uses its original work observer's own binding.
function nativeTurnStarted({ entry, session, turnSession, member, guardianSession, backend, conversations, conversationWorks }) {
  return async (key, runId) => {
    if (entry.workId && runId) await conversationWorks.guardianStarted(entry.workId, key, runId, agentIdFor(turnSession));
    if (runId) entry.auditContext = { ...entry.auditContext,
      toolEvidence: { authority: backend === 'hermes' ? 'hermes' : `openclaw/${agentIdFor(turnSession)}`, sessionKey: key, runId } };
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

module.exports = { nativeTurnStarted };
