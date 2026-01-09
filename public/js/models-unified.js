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
        this.tableBodyEl = document.getElementById('modelsTableBody');
        this.loadingEl = document.getElementById('loadingIndicator');
        this.gridEl = document.getElementById('modelsGrid'); // Legacy ref
        
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
            if (this.loadingEl) this.loadingEl.style.display = 'block';
            if (this.tableBodyEl) this.tableBodyEl.innerHTML = '';
            
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
            this.renderTable();
        } catch (err) {
            console.error('Error:', err);
            if (this.tableBodyEl) this.tableBodyEl.innerHTML = `<tr><td colspan="7" class="error-msg text-center p-4">Failed to load models. ${err.message}</td></tr>`;
        } finally {
            if (this.loadingEl) this.loadingEl.style.display = 'none';
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

        document.getElementById('clearCompare')?.addEventListener('click', () => {
            this.comparisonList.clear();
            this.renderComparisonDrawer();
            this.renderTable();
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

        this.renderTable();
    }

    updateStats() {
        document.getElementById('statTotal').innerText = this.allModels.length;
        const size = this.allModels.reduce((acc, m) => acc + (m.size || 0), 0);
        document.getElementById('statStorage').innerText = (size / 1024 / 1024 / 1024).toFixed(1) + ' GB';
        // Mock RAM
        document.getElementById('statRam').innerText = '4.2 GB';
    }

    renderTable() {
        if (!this.tableBodyEl) return;
        this.tableBodyEl.innerHTML = '';
        if (this.filteredModels.length === 0) {
            this.tableBodyEl.innerHTML = '<tr><td colspan="7" class="text-center p-4 text-slate-400">No models found</td></tr>';
            return;
        }

        this.filteredModels.forEach(model => {
            const tr = document.createElement('tr');
            tr.innerHTML = this.buildRowHTML(model);
            
            // Compare Action
            tr.querySelector('.action-compare')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleCompare(model);
            });
            
             // Action Menu Toggle
            const actionBtn = tr.querySelector('.btn-actions');
            if (actionBtn) {
                actionBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Close others
                    document.querySelectorAll('.action-menu.active').forEach(el => el.classList.remove('active'));
                    const menu = tr.querySelector('.action-menu');
                    menu.classList.toggle('active');
                });
            }

            // Delete Action
            tr.querySelector('.action-delete')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.manager?.deleteModel(model);
            });

            // Start Action
            tr.querySelector('.action-start')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.manager?.startModel(model);
            });

            // Test Action
            tr.querySelector('.action-test')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.manager?.testModel(model);
            });

            this.tableBodyEl.appendChild(tr);
        });

        // Close menus on click outside
        document.addEventListener('click', () => {
             document.querySelectorAll('.action-menu.active').forEach(el => el.classList.remove('active'));
        });
    }

    buildRowHTML(model) {
        let source = model.provider || 'custom';
        const isOllama = source === 'ollama';
        const isSelected = this.comparisonList.has(model.id || model.name);
        
        let sizeStr = '-';
        const sizeVal = model.size || model.source?.metadata?.size;
        if (sizeVal) {
             sizeStr = (sizeVal / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
        }
        
        const params = model.details?.parameter_size || model.parameters || '-';
        const quant = model.details?.quantization_level || model.quantization || '-';
        const context = model.capabilities?.maxContext || model.details?.context_length || '4k';

        return `
             <td>
                <div class="model-name">
                    <div class="model-icon ${source} flex items-center justify-center bg-white/5 rounded text-accent">
                        ${this.getIconForSource(source)}
                    </div>
                    <div>
                        <div class="font-bold text-white text-[15px]">${model.name}</div>
                    </div>
                </div>
            </td>
             <td>
                <span class="tag uppercase">${source}</span>
            </td>
            <td>${params}</td>
            <td>${quant}</td>
            <td style="font-family:monospace; color:#e2e8f0;">${sizeStr}</td>
            <td>${context}</td>
            <td class="text-right table-action-cell">
                <div class="actions">
                     <button class="btn-icon action-compare ${isSelected ? 'active text-accent' : ''}" title="Compare">
                        <i class="fas ${isSelected ? 'fa-check' : 'fa-plus'}"></i>
                    </button>
                    <button class="btn-primary-sm" onclick="startChat('${model.name}')" title="Chat">
                        <i class="fas fa-comment-alt"></i>
                    </button>
                    <button class="btn-icon btn-actions" title="More">
                        <i class="fas fa-ellipsis-v"></i>
                    </button>
                     <!-- Action Menu Dropdown -->
                    <div class="action-menu glass-panel">
                        <button class="menu-item action-start"><i class="fas fa-play"></i> Start</button>
                        <button class="menu-item action-test"><i class="fas fa-flask"></i> Test</button>
                        <div class="divider"></div>
                        <button class="menu-item action-delete text-red"><i class="fas fa-trash"></i> Delete</button>
                    </div>
                </div>
            </td>
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
        this.renderTable();
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
