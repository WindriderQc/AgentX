/**
 * AgentXCard Component
 * Displays an AgentX entity as a card with avatar, category badge, and model info
 * Used in the Agent Library and Chat Launcher
 */

const AgentXCard = (() => {
    /**
     * Category configuration (extends CategoryBadge config with specialist)
     */
    const CATEGORY_CONFIG = {
        coding: { color: '#7c9fff', icon: 'fa-code', label: 'Coding' },
        reasoning: { color: '#a78bfa', icon: 'fa-brain', label: 'Reasoning' },
        factual: { color: '#34d399', icon: 'fa-book', label: 'Factual' },
        math: { color: '#fbbf24', icon: 'fa-calculator', label: 'Math' },
        creative: { color: '#f87171', icon: 'fa-palette', label: 'Creative' },
        general: { color: '#94a3b8', icon: 'fa-robot', label: 'General' },
        specialist: { color: '#eab308', icon: 'fa-star', label: 'Specialist' }
    };

    /**
     * Escape HTML to prevent XSS
     */
    const escapeHtml = (text) => {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };

    /**
     * Format model name for display (shorten if too long)
     */
    const formatModelName = (model) => {
        if (!model) return 'No model';
        // Remove :latest suffix
        model = model.replace(/:latest$/, '');
        // Shorten if too long
        if (model.length > 20) {
            return model.substring(0, 18) + '...';
        }
        return model;
    };

    /**
     * Render an AgentX card
     * @param {object} agent - Agent data object
     * @param {object} options - Rendering options
     * @param {boolean} options.selected - Whether this card is selected
     * @param {boolean} options.compact - Compact view (for list mode)
     * @param {boolean} options.showDescription - Show description (default: true)
     * @param {boolean} options.showTools - Show tool count (default: true)
     * @param {function} options.onSelect - Callback when card is selected
     * @returns {string} HTML string for the card
     */
    const render = (agent, options = {}) => {
        const {
            selected = false,
            compact = false,
            showDescription = true,
            showTools = true,
            editable = false
        } = options;

        const catConfig = CATEGORY_CONFIG[agent.category] || CATEGORY_CONFIG.general;
        const toolCount = agent.n8nToolCount || agent.n8nTools?.filter(t => t.isActive).length || 0;
        const hasTools = toolCount > 0;

        // Card classes
        const cardClasses = [
            'agentx-card',
            selected ? 'selected' : '',
            compact ? 'compact' : '',
            agent.isDefault ? 'is-default' : ''
        ].filter(Boolean).join(' ');

        let html = `
            <div class="${cardClasses}" data-agent-id="${agent._id}" data-agent-name="${escapeHtml(agent.name)}">
                <div class="agentx-card-avatar" style="--avatar-color: ${catConfig.color}">
                    <i class="fas ${agent.avatar || catConfig.icon}"></i>
                </div>

                <div class="agentx-card-content">
                    <div class="agentx-card-header">
                        <h4 class="agentx-card-name">${escapeHtml(agent.displayName)}</h4>
                        ${agent.isDefault ? '<span class="agentx-default-badge">Default</span>' : ''}
                    </div>
        `;

        // Description (non-compact only)
        if (showDescription && !compact && agent.description) {
            const desc = agent.description.length > 80
                ? agent.description.substring(0, 77) + '...'
                : agent.description;
            html += `<p class="agentx-card-description">${escapeHtml(desc)}</p>`;
        }

        // Meta row: Category badge + Model + Tools
        html += `
                    <div class="agentx-card-meta">
                        <span class="agentx-category-badge" style="--badge-color: ${catConfig.color}">
                            <i class="fas ${catConfig.icon}"></i>
                            <span>${catConfig.label}</span>
                        </span>
                        <span class="agentx-model-badge">
                            <i class="fas fa-microchip"></i>
                            <span>${escapeHtml(formatModelName(agent.defaultModel))}</span>
                        </span>
        `;

        if (showTools && hasTools) {
            html += `
                        <span class="agentx-tools-badge" title="${toolCount} N8N tool${toolCount > 1 ? 's' : ''} available">
                            <i class="fas fa-bolt"></i>
                            <span>${toolCount}</span>
                        </span>
            `;
        }

        html += `
                    </div>
                </div>

                <div class="agentx-card-actions">
                    ${editable ? `
                    <button class="agentx-edit-btn" title="Edit Agent">
                        <i class="fas fa-pencil-alt"></i>
                    </button>
                    ` : ''}
                    <button class="agentx-select-btn ${selected ? 'selected' : ''}">
                        ${selected ? '<i class="fas fa-check"></i>' : 'Select'}
                    </button>
                </div>
            </div>
        `;

        return html;
    };

    /**
     * Render a minimal card for inline display
     */
    const renderMini = (agent) => {
        const catConfig = CATEGORY_CONFIG[agent.category] || CATEGORY_CONFIG.general;

        return `
            <span class="agentx-mini-card" data-agent-id="${agent._id}">
                <span class="agentx-mini-avatar" style="--avatar-color: ${catConfig.color}">
                    <i class="fas ${agent.avatar || catConfig.icon}"></i>
                </span>
                <span class="agentx-mini-name">${escapeHtml(agent.displayName)}</span>
            </span>
        `;
    };

    /**
     * Render a card for the chat panel summary
     */
    const renderSummary = (agent) => {
        if (!agent) {
            return `
                <div class="agentx-summary-empty">
                    <i class="fas fa-user-astronaut"></i>
                    <span>No agent selected</span>
                </div>
            `;
        }

        const catConfig = CATEGORY_CONFIG[agent.category] || CATEGORY_CONFIG.general;
        const toolCount = agent.n8nToolCount || agent.n8nTools?.filter(t => t.isActive).length || 0;

        return `
            <div class="agentx-summary-card" data-agent-id="${agent._id}">
                <div class="agentx-summary-header">
                    <div class="agentx-summary-avatar" style="--avatar-color: ${catConfig.color}">
                        <i class="fas ${agent.avatar || catConfig.icon}"></i>
                    </div>
                    <div class="agentx-summary-info">
                        <h4>${escapeHtml(agent.displayName)}</h4>
                        <span class="agentx-summary-category" style="color: ${catConfig.color}">
                            ${catConfig.label}
                        </span>
                    </div>
                </div>
                ${agent.description ? `
                    <p class="agentx-summary-desc">${escapeHtml(agent.description)}</p>
                ` : ''}
                <div class="agentx-summary-meta">
                    <span><i class="fas fa-microchip"></i> ${escapeHtml(formatModelName(agent.defaultModel))}</span>
                    ${toolCount > 0 ? `<span><i class="fas fa-bolt"></i> ${toolCount} tool${toolCount > 1 ? 's' : ''}</span>` : ''}
                </div>
            </div>
        `;
    };

    /**
     * Get category configuration
     */
    const getCategory = (category) => {
        return CATEGORY_CONFIG[category] || CATEGORY_CONFIG.general;
    };

    /**
     * Get all categories
     */
    const getAllCategories = () => {
        return Object.keys(CATEGORY_CONFIG);
    };

    // Public API
    return {
        render,
        renderMini,
        renderSummary,
        getCategory,
        getAllCategories,
        CATEGORY_CONFIG
    };
})();

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AgentXCard;
} else if (typeof window !== 'undefined') {
    window.AgentXCard = AgentXCard;
}
