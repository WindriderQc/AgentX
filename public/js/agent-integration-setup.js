
  // ==========================================
  // V7: AgentX Integration Logic
  // ==========================================
  
  // Elements for AgentX
  const agentElements = {
    launcherContainer: document.getElementById('agentxLauncher'),
    activePanel: document.getElementById('agentActivePanel'),
    defaultSummary: document.getElementById('defaultConfigSummary'),
    agentSummary: document.getElementById('agentConfigSummary'),
    // Active Panel Elements
    activeName: document.getElementById('activeAgentName'),
    activeRole: document.getElementById('activeAgentRole'),
    activeAvatar: document.getElementById('activeAgentAvatar'),
    activeModel: document.getElementById('activeAgentModel'),
    activeTools: document.getElementById('activeAgentTools'),
    changeBtn: document.getElementById('changeAgentBtn'),
    // Summary Elements
    summaryName: document.getElementById('summaryAgentName'),
    summaryTools: document.getElementById('summaryAgentTools')
  };

  let agentListView = null;

  async function initAgentSystem() {
    if (!agentElements.launcherContainer || !window.AgentListView) return;

    // Initialize AgentListView in Launcher Mode
    agentListView = new AgentListView(agentElements.launcherContainer, {
        launcherMode: true,
        showFilters: true,
        showSearch: true,
        onSelect: handleAgentSelection
    });

    // Check URL params for specific agent or conversation to skipping launcher
    const urlParams = new URLSearchParams(window.location.search);
    const hasConversation = urlParams.get('c');
    
    // Wire up Change Agent Button
    if (agentElements.changeBtn) {
        agentElements.changeBtn.addEventListener('click', () => {
            showLauncher();
        });
    }

    // Load agents and show launcher if needed
    // Only load if visible or needed to save bandwidth? No, load fast.
    await agentListView.load();

    // Decide whether to show launcher
    // If not loading a specific conversation and no agent selected, show launcher
    // Also check if we are just starting up
    if (!hasConversation && !state.agentId) {
        showLauncher();
    }
    
    // Add skip button listener (delegated since it might be re-rendered)
    agentElements.launcherContainer.addEventListener('click', (e) => {
        if (e.target.id === 'skipAgentBtn') {
            hideLauncher();
        }
    });
  }

  function handleAgentSelection(agent) {
      if (!agent) return;
      
      console.log('Selected agent:', agent);
      state.agent = agent;
      state.agentId = agent._id;
      
      // Update Model Selection
      if (agent.defaultModel) {
           elements.modelSelect.value = agent.defaultModel;
           // If not found in select, maybe add it? 
           if (elements.modelSelect.value !== agent.defaultModel) {
               const opt = document.createElement('option');
               opt.value = agent.defaultModel;
               opt.textContent = agent.defaultModel + ' (Agent)';
               elements.modelSelect.appendChild(opt);
               elements.modelSelect.value = agent.defaultModel;
           }
      }
      
      // Update UI Panels
      updateAgentPanel(agent);
      
      hideLauncher();
      
      // Notify user
      appendMessage({
          role: 'system',
          content: `Activated agent **${agent.displayName}**. ${agent.description ? agent.description.slice(0, 100) : ''}...`
      });
  }

  function updateAgentPanel(agent) {
      if (!agent) return;
      
      // Update Active Panel
      if (agentElements.activeName) agentElements.activeName.textContent = agent.displayName;
      if (agentElements.activeRole) agentElements.activeRole.textContent = agent.category ? agent.category.charAt(0).toUpperCase() + agent.category.slice(1) : 'Agent';
      
      // Avatar
      const avatarHtml = agent.avatar.startsWith('http') 
        ? `<img src="${agent.avatar}" alt="${agent.displayName}">`
        : `<i class="fas ${agent.avatar}"></i>`;
      if (agentElements.activeAvatar) agentElements.activeAvatar.innerHTML = avatarHtml;
      
      // Stats
      if (agentElements.activeModel) agentElements.activeModel.querySelector('span').textContent = agent.defaultModel;
      if (agentElements.activeTools) agentElements.activeTools.querySelector('span').textContent = `${agent.n8nTools?.length || 0} Tools`;
      
      // Summary Panel (Collapsed)
      if (agentElements.summaryName) agentElements.summaryName.textContent = agent.displayName;
      if (agentElements.summaryTools) agentElements.summaryTools.textContent = agent.n8nTools?.length || 0;
      
      // Toggle Visibility
      if (agentElements.activePanel) agentElements.activePanel.style.display = 'block';
      if (agentElements.agentSummary) agentElements.agentSummary.style.display = 'flex';
      if (agentElements.defaultSummary) agentElements.defaultSummary.style.display = 'none';
  }

  function showLauncher() {
      if (agentElements.launcherContainer) {
          agentElements.launcherContainer.style.display = 'flex';
          if (agentListView && (!agentListView.agents || agentListView.agents.length === 0)) {
              agentListView.load();
          }
      }
  }

  function hideLauncher() {
      if (agentElements.launcherContainer) {
          agentElements.launcherContainer.style.display = 'none';
      }
  }

  // Initialize
  initAgentSystem();
