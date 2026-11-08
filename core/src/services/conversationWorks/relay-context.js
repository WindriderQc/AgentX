'use strict';

const { hash, nativeWork } = require('./contract');

// This projection labels received dialogue; it never admits or resumes work.
// Legacy turns and declared speakers/models are insufficient native evidence.
function replyAttribution(row, turn) {
  const unknown = { role: 'unknown' };
  const guardian = row?.guardian, evidence = turn.toolEvidence;
  if (row?.mode !== 'native' || row.turnId !== turn.turnId || row.requestSha256 !== hash(turn.inputText)
      || !guardian?.sessionId || !guardian.agentId || ['main', 'family'].includes(guardian.agentId)
      || guardian.sessionKey !== `agent:${guardian.agentId}:household:direct:${guardian.sessionId}`
      || !/^resp_[a-f0-9-]{36}$/.test(guardian.runId || '')
      || guardian.state !== 'completed' || turn.outcome !== 'completed'
      || evidence?.status !== 'observed' || evidence.authority !== `openclaw/${guardian.agentId}`
      || evidence.runId !== guardian.runId || evidence.run?.runId !== guardian.runId
      || evidence.run.sessionKey !== guardian.sessionKey || evidence.run.status !== 'completed') return unknown;
  return { role: 'relay', authority: 'core.conversation-works', workId: row._id,
    requestSha256: row.requestSha256, agentId: guardian.agentId,
    sessionKey: guardian.sessionKey, runId: guardian.runId };
}

function resultAttribution(row, evidence) {
  const attempt = row.attempt;
  const received = evidence.find(item => item.tool === 'native.consultation' && item.status === 'observed'
    && item.runId === attempt?.runId)?.data;
  if (!nativeWork(row) || attempt?.agentId !== 'main' || received?.authority !== 'openclaw.nestor'
      || received.run?.runId !== attempt.runId || received.run.sessionKey !== attempt.sessionKey
      || received.run.status !== 'completed' || received.answer?.runId !== attempt.runId
      || received.answer.status !== 'ready') return { role: 'unknown' };
  return { role: 'leading', authority: 'core.conversation-works', agentId: attempt.agentId,
    sessionKey: attempt.sessionKey, runId: attempt.runId };
}

module.exports = { replyAttribution, resultAttribution };
