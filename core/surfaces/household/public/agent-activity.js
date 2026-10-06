'use strict';

// Short French lines for what the native agent is doing during a turn.
// Only tool names and a target agent reach the browser; `spoken` marks the
// lines Nestor says aloud. Anything unknown stays a quiet status line.
(function exposeAgentActivity(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentActivity = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const SPOKEN = [
    [/^(tool_search|tool_describe|agents_list)$/, () => 'Je regarde quels outils utiliser.'],
    [/^image_generate$/, () => 'Je crée l’image.'],
    [/^personal_memory$/, () => 'Je consulte tes notes.'],
    [/^nestor_context$/, () => 'Je rassemble ton contexte.'],
    [/^nestor_briefing$/, () => 'Je prépare ton résumé.'],
    [/^vault_note$/, () => 'Je range la note dans ton coffre Obsidian.'],
    [/personal_task/, () => 'Je regarde tes tâches.'],
    [/shopping_list/, () => 'Je vérifie la liste d’épicerie.'],
    [/^(web_search|web_fetch|searxng.*)$/, () => 'Je cherche sur le web.'],
    [/finance|ledger/, () => 'Je consulte tes finances.'],
    [/mail/, () => 'Je cherche dans tes courriels.'],
    [/calendar|agenda/, () => 'Je regarde ton agenda.'],
    [/^(memory_search|rag_search|wiki_search)$/, () => 'Je cherche dans mes notes.']
  ];
  const QUIET = /^(sessions_yield|get_sound|agentx__get_sound)$/;

  function describe(activity, agentName = id => id) {
    const agent = activity?.agentId ? agentName(activity.agentId) : '';
    if (activity?.kind === 'waiting_agent') {
      return { text: agent ? `J’attends la réponse de ${agent}. Ça peut prendre une minute.` : 'J’attends la réponse de l’autre agent. Ça peut prendre une minute.', spoken: true };
    }
    // Said the moment a turn goes to another team member, before that member's first model call.
    if (activity?.kind === 'member_addressed') {
      return { text: agent ? `Je passe ta question à ${agent}.` : 'Je passe ta question à un autre agent.', spoken: true };
    }
    if (activity?.kind === 'waiting_image') return { text: 'L’image est en préparation. Ça peut prendre une minute.', spoken: false };
    if (activity?.kind !== 'tool' || typeof activity.tool !== 'string' || QUIET.test(activity.tool)) return null;
    if (/^sessions_(spawn|send)$/.test(activity.tool)) {
      return { text: agent ? `J’envoie ta question à ${agent}.` : 'J’envoie ta question à un autre agent.', spoken: true };
    }
    const match = SPOKEN.find(([pattern]) => pattern.test(activity.tool));
    return match ? { text: match[1](), spoken: true } : { text: `Outil : ${activity.tool}`, spoken: false };
  }

  return Object.freeze({ describe });
}));
