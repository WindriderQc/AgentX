/**
 * Chat turn outcomes — durable stopped/failed turn records and HTTP error
 * projection shared by the streaming and JSON send paths.
 */
export function outcomeAttemptId(sourceUserMessageId) {
  const randomPart = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `terminal:${String(sourceUserMessageId || 'turn').slice(0, 80)}:${randomPart}`.slice(0, 160);
}

export async function errorFromResponse(response, fallbackMessage) {
  const raw = await response.text().catch(() => '');
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  const error = new Error(parsed?.message || parsed?.error || raw || fallbackMessage || `Request failed (${response.status})`);
  error.code = parsed?.code || null;
  error.statusCode = response.status;
  return error;
}

export async function persistTerminalTurn(ctx, {
  clientTurnId,
  sourceUserMessageId = null,
  userMessage,
  assistantContent,
  outcome,
  model,
  error = null
}) {
  const { state, helpers } = ctx;
  const response = await fetch('/api/history/turn-outcome', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      conversationId: state.conversationId,
      clientTurnId,
      sourceUserMessageId,
      userMessage,
      assistantContent,
      outcome,
      model: model || 'unknown',
      errorCode: error?.code || null,
      errorMessage: error?.message || null
    })
  });
  if (!response.ok) throw await errorFromResponse(response, 'Failed to preserve the chat turn.');
  const envelope = await response.json();
  if (envelope.status !== 'success' || !envelope.data?.conversationId) {
    throw new Error('The history service returned no conversation receipt.');
  }
  state.conversationId = envelope.data.conversationId;
  await helpers.loadHistoryList();
  await helpers.loadConversation(state.conversationId, true);
  return envelope.data;
}

// The server refuses every turn for an unknown or archived conversation, so
// its outcome cannot be recorded either.
function isConversationGone(failure) {
  return failure?.code === 'CONVERSATION_NOT_FOUND';
}

export function failedTurnMessage(failure, content, retryUserMessageId) {
  const gone = isConversationGone(failure);
  return {
    role: 'assistant',
    content,
    createdAt: new Date().toISOString(),
    retryUserMessageId: gone ? null : retryUserMessageId,
    metadata: { outcome: 'failed', retryable: !gone, error: { code: failure.code, message: failure.message } }
  };
}

function offerNewChat(ctx) {
  const { elements, helpers } = ctx;
  if (!elements?.feedback || typeof helpers?.clearChat !== 'function') return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost';
  button.textContent = 'Start a new chat';
  button.style.marginLeft = '8px';
  button.addEventListener('click', () => {
    helpers.clearChat();
    helpers.setFeedback('', 'muted');
  });
  elements.feedback.appendChild(button);
}

// Records a failed turn in history and reports the result in one message.
export async function recordFailedTurn(ctx, failure, turn) {
  const { helpers } = ctx;
  if (isConversationGone(failure)) {
    helpers.setFeedback('This conversation is archived or no longer exists, so this turn was not saved.', 'error');
    offerNewChat(ctx);
    return false;
  }
  try {
    await persistTerminalTurn(ctx, { ...turn, outcome: 'failed', error: failure });
    helpers.setFeedback(`${failure.message} The failed turn was saved in history.`, failure.tone);
    return true;
  } catch (persistError) {
    console.error('Failed to preserve failed turn:', persistError);
    helpers.setFeedback(`${failure.message} This turn is visible here but could not be saved; keep this page open and retry.`, 'error');
    return false;
  }
}
