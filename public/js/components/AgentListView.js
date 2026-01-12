/**
 * AgentListView Component
 * Grid view with category filtering and search for AgentX entities
 * Used in the Agent Library page and Chat Launcher
 */

class AgentListView {
    constructor(container, options = {}) {
        this.container = typeof container === 'string'
            ? document.querySelector(container)
            : container;

        if (!this.container) {
            console.error('AgentListView: Container not found');
            return;
        }

        // Options
        this.options = {
            showFilters: true,
            showSearch: true,
            compact: false,
            onSelect: null,
            onEdit: null,
            onDelete: null,
            launcherMode: false,  // When true, shows centered launcher layout
            ...options
        };

        // State
        this.agents = [];
        this.selectedAgentId = null;
        this.filters = {
            category: 'all',
            search: ''
        };
        this.viewMode = 'grid';  // 'grid' or 'list'
        this.loading = false;

        // Initialize
        this.init();
    }

    async init() {
        this.render();
        await this.load();
    }

    /**
     * Load agents from API
     */
    async load() {
        this.loading = true;
        this.renderLoading();

        try {
            const params = new URLSearchParams();
            if (this.filters.category !== 'all') {
                params.set('category', this.filters.category);
            }
            if (this.filters.search) {
                params.set('search', this.filters.search);
            }

            const response = await fetch(`/api/agents?${params.toString()}`, {
                credentials: 'include',
                headers: {
                    'X-Workspace-Id': window.currentWorkspace?.id || ''
                }
            });

            const data = await response.json();

            if (data.status === 'success') {
                this.agents = data.data || [];
            } else {
                console.error('Failed to load agents:', data.message);
                this.agents = [];
            }
        } catch (err) {
            console.error('Error loading agents:', err);
            this.agents = [];
        }

        this.loading = false;
        this.renderAgents();
    }

    /**
     * Main render function
     */
    render() {
        const { showFilters, showSearch, launcherMode } = this.options;

        if (launcherMode) {
            this.container.innerHTML = `
                <div class="agentx-launcher">
                    <div class="agentx-launcher-header">
                        <h2><i class="fas fa-user-astronaut"></i> Choose an Agent</h2>
                        <p>Select an AgentX to start your conversation</p>
                    </div>
                    ${showFilters ? this.renderFiltersHtml() : ''}
                    <div class="agentx-launcher-grid" id="agentGrid">
                        <!-- Agents rendered here -->
                    </div>
                </div>
            `;
        } else {
            this.container.innerHTML = `
                <div class="agentx-list-view">
                    ${showFilters ? this.renderFiltersHtml() : ''}
                    <div class="agentx-grid-wrapper">
                        <div class="agentx-grid ${this.viewMode === 'list' ? 'compact' : ''}" id="agentGrid">
                            <!-- Agents rendered here -->
                        </div>
                    </div>
                </div>
            `;
        }

        this.attachEventListeners();
    }

    /**
     * Render filters HTML
     */
    renderFiltersHtml() {
        const categories = AgentXCard.getAllCategories();

        return `
            <div class="agentx-filters">
                <div class="agentx-category-tabs">
                    <button class="agentx-category-tab ${this.filters.category === 'all' ? 'active' : ''}"
                            data-category="all">
                        All
                    </button>
                    ${categories.map(cat => {
                        const config = AgentXCard.getCategory(cat);
                        return `
                            <button class="agentx-category-tab ${this.filters.category === cat ? 'active' : ''}"
                                    data-category="${cat}"
                                    style="--tab-color: ${config.color}">
                                <i class="fas ${config.icon}"></i>
                                ${config.label}
                            </button>
                        `;
                    }).join('')}
                </div>
                ${this.options.showSearch ? `
                    <input type="text"
                           class="agentx-search-input"
                           placeholder="Search agents..."
                           value="${this.escapeHtml(this.filters.search)}">
                ` : ''}
                ${!this.options.launcherMode ? `
                    <div class="agentx-view-toggle">
                        <button class="view-toggle-btn ${this.viewMode === 'grid' ? 'active' : ''}" data-view="grid">
                            <i class="fas fa-th"></i>
                        </button>
                        <button class="view-toggle-btn ${this.viewMode === 'list' ? 'active' : ''}" data-view="list">
                            <i class="fas fa-list"></i>
                        </button>
                    </div>
                ` : ''}
            </div>
        `;
    }

    /**
     * Render loading state
     */
    renderLoading() {
        const grid = this.container.querySelector('#agentGrid');
        if (grid) {
            grid.innerHTML = `
                <div class="agentx-loading">
                    <i class="fas fa-spinner fa-spin"></i>
                    <span>Loading agents...</span>
                </div>
            `;
        }
    }

    /**
     * Render agents grid
     */
    renderAgents() {
        const grid = this.container.querySelector('#agentGrid');
        if (!grid) return;

        let html = '';

        // Add "Manual / No Agent" option if in launcher mode
        // Only show if no search/filter is active (or maybe always?) - Always seems better for "Reset"
        if (this.options.launcherMode && !this.filters.search) {
             html += `
                <div class="agentx-card manual-card" data-manual="true">
                    <div class="agentx-card-avatar" style="--avatar-color: #64748b">
                        <i class="fas fa-terminal"></i>
                    </div>
                    <div class="agentx-card-content">
                        <div class="agentx-card-header">
                            <h4 class="agentx-card-name">Manual Override</h4>
                        </div>
                        <p class="agentx-card-description">Standard chat mode without any specific agent persona or tools.</p>
                        <div class="agentx-card-meta">
                             <span class="agentx-category-badge" style="--badge-color: #64748b">
                                <i class="fas fa-cog"></i>
                                <span>System</span>
                            </span>
                        </div>
                    </div>
                    <div class="agentx-card-actions">
                        <button class="agentx-select-btn">
                            Select
                        </button>
                    </div>
                </div>
            `;
        }

        if (this.agents.length === 0 && !html) {
            grid.innerHTML = `
                <div class="agentx-empty">
                    <i class="fas fa-user-astronaut"></i>
                    <h3>No Agents Found</h3>
                    <p>${this.filters.search || this.filters.category !== 'all'
                        ? 'Try adjusting your filters'
                        : 'Create your first agent to get started'}</p>
                </div>
            `;
            return;
        }

        html += this.agents.map(agent =>
            AgentXCard.render(agent, {
                selected: agent._id === this.selectedAgentId,
                compact: this.viewMode === 'list',
                showDescription: this.viewMode !== 'list',
                editable: !!this.options.onEdit
            })
        ).join('');

        grid.innerHTML = html;

        // Re-attach card click listeners
        grid.querySelectorAll('.agentx-card').forEach(card => {
             if (card.dataset.manual === 'true') {
                 card.addEventListener('click', () => this.handleManualSelect());
             } else {
                 card.addEventListener('click', (e) => this.handleCardClick(e, card));
             }
        });
    }

    handleManualSelect() {
        if (this.options.onSelect) {
            this.options.onSelect(null); // Null means "No Agent"
        }
    }

    /**
     * Attach event listeners
     */
    attachEventListeners() {
        // Category tabs
        this.container.querySelectorAll('.agentx-category-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.filters.category = tab.dataset.category;
                this.updateCategoryTabs();
                this.load();
            });
        });

        // Search input
        const searchInput = this.container.querySelector('.agentx-search-input');
        if (searchInput) {
            let debounceTimer;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    this.filters.search = e.target.value;
                    this.load();
                }, 300);
            });
        }

        // View toggle
        this.container.querySelectorAll('.view-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.viewMode = btn.dataset.view;
                this.updateViewToggle();
                this.renderAgents();
            });
        });
    }

    /**
     * Handle card click
     */
    handleCardClick(event, card) {
        // Check if clicked on select button
        const selectBtn = event.target.closest('.agentx-select-btn');
        if (selectBtn || event.target.classList.contains('agentx-select-btn')) {
            const agentId = card.dataset.agentId;
            this.selectAgent(agentId);
            return;
        }

        // Handle edit if option provided
        if (this.options.onEdit && event.target.closest('.agentx-edit-btn')) {
            const agentId = card.dataset.agentId;
            const agent = this.agents.find(a => a._id === agentId);
            if (agent) {
                this.options.onEdit(agent);
            }
            return;
        }

        // Default: select the card
        const agentId = card.dataset.agentId;
        this.selectAgent(agentId);
    }

    /**
     * Select an agent
     */
    selectAgent(agentId) {
        this.selectedAgentId = agentId;
        const agent = this.agents.find(a => a._id === agentId);

        // Update UI
        this.container.querySelectorAll('.agentx-card').forEach(card => {
            const isSelected = card.dataset.agentId === agentId;
            card.classList.toggle('selected', isSelected);
            const btn = card.querySelector('.agentx-select-btn');
            if (btn) {
                btn.classList.toggle('selected', isSelected);
                btn.innerHTML = isSelected ? '<i class="fas fa-check"></i>' : 'Select';
            }
        });

        // Callback
        if (this.options.onSelect && agent) {
            this.options.onSelect(agent);
        }
    }

    /**
     * Update category tabs UI
     */
    updateCategoryTabs() {
        this.container.querySelectorAll('.agentx-category-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.category === this.filters.category);
        });
    }

    /**
     * Update view toggle UI
     */
    updateViewToggle() {
        this.container.querySelectorAll('.view-toggle-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === this.viewMode);
        });

        const grid = this.container.querySelector('.agentx-grid');
        if (grid) {
            grid.classList.toggle('compact', this.viewMode === 'list');
        }
    }

    /**
     * Get selected agent
     */
    getSelectedAgent() {
        return this.agents.find(a => a._id === this.selectedAgentId) || null;
    }

    /**
     * Set selected agent by ID
     */
    setSelectedAgent(agentId) {
        this.selectedAgentId = agentId;
        this.renderAgents();
    }

    /**
     * Refresh the list
     */
    async refresh() {
        await this.load();
    }

    /**
     * Utility: Escape HTML
     */
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AgentListView;
} else if (typeof window !== 'undefined') {
    window.AgentListView = AgentListView;
}
