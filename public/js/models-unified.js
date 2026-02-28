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
        this.sources = null;

        // Sorting state
        this.currentSort = { column: null, direction: null };

        // Modules
        this.manager = null;
        this.comparator = null;

        // UI Elements
        this.tableBodyEl = document.getElementById('modelsTableBody');
        this.loadingEl = document.getElementById('loadingIndicator');
        this.gridEl = document.getElementById('modelsGrid'); // Legacy ref

        this.compareDrawer = document.getElementById('compareDrawer');
        this.compareListEl = document.getElementById('compareList');

        // VRAM metrics cache (populated best-effort)
        this._vramCache = null;
        this._vramCacheTs = 0;

        this.init();
    }

    async init() {
        // Initialize sub-modules
        if (window.ModelManager) this.manager = new ModelManager(this);
        if (window.ModelComparator) this.comparator = new ModelComparator(this);

        this.setupFilters();
        this.setupVramPopup();
        this.setupProvidersPopup();
        await this.fetchModels();
    }

    setupVramPopup() {
        const card = document.getElementById('statVramCard');
        if (!card) return;

        card.addEventListener('click', async () => {
            try {
                this.openVramModal('Loading...');
                const data = await this.fetchVramMetrics({ force: true });
                this.renderVramModal(data);
            } catch (err) {
                this.renderVramModalError(err);
            }
        });

        const modal = document.getElementById('vramDetailsModal');
        const closeBtn = document.getElementById('closeVramDetailsModal');
        if (closeBtn) closeBtn.addEventListener('click', () => this.closeVramModal());
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) this.closeVramModal();
            });
        }
    }

    setupProvidersPopup() {
        const card = document.getElementById('statProvidersCard');
        if (!card) return;

        card.addEventListener('click', async () => {
            try {
                this.openProvidersModal('Loading...');
                // Ensure we have freshest sources/models (but don't force a refetch if already loaded)
                if (!this.allModels?.length) await this.fetchModels();
                this.renderProvidersModal();
            } catch (err) {
                this.renderProvidersModalError(err);
            }
        });

        const modal = document.getElementById('providersDetailsModal');
        const closeBtn = document.getElementById('closeProvidersDetailsModal');
        if (closeBtn) closeBtn.addEventListener('click', () => this.closeProvidersModal());
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) this.closeProvidersModal();
            });
        }
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
            this.sources = payload.sources || null;
            
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

        // Table header sorting
        document.querySelectorAll('.models-table th.sortable').forEach(th => {
            th.addEventListener('click', () => {
                const column = th.dataset.sort;
                this.sortByColumn(column);
            });
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

    sortByColumn(column) {
        // Toggle direction: null -> asc -> desc -> null
        if (this.currentSort.column === column) {
            if (this.currentSort.direction === 'asc') {
                this.currentSort.direction = 'desc';
            } else if (this.currentSort.direction === 'desc') {
                this.currentSort.column = null;
                this.currentSort.direction = null;
            }
        } else {
            this.currentSort.column = column;
            this.currentSort.direction = 'asc';
        }

        // Apply sort
        if (this.currentSort.column) {
            this.filteredModels.sort((a, b) => {
                let aVal, bVal;

                switch (column) {
                    case 'name':
                        aVal = a.name?.toLowerCase() || '';
                        bVal = b.name?.toLowerCase() || '';
                        return this.currentSort.direction === 'asc'
                            ? aVal.localeCompare(bVal)
                            : bVal.localeCompare(aVal);

                    case 'provider':
                        aVal = a.provider?.toLowerCase() || '';
                        bVal = b.provider?.toLowerCase() || '';
                        return this.currentSort.direction === 'asc'
                            ? aVal.localeCompare(bVal)
                            : bVal.localeCompare(aVal);

                    case 'params':
                        aVal = parseFloat(a.details?.parameter_size || a.parameters || '0');
                        bVal = parseFloat(b.details?.parameter_size || b.parameters || '0');
                        return this.currentSort.direction === 'asc' ? aVal - bVal : bVal - aVal;

                    case 'quant':
                        aVal = a.details?.quantization_level || a.quantization || '';
                        bVal = b.details?.quantization_level || b.quantization || '';
                        return this.currentSort.direction === 'asc'
                            ? aVal.localeCompare(bVal)
                            : bVal.localeCompare(aVal);

                    case 'size':
                        aVal = a.size || a.source?.metadata?.size || 0;
                        bVal = b.size || b.source?.metadata?.size || 0;
                        return this.currentSort.direction === 'asc' ? aVal - bVal : bVal - aVal;

                    case 'context':
                        aVal = a.capabilities?.maxContext || a.details?.context_length || 0;
                        bVal = b.capabilities?.maxContext || b.details?.context_length || 0;
                        return this.currentSort.direction === 'asc' ? aVal - bVal : bVal - aVal;

                    default:
                        return 0;
                }
            });
        }

        this.updateSortIndicators();
        this.renderTable();
    }

    updateSortIndicators() {
        // Clear all sort indicators
        document.querySelectorAll('.models-table th.sortable').forEach(th => {
            th.classList.remove('sort-asc', 'sort-desc');
        });

        // Set active sort indicator
        if (this.currentSort.column) {
            const activeTh = document.querySelector(`.models-table th[data-sort="${this.currentSort.column}"]`);
            if (activeTh) {
                activeTh.classList.add(`sort-${this.currentSort.direction}`);
            }
        }
    }

    updateStats() {
        document.getElementById('statTotal').innerText = this.allModels.length;
        const size = this.allModels.reduce((acc, m) => acc + (m.size || 0), 0);
        document.getElementById('statStorage').innerText = (size / 1024 / 1024 / 1024).toFixed(1) + ' GB';

        // Providers (show TOTAL sources/endpoints, not provider-types)
        // - Ollama: host count
        // - n8n: webhook/source count
        // - Custom: custom model count (acts as "custom sources")
        const s = this.sources || {};

        const inferredOllamaHosts = new Set(
            (this.allModels || [])
                .filter(m => m?.provider === 'ollama')
                .map(m => m?.source?.url)
                .filter(Boolean)
        );

        const ollamaHostCount = (
            Array.isArray(s?.ollama?.hosts) && s.ollama.hosts.length
                ? s.ollama.hosts.length
                : inferredOllamaHosts.size
        );

        const n8nSourceCount = Array.isArray(s?.n8n?.webhooks)
            ? s.n8n.webhooks.length
            : (this.allModels || []).filter(m => m?.provider === 'n8n-webhook').length;

        const customCount = Number(s?.custom?.count || 0)
            || (this.allModels || []).filter(m => m?.provider === 'custom').length;

        const totalSources = (ollamaHostCount || 0) + (n8nSourceCount || 0) + (customCount || 0);

        const providersEl = document.getElementById('statProviders');
        const providersSubEl = document.getElementById('statProvidersSub');
        if (providersEl) providersEl.innerText = String(totalSources);
        if (providersSubEl) providersSubEl.innerText = `Ollama: ${ollamaHostCount || 0}, n8n: ${n8nSourceCount || 0}, Custom: ${customCount || 0}`;

        // Real VRAM (best-effort). Falls back to '—' if not available.
        const vramEl = document.getElementById('statVram') || document.getElementById('statRam');
        if (vramEl) vramEl.innerText = '—';
        this.updateVramStat().catch(() => {
            const el = document.getElementById('statVram') || document.getElementById('statRam');
            if (el) el.innerText = '—';
        });
    }

    async updateVramStat() {
        const data = await this.fetchVramMetrics({ force: false });
        const hosts = Array.isArray(data?.hosts) ? data.hosts : [];
        const usedMiB = hosts.reduce((sum, h) => sum + (h?.memoryUsedMiBTotal || 0), 0);
        const usedGiB = usedMiB / 1024;

        const el = document.getElementById('statVram') || document.getElementById('statRam');
        if (el) el.innerText = Number.isFinite(usedGiB) ? `${usedGiB.toFixed(1)} GB` : '—';
    }

    async fetchVramMetrics({ force }) {
        const cacheMs = 5000;
        const now = Date.now();
        if (!force && this._vramCache && (now - this._vramCacheTs) < cacheMs) {
            return this._vramCache;
        }

        const headers = {};
        if (window.WorkspaceManager && typeof window.WorkspaceManager.addWorkspaceHeader === 'function') {
            Object.assign(headers, window.WorkspaceManager.addWorkspaceHeader({}));
        }

        const res = await fetch('/api/ollama-vram', { credentials: 'include', headers });
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status}`);
            err.status = res.status;
            throw err;
        }

        const json = await res.json();
        const data = json?.data || json;
        this._vramCache = data;
        this._vramCacheTs = now;
        return data;
    }

    openVramModal(loadingText) {
        const modal = document.getElementById('vramDetailsModal');
        const body = document.getElementById('vramDetailsBody');
        if (body) body.innerHTML = `<div style="color: var(--muted);">${this.escapeHtml(loadingText || 'Loading...')}</div>`;
        if (modal) modal.classList.add('active');
    }

    closeVramModal() {
        const modal = document.getElementById('vramDetailsModal');
        if (modal) modal.classList.remove('active');
    }

    renderVramModal(data) {
        const body = document.getElementById('vramDetailsBody');
        if (!body) return;

        const hosts = Array.isArray(data?.hosts) ? data.hosts : [];
        if (!hosts.length) {
            body.innerHTML = '<div style="color: var(--muted);">No hosts configured.</div>';
            return;
        }

        const fmtGiB = (mib) => {
            const gib = (Number(mib) || 0) / 1024;
            return `${gib.toFixed(1)} GB`;
        };

        const fmtTs = (iso) => {
            if (!iso) return '—';
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return String(iso);
            return d.toLocaleString();
        };

        const rows = hosts.map(h => {
            const hostName = this.escapeHtml(h?.name || h?.id || 'Host');
            const hostUrl = this.escapeHtml(h?.url || '');
            const sshHost = this.escapeHtml(h?.sshHost || '');
            const ok = !!h?.ok;
            const source = h?._source || 'none';
            const actionRequired = !!h?.actionRequired;

            const used = ok ? fmtGiB(h?.memoryUsedMiBTotal || 0) : '—';
            const total = ok ? fmtGiB(h?.memoryTotalMiBTotal || 0) : '—';
            const collectedAt = this.escapeHtml(fmtTs(h?.collectedAt));

            // Source badge
            let sourceBadge = '';
            if (ok && source === 'ssh-nvidia-smi') {
                sourceBadge = `<span style="display:inline-flex; align-items:center; gap:4px; font-size:0.8rem; color:#22c55e;"><i class="fas fa-check-circle"></i> Live detection via SSH</span>`;
            } else if (ok && (source === 'db-override' || source === 'static-config')) {
                const label = source === 'db-override' ? 'Manual override' : 'Env config';
                sourceBadge = `<span style="display:inline-flex; align-items:center; gap:4px; font-size:0.8rem; color:#60a5fa;"><i class="fas fa-pen"></i> VRAM: ${label} (${fmtGiB(h?.memoryTotalMiBTotal || 0)})</span>`;
            }

            // Warning banner for failed detection with no override
            let warningBanner = '';
            if (!ok && actionRequired) {
                warningBanner = `
                    <div style="background:rgba(245,158,11,0.12); border:1px solid rgba(245,158,11,0.4); border-radius:6px; padding:0.6rem 0.75rem; margin-top:0.5rem;">
                        <div style="color:#fbbf24; font-size:0.85rem; font-weight:600; margin-bottom:0.35rem;">
                            <i class="fas fa-exclamation-triangle"></i> VRAM detection failed
                        </div>
                        <div style="color:#d4d4d8; font-size:0.8rem; margin-bottom:0.5rem;">
                            Models on this host use conservative context defaults. Set VRAM manually to optimize performance.
                        </div>
                        <div style="display:flex; align-items:center; gap:0.5rem;">
                            <input type="number" class="vram-override-input" data-host="${sshHost}" placeholder="e.g. 14336" min="1024" step="1024"
                                style="width:120px; padding:4px 8px; border-radius:4px; border:1px solid rgba(255,255,255,0.2); background:rgba(0,0,0,0.3); color:#fff; font-size:0.85rem;" />
                            <span style="color:var(--muted); font-size:0.8rem;">MiB</span>
                            <button class="btn-primary-sm vram-override-save" data-host="${sshHost}" style="font-size:0.8rem; padding:4px 10px;">Save</button>
                        </div>
                        <div style="color:var(--muted); font-size:0.75rem; margin-top:0.3rem;">
                            Enter effective VRAM in MiB (total GPU minus ~2GB for Windows desktop)
                        </div>
                    </div>`;
            }

            // Edit/clear controls for existing overrides
            let overrideControls = '';
            if (ok && source === 'db-override') {
                overrideControls = `
                    <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.5rem;">
                        <input type="number" class="vram-override-input" data-host="${sshHost}" value="${h?.memoryTotalMiBTotal || ''}" min="1024" step="1024"
                            style="width:120px; padding:4px 8px; border-radius:4px; border:1px solid rgba(255,255,255,0.2); background:rgba(0,0,0,0.3); color:#fff; font-size:0.85rem;" />
                        <span style="color:var(--muted); font-size:0.8rem;">MiB</span>
                        <button class="btn-primary-sm vram-override-save" data-host="${sshHost}" style="font-size:0.8rem; padding:4px 10px;">Update</button>
                        <button class="btn-icon vram-override-clear" data-host="${sshHost}" title="Clear override" style="font-size:0.8rem; color:#ef4444;">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>`;
            }

            const rawErr = String(h?.error || '').trim();
            const displayErr = rawErr.includes('OLLAMA_SSH_DISABLED_HOSTS')
                ? 'VRAM telemetry unavailable for this host (Windows/disabled)'
                : (rawErr || 'Unavailable');
            const err = !ok ? this.escapeHtml(displayErr) : '';

            const status = ok ? '✓' : '✗';
            const statusStyle = ok ? 'color:#22c55e;' : 'color:#ef4444;';

            const gpus = Array.isArray(h?.gpus) ? h.gpus : [];
            const gpuLines = gpus.length
                ? gpus.map(g => {
                    const idx = this.escapeHtml(g?.index);
                    const nm = this.escapeHtml(g?.name || 'GPU');
                    const gu = fmtGiB(g?.memoryUsedMiB || 0);
                    const gt = fmtGiB(g?.memoryTotalMiB || 0);
                    return `<div style="display:flex; justify-content: space-between; gap: 1rem;"><span style="font-family: 'Courier New', monospace;">GPU ${idx}</span><span>${nm}</span><span>${gu} / ${gt}</span></div>`;
                }).join('')
                : `<div style="color: var(--muted); font-size: 0.9rem;">No GPU data</div>`;

            return `
                <div class="glass-panel" style="padding: 1rem; margin-bottom: 0.75rem;">
                    <div style="display:flex; justify-content: space-between; align-items: baseline; gap: 1rem;">
                        <div>
                            <div style="font-weight: 700;">${hostName}</div>
                            <div style="color: var(--muted); font-size: 0.85rem;">${hostUrl}</div>
                            ${sourceBadge ? `<div style="margin-top: 0.25rem;">${sourceBadge}</div>` : ''}
                            <div style="color: var(--muted); font-size: 0.8rem; margin-top: 0.25rem;">Collected: ${collectedAt}</div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-weight: 700; ${statusStyle}">${status}</div>
                            <div style="font-weight: 700;">${used} / ${total}</div>
                            ${err ? `<div style="color:#fca5a5; font-size: 0.85rem;">${err}</div>` : ''}
                        </div>
                    </div>
                    <div style="margin-top: 0.75rem; display:flex; flex-direction: column; gap: 0.35rem;">
                        ${gpuLines}
                    </div>
                    ${warningBanner}
                    ${overrideControls}
                </div>
            `;
        }).join('');

        body.innerHTML = rows;

        // Wire up VRAM override save buttons
        body.querySelectorAll('.vram-override-save').forEach(btn => {
            btn.addEventListener('click', async () => {
                const hostIp = btn.dataset.host;
                const input = body.querySelector(`.vram-override-input[data-host="${hostIp}"]`);
                const vramMiB = parseInt(input?.value, 10);
                if (!vramMiB || vramMiB <= 0) { alert('Enter a valid VRAM value in MiB'); return; }

                btn.disabled = true;
                btn.textContent = 'Saving...';
                try {
                    const resp = await fetch('/api/ollama-vram/override', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ hostIp, vramMiB })
                    });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    // Refresh modal
                    const freshData = await this.fetchVramMetrics({ force: true });
                    this.renderVramModal(freshData);
                } catch (err) {
                    alert(`Failed to save override: ${err.message}`);
                    btn.disabled = false;
                    btn.textContent = 'Save';
                }
            });
        });

        // Wire up VRAM override clear buttons
        body.querySelectorAll('.vram-override-clear').forEach(btn => {
            btn.addEventListener('click', async () => {
                const hostIp = btn.dataset.host;
                if (!confirm(`Clear VRAM override for ${hostIp}?`)) return;

                try {
                    const resp = await fetch(`/api/ollama-vram/override/${encodeURIComponent(hostIp)}`, {
                        method: 'DELETE',
                        credentials: 'include'
                    });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const freshData = await this.fetchVramMetrics({ force: true });
                    this.renderVramModal(freshData);
                } catch (err) {
                    alert(`Failed to clear override: ${err.message}`);
                }
            });
        });
    }

    renderVramModalError(err) {
        const body = document.getElementById('vramDetailsBody');
        if (!body) return;
        const status = err?.status;
        if (status === 401) {
            body.innerHTML = '<div style="color:#fca5a5;">Authentication required. Please log in and try again.</div>';
            return;
        }
        body.innerHTML = `<div style="color:#fca5a5;">Failed to load VRAM metrics: ${this.escapeHtml(err?.message || 'Unknown error')}</div>`;
    }

    openProvidersModal(loadingText) {
        const modal = document.getElementById('providersDetailsModal');
        const body = document.getElementById('providersDetailsBody');
        if (body) body.innerHTML = `<div style="color: var(--muted);">${this.escapeHtml(loadingText || 'Loading...')}</div>`;
        if (modal) modal.classList.add('active');
    }

    closeProvidersModal() {
        const modal = document.getElementById('providersDetailsModal');
        if (modal) modal.classList.remove('active');
    }

    renderProvidersModal() {
        const body = document.getElementById('providersDetailsBody');
        if (!body) return;

        const sources = this.sources || {};
        const ollamaHosts = Array.isArray(sources?.ollama?.hosts) ? sources.ollama.hosts : [];
        const n8nWebhooks = Array.isArray(sources?.n8n?.webhooks) ? sources.n8n.webhooks : [];

        const byHost = new Map();
        for (const model of (this.allModels || [])) {
            if (model?.provider !== 'ollama') continue;
            const url = model?.source?.url;
            if (!url) continue;
            byHost.set(url, (byHost.get(url) || 0) + 1);
        }

        const hostRows = (ollamaHosts.length ? ollamaHosts : Array.from(byHost.keys()))
            .map((url) => {
                const count = byHost.get(url) || 0;
                return `
                    <div class="glass-panel" style="padding: 1rem; margin-bottom: 0.75rem;">
                        <div style="display:flex; justify-content: space-between; gap: 1rem;">
                            <div>
                                <div style="font-weight: 700;">${this.escapeHtml(url)}</div>
                                <div style="color: var(--muted); font-size: 0.85rem;">Ollama host</div>
                            </div>
                            <div style="text-align:right;">
                                <div style="font-weight: 700;">${count}</div>
                                <div style="color: var(--muted); font-size: 0.85rem;">models</div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

        const ollamaHostCount = (ollamaHosts.length ? ollamaHosts.length : byHost.size) || 0;
        const n8nSourceCount = n8nWebhooks.length || (this.allModels || []).filter(m => m?.provider === 'n8n-webhook').length;
        const customCount = Number(sources?.custom?.count || 0) || (this.allModels || []).filter(m => m?.provider === 'custom').length;

        const n8nRows = n8nWebhooks.length
            ? n8nWebhooks.map(w => {
                const name = this.escapeHtml(w?.name || 'n8n webhook');
                const url = this.escapeHtml(w?.url || '');
                const provider = this.escapeHtml(w?.provider || 'n8n');
                return `
                    <div class="glass-panel" style="padding: 1rem; margin-bottom: 0.75rem;">
                        <div style="font-weight: 700;">${name}</div>
                        <div style="color: var(--muted); font-size: 0.85rem;">${provider}</div>
                        <div style="color: var(--muted); font-size: 0.85rem; margin-top: 0.25rem;">${url}</div>
                    </div>
                `;
            }).join('')
            : `<div style="color: var(--muted);">No n8n sources detected.</div>`;

        body.innerHTML = `
            <div style="margin-bottom: 1rem;">
                <div style="display:flex; gap: 0.75rem; flex-wrap: wrap;">
                    <span class="badge">Ollama: ${ollamaHostCount} host${ollamaHostCount === 1 ? '' : 's'}</span>
                    <span class="badge">n8n: ${n8nSourceCount} source${n8nSourceCount === 1 ? '' : 's'}</span>
                    <span class="badge">Custom: ${customCount} model${customCount === 1 ? '' : 's'}</span>
                </div>
            </div>

            <div style="margin-bottom: 1rem;">
                <div style="font-weight: 700; margin-bottom: 0.5rem;">Ollama Hosts (${ollamaHostCount})</div>
                ${hostRows || `<div style=\"color: var(--muted);\">No Ollama hosts detected.</div>`}
            </div>

            <div>
                <div style="font-weight: 700; margin-bottom: 0.5rem;">n8n Sources (${n8nSourceCount})</div>
                ${n8nRows}
            </div>
        `;
    }

    renderProvidersModalError(err) {
        const body = document.getElementById('providersDetailsBody');
        if (!body) return;
        body.innerHTML = `<div style="color:#fca5a5;">Failed to load providers: ${this.escapeHtml(err?.message || 'Unknown error')}</div>`;
    }

    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = String(value ?? '');
        return div.innerHTML;
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

            // Config Action
            tr.querySelector('.action-config')?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.modelExecutionConfig) window.modelExecutionConfig.open(model.name);
            });

            // Context cell click → open config
            tr.querySelector('.context-cell')?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (window.modelExecutionConfig) window.modelExecutionConfig.open(model.name);
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
        const rawContext = model.capabilities?.maxContext || model.details?.context_length || null;
        const context = rawContext ? (rawContext >= 1024 ? Math.round(rawContext / 1024) + 'k' : rawContext) : '—';

        // Determine host indicator for Ollama models
        let hostIndicator = '';
        if (isOllama && model.source?.url) {
            const hostUrl = model.source.url;
            // Use regex to extract host identifier (port number or hostname)
            const hostMatch = hostUrl.match(/:(\d+)/) || hostUrl.match(/\/\/([^:/]+)/);
            const hostIdentifier = hostMatch ? hostMatch[1] : 'unknown';

            // Show host indicator with abbreviated URL or port
            const hostLabel = hostIdentifier.length > 6 ? hostIdentifier.substring(0,6) : hostIdentifier;
            const hostColor = '#7cf0ff'; // Cyan for all Ollama hosts
            hostIndicator = `<span class="tag" style="font-size:10px; padding:2px 6px; background:rgba(255,255,255,0.05); border:1px solid ${hostColor}; color:${hostColor}; margin-left:6px;" title="${hostUrl}">${hostLabel}</span>`;
        }

        return `
             <td>
                <div class="model-name">
                    <div class="model-icon ${source} flex items-center justify-center bg-white/5 rounded text-accent">
                        ${this.getIconForSource(source)}
                    </div>
                    <div>
                        <div class="font-bold text-white text-[15px]">${model.name}${hostIndicator}</div>
                    </div>
                </div>
            </td>
             <td>
                <span class="tag uppercase">${source}</span>
            </td>
            <td>${params}</td>
            <td>${quant}</td>
            <td style="font-family:monospace; color:#e2e8f0;">${sizeStr}</td>
            <td class="context-cell" style="cursor:pointer;" data-model="${model.name}" title="Click to configure">${context}</td>
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
                        <button class="menu-item action-config"><i class="fas fa-sliders-h"></i> Config</button>
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
