'use strict';

const { executeWithTelemetry } = require('../execution/openclawTelemetry');
const { createOpenClawExecutionClient } = require('../../../../shared/openclawExecutionClient');
const { parseExecutionSource, executionModelId } = require('../../../../shared/executionSource');
const { parametersFor, responseFor } = require('../execution/openclawInference');
const { getActivePrompt, buildSystemPrompt } = require('./chatPromptHelpers');
const { getOrCreateProfile } = require('../../helpers/userHelpers');
const { prepareChatOrchestration } = require('./chatOrchestrationPrelude');
const { persistConversation } = require('./conversationPersistence');

async function handleOpenClawChat(request, client = createOpenClawExecutionClient()) {
  const selection = parseExecutionSource(request);
  const model = executionModelId(selection);
  const persona = request.persona || request.options?.persona || 'default_chat';
  const promptVersion = request.promptVersion ?? request.options?.promptVersion;
  const activePrompt = await getActivePrompt(request.system, persona, {
    preferSystem: request.authoritativeSystem === true, ...(promptVersion != null ? { promptVersion } : {})
  });
  const profile = request.loadUserProfile === false ? {} : await getOrCreateProfile(request.userId);
  const ragRequested = request.allowRag !== false && (request.ragEnabled === true || request.useRag === true || process.env.RAG_ENABLED === 'true');
  // Core assembles context. The explicit OpenClaw source bypasses local routing.
  const context = await prepareChatOrchestration({ message: request.message, caller: 'chat-openclaw',
    ragRequested, ragStore: request.ragStore, ragTopK: request.ragTopK, ragFilters: request.ragFilters,
    ragOptions: request.options, enableWebSearch: request.enableWebSearch,
    onWebSearchStart: request.onWebSearchStart, onWebSearchDone: request.onWebSearchDone });
  const effectiveSystemPrompt = buildSystemPrompt(activePrompt.systemPrompt, profile, context.ragContext);
  const messages = [{ role: 'system', content: effectiveSystemPrompt }, ...(request.messages || [])];
  if (context.webSearchContext) messages.push({ role: 'user', content: `Reference web results:\n\n${context.webSearchContext}` });
  messages.push({ role: 'user', content: request.message });
  const streaming = typeof request.onToken === 'function';
  let result, failure;
  try {
    result = await executeWithTelemetry(client, { execution: selection, model, messages, sessionId: request.conversationId,
      parameters: parametersFor(request), budget: request.budget }, { signal: request.abortSignal,
      timeoutMs: request.upstreamTimeoutMs,
      ...(streaming ? { onToken: token => { if (!request.abortSignal?.aborted) request.onToken(token); },
        onThinking: token => { if (!request.abortSignal?.aborted) request.onThinking?.(token); } } : {}) }, { caller: 'chat', callerDetail: request.callerDetail || 'chat-openclaw' });
  } catch (error) {
    failure = error;
    result = { text: error.partialResponse || '', thinking: error.partialThinking || null, partial: true, finishReason: null,
      receipt: error.executionReceipt || { source: 'openclaw', mode: selection.mode, requested: selection,
        observed: null, usage: null, cost: null, completion: error.executionState || 'unknown' } };
  }
  const body = responseFor(result, model);
  const metadata = { thinking: result.thinking, options: request.options || {}, executionReceipt: result.receipt,
    partial: result.partial, webSearchResults: context.webSearchResults,
    toolExecution: { status: selection.mode === 'agent' ? 'native' : 'not_supported', receipts: [],
      coverage: selection.mode === 'agent' ? 'not-observed-by-responses-api' : 'no-runtime-tools' } };
  const saved = request.persist === false ? { persistence: { saved: false } } : await persistConversation({
    userId: request.userId, conversationId: request.conversationId, model, effectiveSystemPrompt,
    message: request.message, assistantContent: result.text, activePrompt, metadata,
    stats: body.stats, ragUsed: context.ragUsed, useRag: ragRequested, ragSources: context.ragSources });
  if (failure) { request.onError?.(failure); if (!streaming) throw failure; return; }
  const response = { response: result.text, thinking: result.thinking, model, target: 'openclaw', execution: selection,
    executionReceipt: result.receipt, conversationId: saved.conversation?._id || null,
    messageId: saved.assistantMessageId || null, persistence: saved.persistence,
    stats: body.stats, partial: result.partial, ragUsed: context.ragUsed, ragSources: context.ragSources,
    webSearchResults: context.webSearchResults, prompt: { name: activePrompt.name || persona, version: activePrompt.version },
    warning: result.partial ? 'The reply is partial or model termination could not be verified.' : saved.persistence?.warning };
  if (streaming) await request.onComplete?.(response);
  return response;
}

function withOpenClawChat(localHandler, client) {
  return request => {
    const selection = parseExecutionSource(request);
    return selection?.source === 'openclaw' ? handleOpenClawChat(request, client) : localHandler(request);
  };
}

module.exports = { handleOpenClawChat, withOpenClawChat };
