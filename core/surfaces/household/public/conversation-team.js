'use strict';

// The team bar of the personal space: one card per team member (a native agent
// with its own default personality, so choosing the card also chooses its
// voice), the member the conversation is with, and why settings are locked.
(function exposeConversationTeam(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ConversationTeam = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  // A personality label reads "Nestor · Majordome": the card shows the first part.
  const shortName = (label) => String(label || '').split(' · ')[0].trim();

  // Members are the personalities that declare an agent available in this space.
  function members(personas = [], agents = []) {
    const known = new Map(agents.map((agent) => [agent.id, agent]));
    return personas.filter((persona) => persona.agentId && known.has(persona.agentId)).map((persona) => {
      const agent = known.get(persona.agentId);
      return { agentId: agent.id, personaId: persona.id,
        name: agent.id === 'main' ? shortName(persona.name) || agent.name : agent.name || shortName(persona.name) };
    });
  }

  // The personalities a conversation with this agent may use: the member's own, the styles
  // declared for it, and the personalities that belong to no member. A general prompt of
  // the library (no kind) is not a personality and is not offered.
  function stylesFor(personas = [], agentId) {
    return personas.filter((persona) => persona.agentId === agentId || persona.styleOf === agentId
      || (!persona.agentId && !persona.styleOf && persona.kind === 'personality'));
  }

  function memberName(list, agents, agentId) {
    return list.find((member) => member.agentId === agentId)?.name
      || agents.find((agent) => agent.id === agentId)?.name || agentId || 'Nestor';
  }

  // Why the pickers do nothing while a conversation exists.
  function lockNotice({ locked, busy, name }) {
    if (busy) return 'Réglages verrouillés pendant que Nestor travaille.';
    if (!locked) return '';
    return `Conversation en cours avec ${name}. L’agent, la personnalité et la voix restent fixés : « Nouvelle conversation » pour les changer.`;
  }

  function render(nav, { list, activeAgentId, locked, esc }) {
    nav.hidden = list.length < 2;
    nav.innerHTML = '<span class="team-label">Parler avec</span>' + list.map((member) => {
      const active = member.agentId === activeAgentId;
      return `<button type="button" class="team-card${active ? ' active' : ''}" data-agent="${esc(member.agentId)}" data-persona="${esc(member.personaId)}" aria-pressed="${active}"${locked && !active ? ' disabled' : ''}>${esc(member.name)}</button>`;
    }).join('');
  }

  return Object.freeze({ members, stylesFor, memberName, lockNotice, render });
}));
