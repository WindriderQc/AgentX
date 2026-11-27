'use strict';

const speech = require('./public/speech-language');

function defaultLanguage(env = process.env) {
  return speech.explicitSpeechLanguage(env.HOUSEHOLD_DEFAULT_LANGUAGE) || speech.DEFAULT_LANGUAGE;
}

async function conversationLanguage({ text, preference, session, conversations, env }) {
  const chosen = speech.explicitSpeechLanguage(preference);
  if (chosen) return chosen;
  const detected = speech.scoreSpeechLanguage(text).language;
  if (detected) return detected;
  const fallback = defaultLanguage(env);
  if (!session.turnCount) return fallback;
  // Only the last reply in this same conversation can break a tie. Older
  // records predate speechLanguage, so use their actual answer as evidence.
  const [last] = await conversations.listTurns({ sessionId: session.sessionId, scopeId: session.scopeId,
    packId: session.packId, replyText: { $gt: '' }, outcome: { $ne: 'failed' } }, { limit: 1 });
  return speech.explicitSpeechLanguage(last?.speechLanguage)
    || speech.replySpeechLanguage(last?.replyText, speech.scoreSpeechLanguage(last?.inputText).language || fallback);
}

module.exports = { conversationLanguage, defaultLanguage };
