'use strict';
const { evidenceSource } = require('./dreamEvidence');

// Coverage describes the text actually supplied to this reflection, separately
// from the transcripts fetched from Core. Whole messages are kept or omitted.
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const tooLarge = () => Object.assign(new Error('PsyX cannot fit a complete recent message in this reflection. No portrait was written.'),
  { code: 'PSYX_DREAM_CONTEXT_TOO_LARGE', statusCode: 413 });

function selectDreamTranscript(conversations, maxCharacters) {
  const sessions = conversations.map(conversation => ({
    header: `### Session ${text(conversation.updatedAt || conversation.createdAt).slice(0, 30)} (${text(conversation.id).slice(0, 40)})\n`,
    entries: (conversation.messages || []).map((message, messageIndex) => ({ ...message, messageIndex }))
      .filter(message => ['user', 'assistant'].includes(message.role) && text(message.content)),
    id: conversation.id
  })).map(session => ({ ...session, lines: session.entries.map(message => `${message.role === 'assistant' ? 'PsyX' : 'User'}: ${text(message.content)}`) }))
    .filter(session => session.lines.length);
  const blocks = [];
  const evidenceSources = [];
  const rememberSources = (session, entries) => evidenceSources.push(...entries.filter(message => message.role === 'user')
    .map(message => evidenceSource('conversation', text(message.content), { conversationId: session.id, messageIndex: message.messageIndex })));
  let remaining = maxCharacters, messages = 0, partialConversations = 0;
  for (const session of [...sessions].reverse()) {
    const block = session.header + session.lines.join('\n\n');
    if (block.length <= remaining) {
      blocks.unshift(block);
      messages += session.lines.length;
      rememberSources(session, session.entries);
      remaining -= block.length + 2;
      continue;
    }
    if (!blocks.length) {
      const kept = [];
      let room = remaining - session.header.length;
      for (const line of [...session.lines].reverse()) {
        if (line.length > room) break;
        kept.unshift(line);
        room -= line.length + 2;
      }
      if (!kept.length) throw tooLarge();
      blocks.unshift(session.header + kept.join('\n\n'));
      messages += kept.length;
      rememberSources(session, session.entries.slice(-kept.length));
      partialConversations = 1;
    }
    break;
  }
  const availableMessages = sessions.reduce((sum, session) => sum + session.lines.length, 0);
  return { text: blocks.join('\n\n'), evidenceSources, coverage: {
    conversations: blocks.length, availableConversations: sessions.length, partialConversations,
    messages, availableMessages, complete: messages === availableMessages
  } };
}

function normalizeDreamCoverage(raw = {}) {
  const through = new Date(raw.through);
  return {
    conversations: count(raw.conversations) || 0,
    availableConversations: count(raw.availableConversations),
    partialConversations: count(raw.partialConversations),
    messages: count(raw.messages), availableMessages: count(raw.availableMessages),
    complete: typeof raw.complete === 'boolean' ? raw.complete : null,
    through: raw.through && !Number.isNaN(through.getTime()) ? through.toISOString() : null,
    sourceCoverage: (Array.isArray(raw.sourceCoverage) ? raw.sourceCoverage : []).slice(0, 8).map(source => ({
      key: text(source.key).slice(0, 80), includedCharacters: count(source.includedCharacters),
      availableCharacters: count(source.availableCharacters), complete: source.complete === true
    })),
    unavailableSources: (Array.isArray(raw.unavailableSources) ? raw.unavailableSources : []).map(key => text(key).slice(0, 80)).filter(Boolean).slice(0, 8)
  };
}

module.exports = { selectDreamTranscript, normalizeDreamCoverage, tooLarge };
