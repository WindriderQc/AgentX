/**
 * Chat agents — Agent system, launcher, selection, panel updates
 */
import { updateConfigSummary } from './chat-config.js';

const agentSystemLog = {
  info: (...args) => console.info('[AgentSystem]', ...args),
  debug: (...args) => console.debug('[AgentSystem]', ...args),
  warn: (...args) => console.warn('[AgentSystem]', ...args),
  error: (...args) => console.error('[AgentSystem]', ...args)
};

export async function initAgentSystem(elements, state, helpers) {
  const agentElements = {
    launcherContainer: document.getElementById('agentxLauncher'),
    activePanel: document.getElementById('agentActivePanel'),
    defaultSummary: document.getElementById('defaultConfigSummary'),
    agentSummary: document.getElementById('agentConfigSummary'),
    activeName: document.getElementById('activeAgentName'),
    activeRole: document.getElementById('activeAgentRole'),
    activeAvatar: document.getElementById('activeAgentAvatar'),
    activeModel: document.getElementById('activeAgentModel'),
    activeTools: document.getElementById('activeAgentTools'),
    changeBtn: document.getElementById('changeAgentBtn'),
    summaryName: document.getElementById('summaryAgentName'),
    summaryTools: document.getElementById('summaryAgentTools')
  };

  // Store for access by other modules
  state._agentElements = agentElements;

  agentSystemLog.info('Initializing.');
  if (!agentElements.launcherContainer || !window.AgentListView) {
    agentSystemLog.error('Agent launcher container or AgentListView missing.');
    return;
  }

  let agentListView = new AgentListView(agentElements.launcherContainer, {
    launcherMode: true,
    showFilters: true,
    showSearch: true,
    onSelect: (agent) => handleAgentSelection(agent, elements, state, helpers, agentElements, agentListView)
  });
  state._agentListView = agentListView;

  const urlParams = new URLSearchParams(window.location.search);
  const hasConversation = urlParams.get('c');
  const agentIdParam = urlParams.get('agent');

  if (agentElements.changeBtn) {
    agentElements.changeBtn.addEventListener('click', () => showLauncher(agentElements, agentListView));
  }

  try {
    const initialLoadPromise = agentListView.readyPromise && typeof agentListView.readyPromise.then === 'function'
      ? agentListView.readyPromise
      : agentListView.load();
    await initialLoadPromise;
    agentSystemLog.info(`Loaded ${agentListView.agents.length} agents for launcher.`);
    window.dispatchEvent(new CustomEvent('agentx:agents-loaded', {
      detail: { agentCount: agentListView.agents.length }
    }));
  } catch (e) {
    agentSystemLog.error('Failed to load agents during initialization:', e);
  }

  if (agentIdParam) {
    const preSelectedAgent = agentListView.agents.find(a => a._id === agentIdParam);
    if (preSelectedAgent) {
      handleAgentSelection(preSelectedAgent, elements, state, helpers, agentElements, agentListView);
    } else {
      agentSystemLog.warn(`Agent ID ${agentIdParam} not found in list.`);
    }
  }

  if (!hasConversation && !state.agentId) {
    showLauncher(agentElements, agentListView);
  }

  agentElements.launcherContainer.addEventListener('click', (e) => {
    if (e.target.id === 'skipAgentBtn') hideLauncher(agentElements);
  });
}

function handleAgentSelection(agent, elements, state, helpers, agentElements, agentListView) {
  if (!agent) {
    agentSystemLog.info('Clearing agent selection.');
    state.agent = null;
    state.agentId = null;
    if (agentElements.activeName) agentElements.activeName.textContent = 'None';
    if (agentElements.activeRole) agentElements.activeRole.textContent = 'Manual';
    if (agentElements.activeAvatar) agentElements.activeAvatar.innerHTML = '<i class="fas fa-robot"></i>';
    if (agentListView) agentListView.setSelectedAgent(null);
    hideLauncher(agentElements);
    helpers.appendMessage({ role: 'system', content: 'Agent selection cleared. You are now in manual mode.' }, { persist: false, count: false });
    if (agentElements.summaryName) agentElements.summaryName.textContent = 'No Agent';
    updateHeaderBar(null, state);
    return;
  }

  agentSystemLog.info('Selected agent:', { id: agent._id, name: agent.displayName });
  state.agent = agent;
  state.agentId = agent._id;

  if (agentListView) agentListView.setSelectedAgent(agent._id);

  if (agent.defaultModel) {
    if (elements.modelSelect.querySelector(`option[value="${agent.defaultModel}"]`) === null) {
      const opt = document.createElement('option');
      opt.value = agent.defaultModel;
      opt.textContent = agent.defaultModel + ' (Agent)';
      elements.modelSelect.appendChild(opt);
    }
    elements.modelSelect.value = agent.defaultModel;
    state.settings.model = agent.defaultModel;
    updateConfigSummary(elements);
  }

  updateAgentPanel(agent, agentElements);
  updateHeaderBar(agent, state);
  hideLauncher(agentElements);

  helpers.appendMessage({
    role: 'system',
    content: `Activated agent **${agent.displayName}**. ${agent.description ? agent.description.slice(0, 100) : ''}...`
  }, { persist: false, count: false });

  const pendingMessage = elements.messageInput?.value.trim();
  if (pendingMessage) {
    helpers.sendMessage();
  } else if (elements.messageInput) {
    elements.messageInput.focus();
  }
}

function updateAgentPanel(agent, agentElements) {
  if (!agent) return;
  if (agentElements.activeName) agentElements.activeName.textContent = agent.displayName;
  if (agentElements.activeRole) agentElements.activeRole.textContent = agent.category ? agent.category.charAt(0).toUpperCase() + agent.category.slice(1) : 'Agent';

  const avatarHtml = agent.avatar && agent.avatar.startsWith('http')
    ? `<img src="${agent.avatar}" alt="${agent.displayName}">`
    : `<i class="fas ${agent.avatar || 'fa-robot'}"></i>`;
  if (agentElements.activeAvatar) agentElements.activeAvatar.innerHTML = avatarHtml;

  const activeModelSpan = agentElements.activeModel?.querySelector('span');
  if (activeModelSpan) activeModelSpan.textContent = agent.defaultModel;
  const activeToolsSpan = agentElements.activeTools?.querySelector('span');
  if (activeToolsSpan) activeToolsSpan.textContent = `${agent.n8nTools?.length || 0} Tools`;

  if (agentElements.summaryName) agentElements.summaryName.textContent = agent.displayName;
  if (agentElements.summaryTools) agentElements.summaryTools.textContent = agent.n8nTools?.length || 0;

  if (agentElements.activePanel) agentElements.activePanel.style.display = 'block';
  if (agentElements.agentSummary) agentElements.agentSummary.style.display = 'flex';
  if (agentElements.defaultSummary) agentElements.defaultSummary.style.display = 'none';
}

export function updateHeaderBar(agent, state) {
  const agentNameEl = document.getElementById('headerAgentName');
  const agentAvatarEl = document.getElementById('headerAgentAvatar');
  const modelBadgeEl = document.getElementById('headerModelBadge');

  if (!agentNameEl) return;

  if (agent) {
    agentNameEl.textContent = agent.displayName;
    if (agentAvatarEl) {
      agentAvatarEl.innerHTML = agent.avatar && agent.avatar.startsWith('http')
        ? `<img src="${agent.avatar}" alt="${agent.displayName}" style="width:24px;height:24px;border-radius:6px;">`
        : `<i class="fas ${agent.avatar || 'fa-robot'}"></i>`;
    }
    if (modelBadgeEl) modelBadgeEl.textContent = agent.defaultModel || '';
  } else {
    agentNameEl.textContent = 'AgentX';
    if (agentAvatarEl) agentAvatarEl.innerHTML = '<i class="fas fa-robot"></i>';
    if (modelBadgeEl) modelBadgeEl.textContent = state.settings?.model || '';
  }
}

function showLauncher(agentElements, agentListView) {
  if (agentElements.launcherContainer) {
    agentElements.launcherContainer.style.display = 'flex';
    if (agentListView && (!agentListView.agents || agentListView.agents.length === 0)) {
      agentListView.load();
    }
  }
}

function hideLauncher(agentElements) {
  if (agentElements.launcherContainer) {
    agentElements.launcherContainer.style.display = 'none';
  }
}

export function reapplyAgentModel(elements, state) {
  if (state.agent && state.agent.defaultModel) {
    if (elements.modelSelect.querySelector(`option[value="${state.agent.defaultModel}"]`) === null) {
      const opt = document.createElement('option');
      opt.value = state.agent.defaultModel;
      opt.textContent = state.agent.defaultModel + ' (Agent)';
      elements.modelSelect.appendChild(opt);
    }
    elements.modelSelect.value = state.agent.defaultModel;
    state.settings.model = state.agent.defaultModel;
    updateConfigSummary(elements);
  }
}
