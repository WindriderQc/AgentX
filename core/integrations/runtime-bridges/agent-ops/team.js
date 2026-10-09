'use strict';

// The Team view of the Agent Ops roster. An agent is the runtime boundary
// (model, tools, memory, channels); a persona is how one presents (name,
// voice, personality). This joins the two so a member is read in one place,
// and separates the members one can talk to from roles and tools.

const GROUPS = Object.freeze(['team', 'dormant', 'tool', 'role']);

const agentKey = (value) => String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '');

// team: a runtime agent the runtime reports. dormant: declared to the runtime
// but not reported by it. tool: a coding harness. role: a registry entry with
// no runtime of its own.
function groupOf(agent) {
  if (agent.runtime === 'openclaw') return agent.status === 'unobserved' ? 'dormant' : 'team';
  return agent.type === 'coding_agent' ? 'tool' : 'role';
}

// What the page shows of a persona. The personality text stays in the prompt
// library; the card links to it.
function presentation(persona) {
  const voice = persona.voice || {};
  return {
    id: persona.id,
    label: persona.name || persona.id,
    version: persona.version ?? null,
    description: persona.description || '',
    voice: {
      provider: voice.provider || null,
      presentation: voice.presentation || null,
      voices: voice.voices || {},
      // An instance may replace the catalog voice without editing the catalog.
      instance: voice.source === 'instance'
    },
    visual: persona.visual || null,
    // Changed on this instance through the Team page.
    edited: persona.edited === true,
    promptHref: `/prompts?name=${encodeURIComponent(persona.id)}`
  };
}

function teamView(projection, personas, { issue = null } = {}) {
  const linked = new Map();
  const styles = [];
  for (const persona of Array.isArray(personas) ? personas : []) {
    if (!persona?.id) continue;
    if (persona.agentId) linked.set(agentKey(persona.agentId), persona);
    else styles.push({ ...presentation(persona), styleOf: persona.styleOf ? agentKey(persona.styleOf) : null });
  }
  const agents = (projection.agents || []).map((agent) => {
    const persona = linked.get(agent.id);
    linked.delete(agent.id);
    // Its own styles sit on the member's card; the rest stay in the shared list below.
    return { ...agent, group: groupOf(agent), persona: persona ? presentation(persona) : null,
      styles: styles.filter((style) => style.styleOf === agent.id) };
  });
  const counts = Object.fromEntries(GROUPS.map((group) => [group, agents.filter((agent) => agent.group === group).length]));
  return {
    ...projection,
    agents,
    team: {
      counts,
      // Personalities any conversation may select; they belong to no single member.
      styles: styles.filter((style) => !agents.some((agent) => agent.id === style.styleOf)),
      // A persona naming an agent the roster does not hold.
      orphans: [...linked.values()].map((persona) => ({ ...presentation(persona), agentId: persona.agentId })),
      personas: { status: issue ? 'unavailable' : 'ok', issue }
    }
  };
}

module.exports = { GROUPS, groupOf, presentation, teamView };
