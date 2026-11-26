import { isTranslationSession } from '../../../shared/quotedTranslation.cjs';
import { createConversationWorkClient } from './conversation-work.js';

export function registerNativeReadBudget(api, { fetchImpl = fetch } = {}) {
  const config = api.pluginConfig || {};
  if (!config.conversationWorkToken || !config.conversationWorkAgentId) return;
  const call = createConversationWorkClient({ baseUrl: config.agentxUrl, token: config.conversationWorkToken, fetchImpl });
  const runs = new Map();
  const hooks = api.config?.plugins?.entries?.['super-dad-memory']?.hooks;
  const canPrepareTranslation = hooks?.allowConversationAccess === true && hooks.allowPromptInjection !== false;
  if (canPrepareTranslation) {
    api.on('before_prompt_build', (_event, context) => {
      if (context?.agentId !== 'main' || !isTranslationSession(context.sessionKey)) return;
      return {
        systemPrompt: 'Translate the words inside the quotation into the language requested by the user. Return only the translated words as one line of plain text.',
        toolsAllow: []
      };
    });
  }
  api.on('before_tool_call', async (event, context) => {
    if (isTranslationSession(context?.sessionKey)) return { block: true,
      blockReason: 'This isolated session translates the supplied quotation. Return the translation directly.' };
    // OpenClaw runs this hook again for the resolved tool, with its own native
    // call identity. The dispatch wrapper performs no research: count and fence
    // the actual tool execution once, including a tool that later fails.
    if (event.toolName === 'tool_call') return;
    if (context?.agentId !== 'main' || !/^agent:main:household:direct:[a-f0-9-]{36}$/.test(context.sessionKey || '')) return;
    const runId = event.runId || context.runId, callId = event.toolCallId || context.toolCallId;
    if (!runId || !callId) return;
    const key = `${context.sessionKey}:${runId}`;
    if (runs.get(key) === 'ordinary') return;
    const tool = event.toolName;
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
  return canPrepareTranslation;
}
