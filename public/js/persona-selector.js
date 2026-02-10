/**
 * Persona Selector
 * Enhances the existing Agent Launcher to include personas
 * Integrates with AgentListView component
 */

(function() {
  'use strict';

  let personas = [];
  let agents = [];
  let currentPersona = null;
  let personasReady = false;
  let pendingAgentsEvent = null;
  let latestAgentsEvent = null;
  let renderScheduled = false;
  let hasRenderedPersonas = false;

  // Persona icons mapping
  const personaIcons = {
    'default_chat': 'fa-comments',
    'repo_watcher': 'fa-shield-alt',
    'doc_janitor': 'fa-broom',
    'visual_llm': 'fa-palette',
    'specialx_console': 'fa-gears',
    'sbqc_workflow_architect': 'fa-project-diagram',
    'manual_override': 'fa-terminal'
  };

  // Personas to exclude from UI
  const excludedPersonas = [
    // manual_override is now shown but with special styling
  ];

  /**
   * Load agents from API to get list of used prompts
   */
  async function loadAgents() {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/agents', {
        headers: {
          'Authorization': `Bearer ${token || ''}`
        }
      });

      if (!response.ok) {
        console.warn('Failed to load agents, will show all personas');
        return [];
      }

      const result = await response.json();
      agents = result.data || [];
      console.log(`Loaded ${agents.length} agents`);
      return agents;
    } catch (error) {
      console.error('Error loading agents:', error);
      return [];
    }
  }

  /**
   * Load personas from API
   */
  async function loadPersonas() {
    try {
      // First load agents to know which prompts are used
      await loadAgents();

      // Extract prompt IDs used by agents
      const usedPromptIds = new Set(
        agents
          .filter(a => a.prompt && a.prompt._id)
          .map(a => a.prompt._id)
      );

      console.debug(`Found ${usedPromptIds.size} prompts used by agents`, Array.from(usedPromptIds));

      const token = localStorage.getItem('token');
      const response = await fetch('/api/prompts', {
        headers: {
          'Authorization': `Bearer ${token || ''}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to load personas');
      }

      const result = await response.json();
      const grouped = result.data || {};

      // Flatten grouped prompts - take only the active version or latest version
      personas = [];
      Object.keys(grouped).forEach(promptName => {
        // Skip excluded personas
        if (excludedPersonas.includes(promptName)) {
          console.debug(`Skipping excluded persona: ${promptName}`);
          return;
        }

        const versions = grouped[promptName];
        if (versions && versions.length > 0) {
          // Find active version or use latest (first in sorted array)
          const activeVersion = versions.find(v => v.isActive) || versions[0];

          // Keep dedicated UI personas visible even if linked to an agent prompt.
          // Only hide chat personas that are already represented in the agent grid.
          const uiType = activeVersion.uiConfig?.type || 'chat';
          if (uiType === 'chat' && usedPromptIds.has(activeVersion._id)) {
            console.debug(`Skipping chat persona "${promptName}" - used by agent`);
            return;
          }

          personas.push(activeVersion);
        }
      });

      console.log(`Loaded ${personas.length} personas (excluded: ${excludedPersonas.join(', ')}, ${usedPromptIds.size} used by agents)`);
      return personas;
    } catch (error) {
      console.error('Error loading personas:', error);
      personas = [];
      return [];
    }
  }

  /**
   * Render personas as cards in existing agent launcher
   */
  function renderPersonasInLauncher(containerEl) {
    console.debug('renderPersonasInLauncher() called with:', {
      containerEl: !!containerEl,
      personasCount: personas.length
    });

    if (!containerEl) {
      console.error('Cannot render personas: container element is null');
      return;
    }

    // Remove existing persona cards and separator to prevent duplicates
    const existingPersonas = containerEl.querySelectorAll('.persona-card, .persona-separator');
    console.debug(`Removing ${existingPersonas.length} existing persona elements`);
    existingPersonas.forEach(el => el.remove());

    console.debug(`Rendering ${personas.length} personas into launcher`);

    // Add visual separator if there are personas to show
    if (personas.length === 0) {
      console.debug('No personas to render');
      return;
    }

    // Separate personas into two groups:
    // 1. Special UI personas (dashboard, gallery, hybrid) - render as agents (no separator)
    // 2. Chat personas - render after separator as "Conversational Personas"
    const specialUIPersonas = personas.filter(p => {
      const uiType = p.uiConfig?.type || 'chat';
      return uiType !== 'chat';
    });

    const chatPersonas = personas.filter(p => {
      const uiType = p.uiConfig?.type || 'chat';
      return uiType === 'chat';
    });

    console.debug(`Split personas: ${specialUIPersonas.length} special UI (will render as agents), ${chatPersonas.length} chat (will render as personas)`);

    // Helper function to render a persona card
    const renderPersonaCard = (persona) => {
      const uiConfig = persona.uiConfig || { type: 'chat', route: '/index.html', capabilities: ['text'] };
      const icon = personaIcons[persona.name] || 'fa-robot';

      // Map persona type to agent category styling
      const categoryColor = getCategoryColor(uiConfig.type);
      const isActive = currentPersona && currentPersona.name === persona.name;

      // Special styling for manual_override - it supersedes agents
      const isManualOverride = persona.name === 'manual_override';
      const specialClass = isManualOverride ? 'manual-override-card' : '';
      const avatarColor = isManualOverride ? '#f59e0b' : categoryColor; // Orange for override

      return `
        <div class="agentx-card persona-card ${specialClass} ${isActive ? 'selected' : ''}"
             data-persona-name="${persona.name}"
             data-ui-type="${uiConfig.type}">
          <div class="agentx-card-avatar" style="--avatar-color: ${avatarColor}">
            <i class="fas ${icon}"></i>
          </div>

          <div class="agentx-card-content">
            <div class="agentx-card-header">
              <h4 class="agentx-card-name">${formatPersonaName(persona.name)}</h4>
            </div>
            <p class="agentx-card-description">${truncate(persona.description || 'No description available', 80)}</p>

            <div class="agentx-card-meta">
              <span class="agentx-category-badge" style="--badge-color: ${categoryColor}">
                <i class="fas ${getTypeIcon(uiConfig.type)}"></i>
                <span>${getTypeLabel(uiConfig.type)}</span>
              </span>
              ${isManualOverride
                ? `<span class="capability-badge" style="background: #f59e0b; color: #000; border: 1px solid #d97706;" title="Bypasses all agents/personas">⚡ Override</span>`
                : uiConfig.type === 'dashboard'
                  ? `<span class="capability-badge" style="background: #10b981; color: #fff; border: 1px solid #059669;" title="Dedicated dashboard UI">📊 Dashboard</span>`
                  : uiConfig.type === 'gallery'
                    ? `<span class="capability-badge" style="background: #8b5cf6; color: #fff; border: 1px solid #7c3aed;" title="Image generation UI">🎨 Gallery</span>`
                    : ''
              }
              ${(uiConfig.capabilities || []).slice(0, 2).map(cap =>
                `<span class="capability-badge" title="Supports ${cap}">${cap}</span>`
              ).join('')}
            </div>
          </div>

          <div class="agentx-card-actions">
            ${uiConfig.type === 'chat'
              ? `<button class="agentx-select-btn" onclick="event.stopPropagation(); window.PersonaSelector.selectPersona('${persona.name}')">
                   ${isActive ? '<i class="fas fa-check"></i>' : 'Select'}
                 </button>`
              : `<button class="agentx-select-btn" onclick="event.stopPropagation(); window.PersonaSelector.openPersonaUI('${persona.name}', '${uiConfig.route}')">
                   <i class="fas fa-external-link-alt"></i> Open
                 </button>`
            }
          </div>
        </div>
      `;
    };

    // Render special UI personas first (no separator - they're agents)
    const specialUICards = specialUIPersonas.map(renderPersonaCard).join('');

    // Add separator and chat personas
    const chatSeparator = chatPersonas.length > 0 ? `
      <div class="persona-separator" style="grid-column: 1 / -1; margin: 20px 0 10px 0; padding: 10px 0; border-top: 2px solid rgba(148, 163, 184, 0.2);">
        <div style="display: flex; align-items: center; gap: 8px; color: #94a3b8; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
          <i class="fas fa-comments"></i>
          <span>Conversational Personas</span>
          <span style="background: rgba(148, 163, 184, 0.2); padding: 2px 8px; border-radius: 12px;">${chatPersonas.length}</span>
        </div>
      </div>
    ` : '';

    const chatCards = chatPersonas.map(renderPersonaCard).join('');

    const allCards = specialUICards + chatSeparator + chatCards;

    if (allCards.trim()) {
      console.debug(`About to append ${specialUIPersonas.length} special UI + ${chatPersonas.length} chat personas`);
      containerEl.innerHTML += allCards;

      // Verify render
      const renderedCards = containerEl.querySelectorAll('.persona-card');
      console.log(`✓ Rendered ${personas.length} persona cards into launcher, now have ${renderedCards.length} persona cards in DOM`);
      console.debug(`  - ${specialUIPersonas.length} in agents section (no separator)`);
      console.debug(`  - ${chatPersonas.length} in personas section (with separator)`);
    } else {
      console.warn('No persona cards to render - all cards empty');
    }
  }

  /**
   * Get category color for persona type
   */
  function getCategoryColor(type) {
    const colors = {
      'chat': '#94a3b8',
      'dashboard': '#34d399',
      'gallery': '#f87171',
      'hybrid': '#a78bfa'
    };
    return colors[type] || '#94a3b8';
  }

  /**
   * Get icon for UI type
   */
  function getTypeIcon(type) {
    const icons = {
      'chat': 'fa-comments',
      'dashboard': 'fa-chart-line',
      'gallery': 'fa-palette',
      'hybrid': 'fa-layer-group'
    };
    return icons[type] || 'fa-robot';
  }

  /**
   * Get label for UI type
   */
  function getTypeLabel(type) {
    const labels = {
      'chat': 'Conversational',
      'dashboard': 'Monitoring',
      'gallery': 'Visual Generation',
      'hybrid': 'Multi-mode'
    };
    return labels[type] || capitalizeFirst(type);
  }

  /**
   * Format persona name for display
   */
  function formatPersonaName(name) {
    return name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Capitalize first letter
   */
  function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Truncate text
   */
  function truncate(text, length) {
    if (!text) return '';
    if (text.length <= length) return text;
    return text.substring(0, length - 3) + '...';
  }

  /**
   * Select persona for chat
   */
  function selectPersona(personaName) {
    const persona = personas.find(p => p.name === personaName);
    if (!persona) {
      console.error('Persona not found:', personaName);
      return;
    }

    currentPersona = persona;
    localStorage.setItem('agentx_current_persona', JSON.stringify(persona));

    // Update visual state of persona cards
    const launcherGrid = document.getElementById('agentxLauncherGrid');
    if (launcherGrid) {
      // Remove 'selected' class from all persona cards
      launcherGrid.querySelectorAll('.persona-card').forEach(card => {
        card.classList.remove('selected');
        // Update button text
        const btn = card.querySelector('.agentx-select-btn');
        if (btn && !btn.querySelector('i.fa-external-link-alt')) {
          btn.textContent = 'Select';
        }
      });

      // Add 'selected' class to the clicked persona card
      const selectedCard = launcherGrid.querySelector(`.persona-card[data-persona-name="${personaName}"]`);
      if (selectedCard) {
        selectedCard.classList.add('selected');
        // Update button to show checkmark
        const btn = selectedCard.querySelector('.agentx-select-btn');
        if (btn) {
          btn.innerHTML = '<i class="fas fa-check"></i>';
        }
      }
    }

    // Update the prompt selector in the chat interface
    const promptSelect = document.getElementById('promptSelect');
    if (promptSelect) {
      promptSelect.value = personaName;
      // Trigger change event to update chat
      promptSelect.dispatchEvent(new Event('change'));
    }

    // Hide agent launcher after selection
    const launcher = document.getElementById('agentxLauncher');
    if (launcher) {
      launcher.style.display = 'none';
    }

    // Show chat window
    const chatWindow = document.getElementById('chatWindow');
    if (chatWindow) {
      chatWindow.style.display = 'block';
    }

    // Show toast notification
    if (window.showToast) {
      window.showToast(`Switched to ${formatPersonaName(personaName)}`, 'success');
    }
  }

  /**
   * Open persona's dedicated UI
   */
  function openPersonaUI(personaName, route) {
    if (route && route !== '/index.html') {
      // Navigate to dedicated UI
      window.location.href = route + `?persona=${personaName}`;
    } else {
      // Fall back to chat selection
      selectPersona(personaName);
    }
  }

  /**
   * Initialize - hook into existing agent launcher
   */
  async function init() {
    console.log('PersonaSelector init() starting...');

    // CRITICAL: Attach event listeners FIRST before any async operations
    // Otherwise the event might fire before the listener is attached
    window.addEventListener('agentx:agents-loaded', (e) => {
      console.debug('Received agentx:agents-loaded event');
      handleAgentsEvent(e);
    });
    window.addEventListener('agentx:agents-rendered', (e) => {
      console.debug('Received agentx:agents-rendered event');
      handleAgentsEvent(e);
    });
    console.log('Event listeners attached, now loading personas...');

    // Load personas (async operation)
    await loadPersonas();
    personasReady = true;

    // Load current persona from localStorage
    const savedPersona = localStorage.getItem('agentx_current_persona');
    if (savedPersona) {
      currentPersona = JSON.parse(savedPersona);
    }

    console.log('Persona selector fully initialized');

    // Flush any queued event that arrived before personas finished loading.
    if (pendingAgentsEvent) {
      const queuedEvent = pendingAgentsEvent;
      pendingAgentsEvent = null;
      handleAgentsEvent(queuedEvent);
      return;
    }

    // FALLBACK: If agents are already rendered but no event is pending, render now.
    const launcherGrid = document.getElementById('agentxLauncherGrid');
    if (launcherGrid) {
      const agentCards = launcherGrid.querySelectorAll('.agentx-card:not(.persona-card)');
      if (agentCards.length > 0 && !hasRenderedPersonas) {
        console.log(`Fallback: Found ${agentCards.length} agent cards already rendered, rendering personas now`);
        handleAgentsEvent({
          type: 'agentx:fallback-render',
          detail: { agentCount: agentCards.length }
        });
      }
    }
  }

  /**
   * Handle agents loaded/rendered event - render personas after agents are ready
   * This fires on initial load AND after category filter changes
   */
  function handleAgentsEvent(event) {
    const normalizedEvent = event || { type: 'agentx:manual-render', detail: {} };

    if (!personasReady) {
      pendingAgentsEvent = normalizedEvent;
      return;
    }

    latestAgentsEvent = normalizedEvent;
    scheduleRender();
  }

  function scheduleRender() {
    if (renderScheduled) {
      return;
    }

    renderScheduled = true;
    const flush = () => {
      renderScheduled = false;
      if (!latestAgentsEvent) {
        return;
      }
      renderForAgentsEvent(latestAgentsEvent);
      latestAgentsEvent = null;
    };

    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(flush);
      return;
    }

    setTimeout(flush, 0);
  }

  function renderForAgentsEvent(event) {
    const agentCount = event?.detail?.agentCount ?? 'unknown';
    console.log(`Agents event: ${event.type} (${agentCount} agents), rendering ${personas.length} personas...`);

    const launcherGrid = document.getElementById('agentxLauncherGrid');

    if (!launcherGrid) {
      console.error('Element #agentxLauncherGrid not found!');
      console.log('Available elements:',
        Array.from(document.querySelectorAll('[id*="launcher"]')).map(e => e.id)
      );
      return;
    }

    if (personas.length === 0) {
      console.info('No personas to render.');
      return;
    }

    // Render personas - they get appended after agents
    renderPersonasInLauncher(launcherGrid);
    hasRenderedPersonas = true;
  }

  /**
   * Export public API
   */
  window.PersonaSelector = {
    init,
    loadPersonas,
    selectPersona,
    openPersonaUI,
    renderPersonasInLauncher,
    formatPersonaName,
    handleAgentsEvent  // Expose for manual triggering if needed
  };

  // Auto-initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
