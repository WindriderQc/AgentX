/**
 * Chat messaging — appendMessage, sendMessage and streaming
 */
import {
  describePendingRuntimeChange, getHostChatState, getRagOptions, isAutoRoutingMode, isRouterMode,
  readOptions, readProfileInputs, selectedHostPreference, sessionTaskType, targetHost
} from './chat-config.js';
import { buildRoutingInfo } from './chat-routing-info.js';
import {
  errorFromResponse, failedTurnMessage, outcomeAttemptId, persistTerminalTurn, recordFailedTurn
} from './chat-turn-outcome.js';
import {
  isUserRequestedStreamStop, messageIdOf, renderMessage, sanitizeHTML, turnActionForRequest
} from './chat-message-render.js';

// Rendering and model helpers live in their own modules; importers keep using this one.
export {
  formatTime, handleSendButtonAction, isUserRequestedStreamStop, renderMessage, sanitizeHTML, setFeedback,
  setStatus, showModal, turnActionForRequest, userTurnForAssistant
} from './chat-message-render.js';
export { cancelModelWarmup, fetchModels, warmupModelIfNeeded } from './chat-models.js';
export { buildRoutingInfo };

export function appendMessage(messageOrRole, contentOrOptions, state, elements) {
  const options = typeof messageOrRole === 'string' ? {} : (contentOrOptions || {});
  const persist = options.persist !== false;
  const count = options.count !== false;

  const message = typeof messageOrRole === 'string'
    ? {
        role: messageOrRole,
        content: contentOrOptions || '',
        createdAt: new Date().toISOString(),
        id: `m-${Date.now()}`,
      }
    : {
        ...messageOrRole,
        createdAt: messageOrRole.createdAt || new Date().toISOString(),
      };

  renderMessage(message, state, elements);

  if (persist) state.history.push(message);
  if (count) {
    if (message.role === 'user') state.stats.messages += 1;
    if (message.role === 'assistant') state.stats.replies += 1;
  }
  elements.statMessages.textContent = state.stats.replies;

  if (options.announcement && elements.chatAnnouncements) {
    elements.chatAnnouncements.textContent = '';
    window.setTimeout(() => {
      elements.chatAnnouncements.textContent = options.announcement;
    }, 0);
  }
}

export function historyBeforeCurrentTurn(history, currentUserMessageId) {
  const turns = Array.isArray(history) ? history : [];
  if (!currentUserMessageId || turns.length === 0) return turns;
  const normalizedId = String(currentUserMessageId);
  const currentTurnIndex = turns.findIndex((turn) => (
    turn?.role === 'user' && messageIdOf(turn) === normalizedId
  ));
  return currentTurnIndex >= 0 ? turns.slice(0, currentTurnIndex) : turns;
}

function buildPayload(
  elements,
  state,
  defaults,
  message,
  currentUserMessageId = null,
  turnAction = null
) {
  const ragOpts = getRagOptions(elements);
  const routerMode = isRouterMode(elements, state);
  const forceThinking = elements.thinkingToggle?.checked === true;
  // Standard classifies each turn. Quick/Deep use fixed task lanes and Manual
  // sends the explicit model+host.
  const taskType = routerMode ? sessionTaskType(elements, state) : null;
  const rawOptions = {
    ...readOptions(elements),
    persona: elements.promptSelect?.value || 'default_chat',
    ragExpand: ragOpts.ragExpand,
    ragHybrid: ragOpts.ragHybrid,
    ragRerank: ragOpts.ragRerank,
    ragCompress: ragOpts.ragCompress
  };
  const options = Object.fromEntries(
    Object.entries(rawOptions).filter(([, value]) => value !== '' && value !== undefined && value !== null)
  );
  return {
    target: routerMode ? undefined : targetHost(elements, defaults),
    model: routerMode ? 'auto' : elements.modelSelect.value,
    autoRoute: isAutoRoutingMode(elements, state),
    taskType: taskType || undefined,
    system: elements.systemPrompt.value.trim(),
    promptVersion: elements.promptSelect?.dataset.promptVersion
      ? Number(elements.promptSelect.dataset.promptVersion)
      : undefined,
    options,
    useRag: ragOpts.useRag,
    ragTopK: ragOpts.ragTopK,
    enableWebSearch: elements.webSearchToggle?.checked || false,
    thinkingMode: forceThinking ? 'on' : 'auto',
    ...(forceThinking ? { think: true } : {}),
    threadId: state.threadId,
    message,
    profile: readProfileInputs(elements),
    // The visible user turn is persisted before dispatch. The service appends
    // `message` to the inference envelope, so exclude that exact turn by id
    // while preserving intentional earlier prompts with identical text.
    messages: historyBeforeCurrentTurn(state.history, currentUserMessageId),
    conversationId: state.conversationId,
    ...(turnAction ? { turnAction } : {})
  };
}

function markSelectedManualModelLoaded(elements, state, defaults, model) {
  if (!model || isRouterMode(elements, state)) return;
  state.sessionLoadedModel = {
    host: targetHost(elements, defaults, { includeRouter: true }),
    model
  };
  const pref = selectedHostPreference(elements, state, defaults);
  if (!pref) return;
  pref.loadedModel = model;
  pref.loadedModels = [model];
  pref.live = {
    ...(pref.live || {}),
    online: pref.live?.online !== false,
    runningModels: [{ name: model }]
  };
}

function safeChatFailureMessage(value) {
  const normalized = String(value || 'The chat request could not be completed.')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, '[redacted credential]')
    .replace(/\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '[redacted credential]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[service endpoint]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[service host]')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.slice(0, 600) || 'The chat request could not be completed.';
}

export function chatFailureDetails(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  const message = safeChatFailureMessage(error?.message);
  const normalized = `${code} ${message}`.toLowerCase();
  let guidance = 'Retry the turn. If it fails again, open Nerve Center and choose a ready host/model.';
  let status = 'Response failed';
  let tone = 'error';

  if (normalized.includes('public_exposure_guard')
      || normalized.includes('cross_site_mutation_forbidden')
      || normalized.includes('trusted operator path')) {
    guidance = 'Open Agent X from its HTTPS portal, then retry. Direct service addresses are read-only for browser mutations.';
    status = 'Secure portal required';
  } else if (/model unavailable|model .*not found|source_user_message_not_found/.test(normalized)) {
    guidance = 'Take the controls and choose a model that is installed on a ready host.';
    status = 'Model route needs attention';
    tone = 'warning';
  } else if (/restoring|swapping|benchmarking|warming/.test(normalized)) {
    guidance = 'The selected host is changing models. Choose a ready Manual host or retry after restoration completes.';
    status = 'Host is not ready';
    tone = 'warning';
  } else if (/timeout|timed out|stream ended before completion/.test(normalized)) {
    guidance = 'Retry with Quick mode or a ready Manual host. The incomplete attempt remains in history.';
    status = 'Response timed out';
    tone = 'warning';
  } else if (/stream_interrupted|response stream was interrupted/.test(normalized)) {
    guidance = 'Retry the turn. The interrupted attempt remains in history.';
    status = 'Response interrupted';
    tone = 'warning';
  } else if (/conversation_not_found/.test(normalized)) {
    guidance = 'This conversation is archived or no longer exists. Start a new chat to continue.';
    status = 'Conversation unavailable';
  } else if (/conversation_persist_failed/.test(normalized)) {
    guidance = 'The reply was generated but not saved to history. Retry the turn.';
    status = 'Reply not saved';
  } else if (/no readable stream|streaming not supported/.test(normalized)) {
    guidance = 'Turn streaming off and retry; this browser or proxy did not provide a readable stream.';
    status = 'Streaming unavailable';
    tone = 'warning';
  }

  return { code: code || null, message, guidance, status, tone };
}

export async function sendMessageStreamFetch(
  ctx,
  msgInput,
  modelInput,
  currentUserMessageId = null,
  turnAction = null,
  clientTurnId = null
) {
  const { elements, state, defaults, helpers } = ctx;
  const message = msgInput || elements.messageInput.value.trim();

  const payload = buildPayload(
    elements,
    state,
    defaults,
    message,
    currentUserMessageId,
    turnAction
  );
  // One id per turn: the server stores a repeated send once, and a failed
  // turn's outcome record agrees with the chat request it belongs to.
  const terminalAttemptId = clientTurnId || outcomeAttemptId(currentUserMessageId);
  payload.clientTurnId = terminalAttemptId;

  const assistantMessageDiv = document.createElement('div');
  assistantMessageDiv.className = 'message assistant';
  assistantMessageDiv.dataset.messageId = `a-${Date.now()}`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  assistantMessageDiv.appendChild(contentDiv);

  // Private reasoning is opt-in. It is rendered only when the operator has
  // forced Thinking in the controls, and then inside a closed disclosure the
  // reader must open. Otherwise it is neither rendered nor kept.
  const reasoningOptIn = elements.thinkingToggle?.checked === true;
  const thinkingDiv = document.createElement('details');
  thinkingDiv.className = 'thinking-content';
  thinkingDiv.hidden = true;
  thinkingDiv.innerHTML = '<summary>Reasoning (shown because Thinking is forced)</summary><div class="thinking-body"></div>';
  const thinkingBody = thinkingDiv.querySelector('.thinking-body');
  assistantMessageDiv.appendChild(thinkingDiv);

  elements.chatWindow.appendChild(assistantMessageDiv);
  elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;

  elements.sendBtn.textContent = 'Stop';

  let fullContent = '';
  let thinkingContent = '';
  let doneReceived = false;
  let requestAbortController = null;

  const safeParseJson = (text, fallback) => {
    try { return JSON.parse(text); } catch { return fallback; }
  };

  const dispatchEvent = (eventName, rawData) => {
    if (eventName === 'token') {
      const data = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
      fullContent += data.content || '';
      try {
        contentDiv.innerHTML = sanitizeHTML(marked.parse(fullContent));
      } catch (e) {
        contentDiv.textContent = fullContent;
      }
      elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
      return;
    }
    if (eventName === 'thinking') {
      if (!reasoningOptIn) return; // discarded: never rendered, never persisted
      const data = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
      thinkingContent += data.content || '';
      if (thinkingBody) thinkingBody.innerHTML = sanitizeHTML(marked.parse(thinkingContent));
      thinkingDiv.hidden = false;
      elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
      return;
    }
    if (eventName === 'web-search-start') {
      contentDiv.innerHTML = '<span style="color:var(--accent);font-size:0.9em;"><i class="fas fa-globe" style="margin-right:4px"></i> Searching web\u2026</span>';
      elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
      return;
    }
    if (eventName === 'web-search-done') {
      const data = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
      const count = Number.isInteger(data.resultCount) && data.resultCount >= 0 ? data.resultCount : 0;
      contentDiv.innerHTML = `<span style="color:var(--accent);font-size:0.9em;"><i class="fas fa-globe" style="margin-right:4px"></i> Found ${count} result${count !== 1 ? 's' : ''}. Thinking\u2026</span>`;
      elements.chatWindow.scrollTop = elements.chatWindow.scrollHeight;
      return;
    }
    if (eventName === 'done') {
      const finalData = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
      state.conversationId = finalData.conversationId || state.conversationId;
      const routingInfo = buildRoutingInfo(finalData);
      if (routingInfo?.model) state.lastRoutedModel = routingInfo.model;
      const assistantMessage = {
        role: 'assistant', content: fullContent,
        createdAt: new Date().toISOString(),
        id: finalData.messageId || null,
        sourceUserMessageId: currentUserMessageId,
        stats: finalData.stats || null,
        thinking: thinkingContent || null,
        webSearchResults: finalData.webSearchResults || null,
        ragStatus: finalData.ragStatus || null,
        routingInfo
      };
      if (elements.chatWindow.contains(assistantMessageDiv)) elements.chatWindow.removeChild(assistantMessageDiv);
      helpers.appendMessage(assistantMessage, { announcement: 'Assistant response complete.' });
      helpers.speakText(fullContent);
      helpers.setFeedback('Response received.', 'success');
      helpers.loadHistoryList();
      if (state.conversationId) helpers.loadConversation(state.conversationId, true);
      if (window.checkSetupProgress) setTimeout(() => window.checkSetupProgress(), 500);
      doneReceived = true;

      // Update Chat Intelligence status bar
      if (routingInfo && typeof ChatIntelligence !== 'undefined') {
        ChatIntelligence.updateStatusBar({
          model: routingInfo.model,
          host: routingInfo.hostName,
          hostHealth: routingInfo.hostHealth,
          routeReason: routingInfo.taskType || 'direct',
          contextSize: routingInfo.numCtx
        });
      }
      markSelectedManualModelLoaded(elements, state, defaults, routingInfo?.model || payload.model);
      state.pendingRuntimeNoticeKey = null;
      helpers.applyChatAvailability?.();
      helpers.setStatus('Ready to chat', 'success');
      return;
    }
    if (eventName === 'error') {
      const data = typeof rawData === 'string' ? safeParseJson(rawData, {}) : rawData;
      const error = new Error(data.message || 'Streaming failed.');
      error.code = data.code || null;
      error.statusCode = data.statusCode || null;
      throw error;
    }
  };

  const parseAndDispatchSse = (chunk, bufferState) => {
    bufferState.buffer += chunk;
    bufferState.buffer = bufferState.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let sepIndex;
    while ((sepIndex = bufferState.buffer.indexOf('\n\n')) !== -1) {
      const frame = bufferState.buffer.slice(0, sepIndex);
      bufferState.buffer = bufferState.buffer.slice(sepIndex + 2);
      if (!frame.trim()) continue;
      const lines = frame.split('\n');
      let eventName = 'message';
      const dataLines = [];
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) { eventName = line.slice('event:'.length).trim() || 'message'; continue; }
        if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
      }
      const data = dataLines.join('\n');
      if (eventName !== 'message') dispatchEvent(eventName, data);
    }
  };

  try {
    const abortController = new AbortController();
    requestAbortController = abortController;
    state.streamStopRequestedController = null;
    state.streamAbortController = abortController;
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'include',
      signal: abortController.signal
    });
    if (!res.ok) {
      throw await errorFromResponse(res, `Streaming failed (${res.status})`);
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error('Streaming not supported by this browser/proxy (no readable stream).');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const bufferState = { buffer: '' };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parseAndDispatchSse(decoder.decode(value, { stream: true }), bufferState);
      if (doneReceived) {
        // `done` is the successful terminal receipt. Stop reading without
        // reusing the user-cancellation AbortError path, which can otherwise
        // append the completed assistant turn a second time.
        await reader.cancel().catch(() => {});
        break;
      }
    }
    if (!doneReceived) {
      throw new Error('The response stream ended before completion.');
    }
  } catch (err) {
    if (isUserRequestedStreamStop(err, state, requestAbortController)) {
      if (elements.chatWindow.contains(assistantMessageDiv)) elements.chatWindow.removeChild(assistantMessageDiv);
      if (!doneReceived) {
        const stoppedContent = fullContent
          ? `${fullContent}\n\n_Response stopped by you._`
          : '\u23f9\ufe0f Response stopped by you.';
        helpers.appendMessage(
          {
            role: 'assistant',
            content: stoppedContent,
            createdAt: new Date().toISOString(),
            thinking: thinkingContent || null,
            retryUserMessageId: currentUserMessageId,
            metadata: { outcome: 'stopped', retryable: true }
          },
          { announcement: 'Response stopped. Saving this turn.' }
        );
        try {
          await persistTerminalTurn(ctx, {
            clientTurnId: terminalAttemptId,
            sourceUserMessageId: turnAction?.kind === 'retry' ? turnAction.sourceUserMessageId : null,
            userMessage: message,
            assistantContent: stoppedContent,
            outcome: 'stopped',
            model: payload.model
          });
          helpers.setFeedback('Response stopped and saved. The model may still be finishing in the background.', 'warning');
        } catch (persistError) {
          console.error('Failed to preserve stopped turn:', persistError);
          helpers.setFeedback('Streaming stopped. This turn is visible here but could not be saved; keep this page open and retry.', 'error');
        }
      }
      return;
    }
    const streamError = err?.name === 'AbortError'
      ? Object.assign(new Error('The response stream was interrupted before completion.'), { code: 'STREAM_INTERRUPTED' })
      : err;
    console.error('Fetch streaming error:', streamError);
    if (elements.chatWindow.contains(assistantMessageDiv)) elements.chatWindow.removeChild(assistantMessageDiv);
    const failure = chatFailureDetails(streamError);
    const failedContent = `${fullContent ? `${fullContent}\n\n` : ''}\u26a0\ufe0f ${failure.message}\n\n${failure.guidance}`;
    helpers.appendMessage(
      failedTurnMessage(failure, failedContent, currentUserMessageId),
      { announcement: 'Response failed. Recovery guidance is shown.' }
    );
    helpers.setStatus(failure.status, failure.tone);
    const statusHelp = document.getElementById('chatStatusHelp');
    if (statusHelp) statusHelp.textContent = failure.guidance;
    await recordFailedTurn(ctx, failure, {
      clientTurnId: terminalAttemptId,
      sourceUserMessageId: turnAction?.kind === 'retry' ? turnAction.sourceUserMessageId : null,
      userMessage: message,
      assistantContent: failedContent,
      model: payload.model
    });
  } finally {
    if (state.streamAbortController === requestAbortController) {
      state.streamAbortController = null;
      if (state.streamStopRequestedController === requestAbortController) {
        state.streamStopRequestedController = null;
      }
      state.sending = false;
      elements.sendBtn.disabled = false;
      elements.sendBtn.textContent = 'Send';
      helpers.applyChatAvailability?.();
    }
  }
}

export async function sendMessage(ctx, turnAction = null) {
  const { elements, state, defaults, helpers } = ctx;
  if (state.sending) return;
  if (state.warming) {
    helpers.setFeedback('Model is still loading, please wait…', 'muted');
    return;
  }

  const actionKind = turnAction?.action || null;
  const isRetry = actionKind === 'retry';
  const isAskAgain = actionKind === 'ask-again';
  if (turnAction && (!actionKind || (!isRetry && !isAskAgain))) {
    helpers.setFeedback('Unknown turn action. Reload the conversation and try again.', 'error');
    return;
  }
  const sourceUserMessageId = turnAction?.sourceUserMessageId == null
    ? null
    : String(turnAction.sourceUserMessageId);
  const sourceUserMessage = sourceUserMessageId
    ? state.history.find((turn) => (
        turn?.role === 'user' && messageIdOf(turn) === sourceUserMessageId
      ))
    : null;
  if (actionKind && !sourceUserMessage) {
    helpers.setFeedback('The selected user turn is no longer available. Reload the conversation and try again.', 'error');
    return;
  }
  const requestTurnAction = actionKind ? turnActionForRequest({
    kind: actionKind,
    sourceUserMessageId,
    sourceAssistantMessageId: turnAction?.sourceAssistantMessageId ?? null
  }) : null;
  if (actionKind && !requestTurnAction) {
    helpers.setFeedback('The selected turn action has incomplete message evidence. Reload the conversation and try again.', 'error');
    return;
  }

  const message = actionKind
    ? String(sourceUserMessage.content || '').trim()
    : elements.messageInput.value.trim();
  const model = elements.modelSelect.value;
  const routerMode = isRouterMode(elements, state);
  if (!message) return;
  const hostState = getHostChatState(elements, state, defaults);
  if (!hostState.available) {
    helpers.setFeedback(hostState.reason || 'Chat is unavailable for the selected route.', 'error');
    helpers.setStatus('Chat unavailable', 'error');
    return;
  }
  if (!routerMode && !model) {
    helpers.setFeedback('Select a model first.', 'error');
    return;
  }
  const runtimeChange = describePendingRuntimeChange(elements, state, defaults);
  if (runtimeChange.pending && state.pendingRuntimeNoticeKey !== runtimeChange.key) {
    state.pendingRuntimeNoticeKey = runtimeChange.key;
    helpers.setStatus('Runtime change pending', 'warning');
    const confirmationLabel = isRetry ? 'Retry' : isAskAgain ? 'Ask again' : 'Send';
    helpers.setFeedback(`${runtimeChange.message} Click ${confirmationLabel} again to run.`, 'warning');
    elements.sendBtn.textContent = 'Send and load';
    if (!actionKind) elements.messageInput.focus();
    return;
  }

  // Retry reuses the visible, unpersisted user turn. Ask again intentionally
  // creates a new user turn because the current API does not replace a
  // completed response; this keeps the UI aligned with durable history.
  const userMessage = isRetry
    ? sourceUserMessage
    : { role: 'user', content: message, id: `u-${Date.now()}`, createdAt: new Date().toISOString() };
  const currentUserMessageId = messageIdOf(userMessage);
  if (!currentUserMessageId) {
    helpers.setFeedback('The selected turn has no stable message identity. Reload the conversation and try again.', 'error');
    return;
  }
  const terminalAttemptId = outcomeAttemptId(currentUserMessageId);
  if (!isRetry) helpers.appendMessage(userMessage);
  if (!actionKind) {
    elements.messageInput.value = '';
    elements.messageInput.style.height = 'auto'; // Reset auto-resize
  }
  state.sending = true;
  elements.sendBtn.textContent = 'Sending\u2026';

  if (elements.streamToggle && elements.streamToggle.checked) {
    await sendMessageStreamFetch(ctx, message, model, currentUserMessageId, requestTurnAction, terminalAttemptId);
    return;
  }

  try {
    const payload = {
      ...buildPayload(
        elements,
        state,
        defaults,
        message,
        currentUserMessageId,
        requestTurnAction
      ),
      clientTurnId: terminalAttemptId,
      stream: false
    };
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'include'
    });
    if (!res.ok) throw await errorFromResponse(res, `Chat failed (${res.status})`);
    const data = await res.json();
    if (data.status !== 'success') {
      const error = new Error(data.message || 'Chat failed');
      error.code = data.code || null;
      throw error;
    }

    state.profile = data.data?.profile || state.profile;
    state.conversationId = data.data?.conversationId || state.conversationId;

    const responseText = data.data?.message?.content || data.data?.response || data.data?.output || 'No response from Ollama.';
    const routingInfo = buildRoutingInfo(data.data);
    if (routingInfo?.model) state.lastRoutedModel = routingInfo.model;
    const assistantMessage = {
      role: 'assistant', content: responseText,
      createdAt: new Date().toISOString(),
      id: data.data?.messageId || null,
      sourceUserMessageId: currentUserMessageId,
      stats: data.data?.stats || null,
      webSearchResults: data.data?.webSearchResults || null,
      ragStatus: data.data?.ragStatus || null,
      routingInfo
    };
    helpers.appendMessage(assistantMessage, { announcement: 'Assistant response complete.' });
    helpers.speakText(responseText);

    // Update Chat Intelligence status bar
    if (routingInfo && typeof ChatIntelligence !== 'undefined') {
      ChatIntelligence.updateStatusBar({
        model: routingInfo.model,
        host: routingInfo.hostName,
        hostHealth: routingInfo.hostHealth,
        routeReason: routingInfo.taskType || 'direct',
        contextSize: routingInfo.numCtx
      });
    }
    markSelectedManualModelLoaded(elements, state, defaults, routingInfo?.model || payload.model);
    state.pendingRuntimeNoticeKey = null;
    helpers.applyChatAvailability?.();
    helpers.setStatus('Ready to chat', 'success');

    if (data.warning) {
      helpers.setFeedback(`\u26a0\ufe0f ${data.warning}`, 'warning');
      setTimeout(() => helpers.setFeedback('Response received.', 'success'), 3000);
    } else {
      helpers.setFeedback('Response received.', 'success');
    }
    helpers.loadHistoryList();
    if (state.conversationId) helpers.refreshStats(state.conversationId);
    if (state.conversationId) helpers.loadConversation(state.conversationId, true);
    if (window.checkSetupProgress) setTimeout(() => window.checkSetupProgress(), 500);
  } catch (err) {
    console.error(err);
    const failure = chatFailureDetails(err);
    const failedContent = `\u26a0\ufe0f ${failure.message}\n\n${failure.guidance}`;
    helpers.appendMessage(
      failedTurnMessage(failure, failedContent, currentUserMessageId),
      { announcement: 'Response failed. Recovery guidance is shown.' }
    );
    helpers.setStatus(failure.status, failure.tone);
    const statusHelp = document.getElementById('chatStatusHelp');
    if (statusHelp) statusHelp.textContent = failure.guidance;
    await recordFailedTurn(ctx, failure, {
      clientTurnId: terminalAttemptId,
      sourceUserMessageId: requestTurnAction?.kind === 'retry' ? requestTurnAction.sourceUserMessageId : null,
      userMessage: message,
      assistantContent: failedContent,
      model: payload.model
    });
  } finally {
    state.sending = false;
    elements.sendBtn.textContent = 'Send';
  }
}

