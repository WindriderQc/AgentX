'use strict';

const SCHEMA = 'agentx.owner-memory-turn/v1';
const CURRENT_TURN_ONLY = '[agentx:owner-memory-current-turn/v1]';
const POLICY = [
  'Use live Core owner notes for current personal memory, including when the owner repeats a question in this chat.',
  'A prior reply, session summary or transcript search is historical conversation. It cannot establish a current saved fact or override an active note.',
  'If a requested memory is missing, say you cannot verify it. Do not fill the gap with a past answer, quote an outdated or forgotten value as a caveat, ask the owner to reconfirm that old value, or save it again.',
  'The current user message can supply new information. If the owner changes a note during this turn, use the confirmed Core write or a fresh read.',
  'Use conversation history when the owner specifically asks about a past conversation. Keep historical evidence distinct from current memory.',
].join(' ');

function explicitlyRequestsHistory(text) {
  const query = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return /\b(?:quote|show|summarize|summarise|relis|cite|montre|resume|recherche)\b[^.!?]{0,100}\b(?:transcripts?|historique|history|conversations?|chats?|sessions?)\b/.test(query)
    || /\b(?:what did (?:you|i|we) say|qu.est.ce (?:que je|qu.on|que tu) (?:t.ai |m.as |a )?dit)\b[^.!?]{0,100}\b(?:earlier|before|last time|previously|hier|avant|derniere fois|precedemment)\b/.test(query);
}

function projection({ notes = [], protectRecall = false } = {}) {
  const current = notes.map(({ id, text }) => ({ id, text: text.slice(0, 640), ...(text.length > 640 && { excerpt: true }) }));
  const context = protectRecall
    ? `Core checked current owner memory for this turn. Answer the current-memory part from these notes or an exact current Core lookup. A missing part stays unknown.\n${JSON.stringify(current)}`
    : '';
  const policy = protectRecall ? `${CURRENT_TURN_ONLY}\n${POLICY}` : POLICY;
  return { ok: true, authority: 'agentx.core', schema: SCHEMA, policy, protectRecall, context };
}

// The native Nestor adapters carry the turn policy in system instructions.
// Both inference bridges consume the marker before any provider sees it.
function currentMemoryInput(body) {
  const { messages } = body;
  if (!Array.isArray(messages)) return body;
  const system = [];
  let guarded = false;
  for (const message of messages) {
    if (message?.role !== 'system' && message?.role !== 'developer') break;
    const lines = typeof message.content === 'string' ? message.content.split(/\r?\n/) : [];
    const content = lines.filter(line => line.trim() !== CURRENT_TURN_ONLY);
    if (content.length !== lines.length) {
      guarded = true;
      system.push({ ...message, content: content.join('\n') });
    } else {
      system.push(message);
    }
  }
  if (!guarded) return body;
  const current = messages.findLastIndex(message => message?.role === 'user');
  return { ...body, messages: [...system, ...(current < 0 ? [] : messages.slice(current))] };
}

module.exports = { currentMemoryInput, explicitlyRequestsHistory, projection };
