
/**
 * Agent Library Page Logic
 * Replaces old prompts.js functionality with AgentX based system
 */

document.addEventListener('DOMContentLoaded', async () => {
    // Elements
    const listContainer = document.getElementById('promptListContainer');
    const searchInput = document.getElementById('searchInput');
    const loadingState = document.getElementById('loadingState');
    const emptyState = document.getElementById('emptyState');
    const createBtn = document.getElementById('createPromptBtn'); // ID kept for CSS compat
    const statusFilter = document.getElementById('statusFilter');

    if (!listContainer) return;

    // Initialize AgentListView
    // We pass the container where the grid should be rendered
    const agentListView = new AgentListView(listContainer, {
        showFilters: false, // We use external filters (the toolbar above)
        compact: false,
        onSelect: handleAgentSelect,
        onEdit: handleAgentEdit,
        onDelete: handleAgentDelete
    });

    // Initial Load
    await loadAgents();

    // Event Listeners
    if (searchInput) {
        let debounceTimer;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                agentListView.filters.search = e.target.value;
                loadAgents();
            }, 300);
        });
    }

    if (statusFilter) {
        statusFilter.addEventListener('change', (e) => {
            // Need to implement status filter in AgentListView or API
            // For now ignored or pass as custom param if API supports
        });
    }

    // Modal Instance
    const agentBuilder = new AgentBuilderModal();

    if (createBtn) {
        createBtn.addEventListener('click', () => {
            agentBuilder.open(null, () => loadAgents());
        });
    }

    // Helper Functions
    async function loadAgents() {
        if (loadingState) loadingState.style.display = 'flex';
        if (listContainer) listContainer.style.opacity = '0.5';

        await agentListView.load();

        if (loadingState) loadingState.style.display = 'none';
        if (listContainer) listContainer.style.opacity = '1';

        // Update stats (optional)
        updateStats(agentListView.agents.length);
        
        // Show empty state if needed
        if (agentListView.agents.length === 0) {
            listContainer.style.display = 'none';
            if (emptyState) emptyState.style.display = 'flex';
        } else {
            listContainer.style.display = 'block';
            if (emptyState) emptyState.style.display = 'none';
        }
    }

    function updateStats(count) {
        const totalEl = document.getElementById('totalPrompts');
        if (totalEl) totalEl.textContent = count;
    }

    function handleAgentSelect(agent) {
        console.log('Selected agent:', agent);
        // Redirect to chat with this agent selected
        window.location.href = `/?agent=${agent._id}`;
    }

    function handleAgentEdit(agent) {
        agentBuilder.open(agent, () => loadAgents());
    }

    function handleAgentDelete(agent) {
        if (confirm(`Are you sure you want to delete ${agent.displayName}?`)) {
            // Call API to delete
            fetch(`/api/agents/${agent._id}`, { method: 'DELETE' })
                .then(res => {
                    if (res.ok) loadAgents();
                });
        }
    }
});
