/**
 * Unified Model Catalog Logic
 * Handles fetching, filtering, and rendering of models.
 * Integrates with ModelManager and ModelComparator.
 */

const API_ENDPOINT = '/api/models/all';

class UnifiedModels {
    constructor() {
        this.allModels = [];
        this.filteredModels = [];
        this.comparisonList = new Set();
        
        // Modules
        this.manager = null;
        this.comparator = null;

        // UI Elements
        this.gridEl = document.getElementById('modelsGrid');
        this.compareDrawer = document.getElementById('compareDrawer');
        this.compareListEl = document.getElementById('compareList');
        
        this.init();
    }

    async init() {
        // Initialize sub-modules
        if (window.ModelManager) this.manager = new ModelManager(this);
        if (window.ModelComparator) this.comparator = new ModelComparator(this);

        this.setupFilters();
        await this.fetchModels();
    }

    async fetchModels() {
        try {
            this.gridEl.innerHTML = '<div class="loading-spinner">Loading models...</div>';
            
            const fetchOptions = { credentials: 'include' };
            const endpoint = window.WorkspaceManager ? 
                WorkspaceManager.addWorkspaceParam(API_ENDPOINT) : API_ENDPOINT;

            const res = await fetch(endpoint, window.WorkspaceManager ? 
                WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions);
            
            if (!res.ok) throw new Error('Failed to fetch models');
            
            const data = await res.json();
            const payload = data.data || data;
            this.allModels = payload.models || [];
            
            this.filteredModels = [...this.allModels];
            this.updateStats();
            this.renderGrid();
        } catch (err) {
            console.error('Error:', err);
            this.gridEl.innerHTML = `<div class="error-msg">Failed to load models. ${err.message}</div>`;
        }
    }

    setupFilters() {
        // Debounce search
        let timeout;
        document.getElementById('searchInput')?.addEventListener('input', (e) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => this.filterModels(), 300);
        });

        ['providerSelect', 'categorySelect', 'sortSelect'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => this.filterModels());
        });

        document.getElementById('viewToggleBtn')?.addEventListener('click', () => {
             this.gridEl.classList.toggle('view-list');
        });

        document.getElementById('clearCompare')?.addEventListener('click', () => {
            this.comparisonList.clear();
            this.renderComparisonDrawer();
            this.renderGrid();
        });
    }

    filterModels() {
        const term = document.getElementById('searchInput').value.toLowerCase();
        const provider = document.getElementById('providerSelect').value;
        const category = document.getElementById('categorySelect').value;
        const sort = document.getElementById('sortSelect').value;

        this.filteredModels = this.allModels.filter(m => {
            const matchesSearch = m.name.toLowerCase().includes(term);
            const matchesProvider = provider === 'all' || (m.source?.type?.includes(provider) || m.provider === provider);
            // Simple category matching
            const matchesCategory = category === 'all' || 
                (category === 'code' && (m.name.includes('code') || m.name.includes('qwen'))) ||
                (category === 'embedding' && m.name.includes('embed'));
            
            return matchesSearch && matchesProvider && matchesCategory;
        });

        // Sort
        this.filteredModels.sort((a, b) => {
            if (sort === 'size') return (b.size || 0) - (a.size || 0);
            if (sort === 'newest') return new Date(b.modified_at || 0) - new Date(a.modified_at || 0);
            return a.name.localeCompare(b.name);
        });

        this.renderGrid();
    }

    updateStats() {
        document.getElementById('statTotal').innerText = this.allModels.length;
        const size = this.allModels.reduce((acc, m) => acc + (m.size || 0), 0);
        document.getElementById('statStorage').innerText = (size / 1024 / 1024 / 1024).toFixed(1) + ' GB';
        // Mock RAM
        document.getElementById('statRam').innerText = '4.2 GB';
    }

    renderGrid() {
        this.gridEl.innerHTML = '';
        if (this.filteredModels.length === 0) {
            this.gridEl.innerHTML = '<div class="empty-state">No models found</div>';
            return;
        }

        this.filteredModels.forEach(model => {
            const card = document.createElement('div');
            card.className = 'model-card';
            card.innerHTML = this.buildCardHTML(model);
            
            // Event Listeners
            card.querySelector('.btn-compare').addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleCompare(model);
            });

            // Action Menu
            const actionBtn = card.querySelector('.btn-actions');
            if (actionBtn) {
                actionBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Close others
                    document.querySelectorAll('.action-menu.active').forEach(el => el.classList.remove('active'));
                    const menu = card.querySelector('.action-menu');
                    menu.classList.toggle('active');
                });
            }

            // Delete Action
            card.querySelector('.action-delete')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.manager?.deleteModel(model);
            });

            // Start Action
            card.querySelector('.action-start')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.manager?.startModel(model);
            });

            // Test Action
            card.querySelector('.action-test')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.manager?.testModel(model);
            });

            this.gridEl.appendChild(card);
        });

        // Close menus on click outside
        document.addEventListener('click', () => {
             document.querySelectorAll('.action-menu.active').forEach(el => el.classList.remove('active'));
        });
    }

    buildCardHTML(model) {
        let source = model.provider || 'custom';
        const isOllama = source === 'ollama';
        const badgeColor = isOllama ? 'badge-orange' : (source === 'n8n' ? 'badge-pink' : 'badge-indigo');
        const isSelected = this.comparisonList.has(model.id || model.name);
        
        const size = model.size ? (model.size / 1e9).toFixed(1) + 'GB' : 'N/A';
        const params = model.details?.parameter_size || '?';

        return `
            <div class="card-header">
                <div class="model-icon ${source}">
                    ${this.getIconForSource(source)}
                </div>
                <div class="model-meta-top">
                    <span class="badge ${badgeColor}">${source}</span>
                    <button class="btn-icon btn-actions" title="Actions"><i class="fas fa-ellipsis-v"></i></button>
                    <!-- Action Menu Dropdown -->
                    <div class="action-menu">
                        <button class="menu-item action-start"><i class="fas fa-play"></i> Start</button>
                        <button class="menu-item action-test"><i class="fas fa-flask"></i> Test</button>
                        <div class="divider"></div>
                        <button class="menu-item action-delete text-red"><i class="fas fa-trash"></i> Delete</button>
                    </div>
                </div>
            </div>
             <div class="card-body">
                <div class="flex justify-between items-start">
                    <h3 class="model-name" title="${model.name}">${model.name}</h3>
                    <button class="btn-icon btn-compare ${isSelected ? 'active' : ''}" title="Compare">
                        <i class="fas ${isSelected ? 'fa-check' : 'fa-plus'}"></i>
                    </button>
                </div>
                <div class="tags-row">
                    <span class="tag">${params}</span>
                    <span class="tag">${model.details?.quantization_level || 'Q4_0'}</span>
                </div>
                 <div class="metrics-grid">
                    <div class="metric"><span class="label">Size</span><span class="value">${size}</span></div>
                    <div class="metric"><span class="label">Context</span><span class="value">${model.details?.context_length || '4k'}</span></div>
                </div>
                <div class="card-actions">
                    <button class="btn-primary-sm w-full" onclick="startChat('${model.name}')">
                        <i class="fas fa-comment-alt"></i> Chat
                    </button>
                </div>
            </div>
        `;
    }

    getIconForSource(source) {
        if (source === 'ollama') return '<i class="fas fa-laptop-code"></i>';
        if (source === 'n8n') return '<i class="fas fa-cloud-bolt"></i>';
        return '<i class="fas fa-cube"></i>';
    }

    toggleCompare(model) {
        const id = model.id || model.name;
        if (this.comparisonList.has(id)) {
            this.comparisonList.delete(id);
        } else {
            if (this.comparisonList.size >= 4) {
                alert('Max 4 models for comparison');
                return;
            }
            this.comparisonList.add(id);
        }
        this.renderComparisonDrawer();
        this.renderGrid();
    }

    renderComparisonDrawer() {
        const count = this.comparisonList.size;
        document.getElementById('compareCount').innerText = count;
        
        if (count > 0) {
            this.compareDrawer.classList.add('visible');
            const items = Array.from(this.comparisonList).map(id => {
               const m = this.allModels.find(x => (x.id||x.name) === id); 
               return `<div class="compare-chip">${m?.name || id} <i class="fas fa-times" onclick="window.unifiedModels.toggleCompare({id:'${id}', name:'${id}'})"></i></div>`;
            }).join('');
            this.compareListEl.innerHTML = items;
        } else {
            this.compareDrawer.classList.remove('visible');
        }
    }
}

function startChat(modelName) {
    window.location.href = `/chat?model=${encodeURIComponent(modelName)}`;
}

document.addEventListener('DOMContentLoaded', () => {
    window.unifiedModels = new UnifiedModels();
});
