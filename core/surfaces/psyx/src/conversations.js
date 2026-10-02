'use strict';

const { PROMPT_VERSION } = require('../../../src/domains/psyx/domain');

// PsyX keeps its domain language; Core owns generic conversation persistence
// and lifecycle. The namespace cannot be supplied by browser requests.
function createConversationAdapter({ conversationLifecycle: core }) {
  const scope = userId => ({ userId: `surface:psyx:${userId}`, promptName: 'psyx' });
  const validId = id => /^[a-f0-9]{24}$/i.test(String(id || ''));
  const view = row => row ? { ...row,
    provider: row.messages?.at(-1)?.metadata?.provider || null,
    ...(row.messages ? { messages: row.messages.map(message => ({
      role: message.role, content: message.content, action: message.metadata?.action,
      createdAt: message.timestamp
    })) } : {})
  } : null;
  async function listSessions(userId, limit = 30, status = 'active') {
    return (await core.listConversations({ ...scope(userId), limit, status })).items.map(view);
  }
  async function all(userId) {
    const items = [];
    for (let page = 1; ; page++) {
      const result = await core.listConversations({ ...scope(userId), status: 'all', limit: 100, page });
      items.push(...result.items);
      if (!result.hasMore) return items;
    }
  }
  async function getSession(userId, id) {
    return validId(id) ? view(await core.getConversation({ ...scope(userId), conversationId: id })) : null;
  }
  const mutate = method => async (userId, id, title) => validId(id)
    ? view(await core[method]({ ...scope(userId), conversationId: id, title })) : null;
  return {
    listSessions, getSession,
    async listSessionMetadata(userId) {
      return (await all(userId)).map(({ preview, ...row }) => view(row));
    },
    async listTranscripts(userId) {
      const items = [];
      for (const row of await all(userId)) { const session = await getSession(userId, row.id); if (session) items.push(session); }
      return items;
    },
    async context(userId, id, limit = 40) {
      const session = await getSession(userId, id);
      if (!session || session.lifecycle.status === 'archived') return null;
      return session.messages.filter(m => ['user', 'assistant', 'action'].includes(m.role)).slice(-limit)
        .map(m => ({ role: m.role === 'action' ? 'user' : m.role, content: m.content }));
    },
    async saveCompletedTurn(input) {
      return view(await core.recordCompletedTurn({ ...input, ...scope(input.userId), surface: 'psyx', promptVersion: PROMPT_VERSION }));
    },
    rename: mutate('renameConversation'), archive: mutate('archiveConversation'), restore: mutate('restoreConversation'),
    async permanentlyDelete(userId, id) {
      return validId(id) && (await core.permanentlyDeleteConversation({ ...scope(userId), conversationId: id })).deleted;
    }
  };
}

module.exports = { createConversationAdapter };
