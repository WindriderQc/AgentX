(function () {
  'use strict';

  // The Team view of the Agents tab: each member is read in one place, as an
  // identity (the persona that presents it) and a runtime (the agent itself).
  // Members one can talk to come first; roles and tools follow in their own groups.

  const GROUPS = [
    { id: 'team', title: 'Team', icon: 'fa-people-group',
      note: 'Agents the runtime reports. Each has its own model, tools, memory and channels.' },
    { id: 'dormant', title: 'Declared, not reported', icon: 'fa-moon',
      note: 'Known to the runtime configuration or its manifest, but the runtime did not report them.' },
    { id: 'tool', title: 'Coding tools', icon: 'fa-code',
      note: 'External harnesses that work on the repository. They are not conversational members.' },
    { id: 'role', title: 'Roles', icon: 'fa-user-gear',
      note: 'Responsibilities recorded in the registry. A role has no runtime of its own.' }
  ];

  function create(context) {
    const { esc, humanize, number, badge, empty, agentIcon, runtimeLink, editPersona } = context;

    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-persona-edit]');
      if (button) editPersona(button.dataset.personaEdit);
    });

    function voiceLine(voice) {
      const names = [...new Set(Object.values(voice?.voices || {}).filter(Boolean))];
      if (!voice?.provider || !names.length) return '';
      return `<span class="agent-ops-chip" title="${esc(names.join(' · '))}"><i class="fas fa-volume-high"></i>${esc(voice.provider)} · ${esc(names[0])}${voice.instance ? ' · instance-wide' : ''}</span>`;
    }

    function identity(agent) {
      const persona = agent.persona;
      if (!persona) {
        return agent.group === 'team'
          ? '<div class="agent-ops-identity none"><span>Identity</span><em>No persona: this member has no declared voice or personality.</em></div>'
          : '';
      }
      return `
        <div class="agent-ops-identity">
          <span>Identity · persona ${esc(persona.id)}${persona.version ? ` v${esc(persona.version)}` : ''}</span>
          <div class="agent-ops-meta-row">
            ${voiceLine(persona.voice)}
            ${persona.edited ? '<span class="agent-ops-chip"><i class="fas fa-user-pen"></i>edited here</span>' : ''}
            <button type="button" class="agent-ops-chip link" data-persona-edit="${esc(persona.id)}"><i class="fas fa-pen-nib"></i>Edit identity</button>
          </div>
        </div>`;
    }

    // The styles declared for this member: other ways it may present, same agent.
    function ownStyles(agent) {
      const rows = Array.isArray(agent.styles) ? agent.styles : [];
      if (!rows.length) return '';
      return `<div class="agent-ops-meta-row" aria-label="Styles">${rows.map((style) =>
        `<button type="button" class="agent-ops-chip link" data-persona-edit="${esc(style.id)}" title="${esc(style.description)}"><i class="fas fa-masks-theater"></i>${esc(style.label)}</button>`).join('')}</div>`;
    }

    function card(agent) {
      const title = agent.persona?.label || agent.name;
      return `
      <article class="agent-ops-agent-card" data-agent-group="${esc(agent.group || 'role')}">
        <header class="agent-ops-agent-top">
          <div class="agent-ops-agent-avatar"><i class="fas ${agentIcon(agent)}"></i></div>
          <div>
            <h3>${esc(title)}</h3>
            <div class="agent-ops-agent-id">${esc(agent.id)}${title !== agent.name ? ` · ${esc(agent.name)}` : ''}</div>
          </div>
          ${badge(humanize(agent.status), agent.status)}
        </header>
        <div class="agent-ops-agent-body">
          <p>${esc(agent.responsibility)}</p>
          ${identity(agent)}
          ${ownStyles(agent)}
          <div class="agent-ops-meta-row">
            <span class="agent-ops-chip"><i class="fas fa-tag"></i>${esc(humanize(agent.type))}</span>
            ${agent.runtime ? `<span class="agent-ops-chip"><i class="fas fa-microchip"></i>${esc(agent.runtime)}</span>` : ''}
            ${agent.acceptanceGate ? `<span class="agent-ops-chip"><i class="fas fa-check-double"></i>${esc(humanize(agent.acceptanceGate))}</span>` : ''}
            ${agent.confidence ? `<span class="agent-ops-chip"><i class="fas fa-signal"></i>${esc(agent.confidence)}</span>` : ''}
          </div>
          ${agent.group === 'role' || agent.group === 'tool' ? '' : `
          <div class="agent-ops-model">
            <span>Primary model · ${esc(agent.model?.source || 'not declared')}</span>
            <code title="${esc(agent.model?.primary || 'No model declared')}">${esc(agent.model?.primary || 'No model declared')}</code>
          </div>`}
          <div class="agent-ops-agent-stats">
            <span><i class="fas fa-clock"></i>${number(agent.automationCount)} recurring</span>
            <span><i class="fas fa-list-check"></i>${number(agent.workCount)} work</span>
            ${agent.blockedWorkCount ? `<span><i class="fas fa-ban"></i>${number(agent.blockedWorkCount)} blocked</span>` : ''}
          </div>
          <div class="agent-ops-agent-actions">
            <button type="button" data-agent-inspect="${esc(agent.registryId)}"><i class="fas fa-id-card"></i>Inspect dossier</button>
            ${runtimeLink(agent)}
          </div>
        </div>
      </article>`;
    }

    function styles(team) {
      const rows = Array.isArray(team?.styles) ? team.styles : [];
      if (!rows.length) return '';
      return `
        <section class="agent-ops-team-group" data-agent-group="styles">
          <header><h3><i class="fas fa-masks-theater"></i>Styles <small>${rows.length}</small></h3>
            <p>Personalities a conversation may select. They change the presentation, never the agent's tools, memory or model.</p></header>
          <div class="agent-ops-style-list">
            ${rows.map((style) => `<button type="button" class="agent-ops-style" data-persona-edit="${esc(style.id)}" title="${esc(style.description)}">
              <strong>${esc(style.label)}</strong><span>${esc(style.id)}${style.version ? ` v${esc(style.version)}` : ''}${style.edited ? ' · edited here' : ''}</span>${voiceLine(style.voice)}</button>`).join('')}
          </div>
        </section>`;
    }

    function notices(team) {
      const lines = [];
      if (team?.personas?.status === 'unavailable') lines.push(`Identities are not shown: ${team.personas.issue}`);
      for (const orphan of Array.isArray(team?.orphans) ? team.orphans : []) {
        lines.push(`Persona ${orphan.id} names the agent ${orphan.agentId}, which this roster does not hold.`);
      }
      return lines.map((line) => `<p class="agent-ops-team-notice"><i class="fas fa-circle-exclamation"></i>${esc(line)}</p>`).join('');
    }

    // agents: the filtered roster. team: the projection's team block.
    function render(agents, team) {
      if (!agents.length) return empty('No agents match this filter.', 'fa-users-slash');
      const groups = GROUPS.map((group) => ({ ...group, agents: agents.filter((agent) => (agent.group || 'role') === group.id) }))
        .filter((group) => group.agents.length);
      return notices(team) + groups.map((group) => `
        <section class="agent-ops-team-group" data-agent-group="${group.id}">
          <header><h3><i class="fas ${group.icon}"></i>${esc(group.title)} <small>${group.agents.length}</small></h3><p>${esc(group.note)}</p></header>
          <div class="agent-ops-agent-grid">${group.agents.map(card).join('')}</div>
        </section>
        ${group.id === 'team' ? styles(team) : ''}`).join('');
    }

    return { render };
  }

  window.AgentOpsTeam = { create };
})();
