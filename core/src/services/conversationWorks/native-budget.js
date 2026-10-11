'use strict';
const { hash, fail, notFound } = require('./contract');

// Core retains admissions in the existing work, including failed native reads.
// A restart or a different URL cannot reset the consultation's budget.
function createNativeBudget({ repo, conversations, session, query, policy, now }) {
  return async (context, input, callId) => {
    if (!context || Object.keys(context).some(k => !['agentId', 'sessionKey', 'runId'].includes(k))
        || context.agentId !== 'main' || !/^resp_[a-f0-9-]{36}$/.test(context.runId || '')) throw notFound();
    const [row] = await repo.find({ classification: 'native_read', 'attempt.agentId': 'main',
      'attempt.sessionKey': context.sessionKey }, 1);
    if (!row || row.mode !== 'read' || row.attempt.runId && row.attempt.runId !== context.runId) throw notFound();
    await session(row.sessionId);
    const turn = await conversations.getTurn({ ...query(row.sessionId), traceId: row.turnId });
    if (!turn || hash(turn.inputText) !== row.requestSha256) throw notFound();
    const limits = policy(turn.inputText);
    if (!limits) throw notFound();
    const denied = { authority: 'core.conversation-works', admitted: false, workId: row._id, limits };
    if (!['running', 'dispatching', 'uncertain'].includes(row.state)) return denied;
    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(callId || '') || !input
        || Object.keys(input).some(k => k !== 'tool') || !/^[a-zA-Z0-9_.-]{1,100}$/.test(input.tool || '')) {
      throw fail('CONVERSATION_WORK_BUDGET_INVALID', 'A native tool identity is required.');
    }
    const id = hash(row.attempt.id + '\n' + callId);
    const saved = await repo.mutate(row._id, current => {
      if (!['running', 'dispatching', 'uncertain'].includes(current.state)
          || current.attempt.id !== row.attempt.id || current.attempt.runId && current.attempt.runId !== context.runId) return null;
      const calls = current.nativeAdmissions || [], previous = calls.find(c => c.id === id);
      if (previous) {
        if (previous.tool !== input.tool) throw fail('CONVERSATION_WORK_TOOL_CONFLICT', 'The native tool identity changed.', 409);
        return null;
      }
      if (calls.length >= limits.tools || calls.filter(c => ['web_search', 'web_fetch'].includes(c.tool)).length >= limits.web) return null;
      return { fields: { attempt: { ...current.attempt, runId: context.runId },
        nativeAdmissions: [...calls, { id, tool: input.tool, at: now() }] }, event: 'native_tool_admitted' };
    });
    return { authority: 'core.conversation-works', admitted: ['running', 'dispatching', 'uncertain'].includes(saved.state)
        && saved.attempt.id === row.attempt.id && saved.attempt.runId === context.runId
        && saved.nativeAdmissions?.some(c => c.id === id) === true,
      workId: row._id, limits };
  };
}
module.exports = { createNativeBudget };
