import { createConversationWorkClient } from './conversation-work.js';

export function registerNativeReadBudget(api, { fetchImpl = fetch } = {}) {
  const config = api.pluginConfig || {};
  if (!config.conversationWorkToken || !config.conversationWorkAgentId) return;
  const call = createConversationWorkClient({ baseUrl: config.agentxUrl, token: config.conversationWorkToken, fetchImpl });
  const runs = new Map();
  api.on('before_tool_call', async (event, context) => {
    if (context?.agentId !== 'main' || !/^agent:main:household:direct:[a-f0-9-]{36}$/.test(context.sessionKey || '')) return;
    const runId = event.runId || context.runId, callId = event.toolCallId || context.toolCallId;
    if (!runId || !callId) return;
    const key = `${context.sessionKey}:${runId}`;
    if (runs.get(key) === 'ordinary') return;
    const tool = event.toolName === 'tool_call' ? String(event.params?.id || '').split(':').at(-1) : event.toolName;
    try {
      const result = await call('native_budget', { agentId: context.agentId, sessionKey: context.sessionKey, runId }, { tool }, callId);
      runs.set(key, 'bounded');
      if (runs.size > 1000) runs.delete(runs.keys().next().value);
      if (result.admitted === true) return;
      return { block: true, blockReason: 'This consultation has exhausted its bounded research budget. No further tool was executed. Finish now with a concise answer supported by the sources already read, or explain exactly what the lookup could not verify. Do not invent a fact, try another URL, discover another tool, or claim you lack web access.' };
    } catch (cause) {
      // A guardian, specialist or unbounded native action has no such work.
      if (cause.statusCode === 404 && runs.get(key) !== 'bounded') {
        runs.set(key, 'ordinary');
        if (runs.size > 1000) runs.delete(runs.keys().next().value);
        return;
      }
      return { block: true, blockReason: 'Core could not confirm this native research admission. No tool was executed. Conclude with the verified information already available and explain the lookup failure; do not retry or dispatch replacement research.' };
    }
  });
}
