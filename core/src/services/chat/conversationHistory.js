'use strict';

const { findConversationForUpdate } = require('./conversationPersistence');

/**
 * Conversation history rehydration.
 *
 * A `conversationId` is a continuation handle: Core stores every accepted turn
 * under it (see `persistConversation`). When a caller continues that
 * conversation without supplying its own `messages` — an external connector
 * such as the AgentX_Ops MCP sends only the id and the new message — Core
 * loads the stored turns so the model sees the earlier dialogue instead of
 * answering a bare prompt.
 *
 * An explicit caller `messages` array always wins over the stored transcript:
 * the Playground browser tracks its history in memory and sends it verbatim,
 * so falling back to the store would double-count the same turns.
 *
 * @param {Object} [params]
 * @param {string} [params.conversationId] - Conversation to continue
 * @param {string} [params.userId] - Owner scope; a foreign or archived id loads nothing
 * @returns {Promise<Array<{role: string, content: string}>>} prior user/assistant
 *   turns, oldest first. Empty when the id is absent, unknown, or archived.
 */
async function loadStoredTurns({ conversationId, userId } = {}) {
  if (!conversationId || !userId) return [];
  const conversation = await findConversationForUpdate({ conversationId, userId });
  if (!conversation) return [];
  return (conversation.messages || [])
    .filter(message => message && ['user', 'assistant'].includes(message.role)
      && typeof message.content === 'string')
    .map(message => ({ role: message.role, content: message.content }));
}

/**
 * Resolve the dialogue context for one chat turn. Explicit caller `messages`
 * always win; a `conversationId` continuation without them rehydrates the
 * stored transcript; `historyContext: false` sends none at all.
 *
 * @param {Object} params
 * @param {Array} [params.messages] - Caller-provided prior turns
 * @param {string} [params.conversationId] - Conversation to continue
 * @param {string} [params.userId] - Owner scope
 * @param {boolean} [params.historyContext] - Playground preference gate
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
async function resolveContextMessages({ messages = [], conversationId, userId, historyContext } = {}) {
  if (historyContext === false) return [];
  if (messages.length > 0) return messages.map(m => ({ role: m.role, content: m.content }));
  return loadStoredTurns({ conversationId, userId });
}

module.exports = { loadStoredTurns, resolveContextMessages };
