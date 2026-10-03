'use strict';

const catalog = require('./persona-catalog');
const { agentIdFor } = require('./conversation-agent');
const { spokenReplyLanguage } = require('./persona-prompt');

function attributionForTurn(session, input) {
  const evidence = input.toolEvidence;
  const agentId = input.speaker?.agentId || input.speakerAgentId
    || /^openclaw\/([a-z0-9_-]+)$/.exec(evidence?.authority || '')?.[1] || agentIdFor(session);
  let persona = session.persona;
  if (agentId !== agentIdFor(session)) {
    const row = catalog.generatedPersonas().find(row => row.uiConfig.layoutConfig.agentId === agentId);
    persona = row ? catalog.snapshot({ ...row, _id: 'catalog', version: 0 }) : null;
  }
  const speaker = input.speaker || { agentId, personaId: persona?.id || null,
    personaVersion: persona?.version ?? null, name: persona?.name || agentId };
  const performedBy = evidence?.performedBy?.length ? evidence.performedBy
    : [{ agentId, runId: evidence?.run?.runId || evidence?.runId || null }];
  const language = spokenReplyLanguage(input.replyText || '', input.inputText || '');
  const speech = catalog.speechFor(persona, language, agentId === agentIdFor(session) ? session.voice : {});
  return { speaker, performedBy, voice: { provider: speech.provider, voice: speech.voice }, speech };
}

// All Household producers (completed, deterministic, interrupted and native
// ingestion) cross this boundary before Core persists a turn. Older audits
// remain unchanged; attribution is evidence captured at write time.
function attributedConversations(conversations) {
  return Object.freeze({ ...conversations, async recordTurn(input, options) {
    const session = await conversations.getSession({ sessionId: input.sessionId, packId: input.packId, scopeId: input.scopeId });
    const attribution = attributionForTurn(session || {}, input);
    const audit = await conversations.recordTurn({ ...input, speaker: attribution.speaker,
      performedBy: attribution.performedBy, voice: attribution.voice }, options);
    return { ...audit, replySpeech: attribution.speech };
  } });
}

module.exports = { attributionForTurn, attributedConversations };
