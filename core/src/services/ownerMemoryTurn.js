'use strict';

const SCHEMA = 'agentx.owner-memory-turn/v1';
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
  return { ok: true, authority: 'agentx.core', schema: SCHEMA, policy: POLICY, protectRecall, context };
}

module.exports = { explicitlyRequestsHistory, projection };
