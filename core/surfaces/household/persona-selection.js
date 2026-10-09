'use strict';

const invalid = (message, code) => Object.assign(new Error(message), { statusCode: 400, code });

// An existing session keeps its isolation boundary. During creation an omitted
// agent is derived from the personality; an explicit conflicting choice fails.
function agentForPersona(persona, { agentId, family = false } = {}) {
  if (family) {
    if (persona && persona.id !== 'nestor') throw invalid('Family uses the Nestor personality or none.', 'VOICE_PERSONA_FAMILY_PERSONA_REQUIRED');
    return 'family';
  }
  const bound = persona?.agentId;
  if (bound && agentId && bound !== agentId) {
    throw invalid('This personality belongs to a different agent. Keep this session’s agent or start a new conversation.', 'VOICE_PERSONA_AGENT_MISMATCH');
  }
  return bound || agentId || 'main';
}

module.exports = { agentForPersona };
