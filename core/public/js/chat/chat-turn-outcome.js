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
