/**
 * Feature Inventory Dashboard - Tab 1 Logic
 */

class FeatureInventory {
    constructor() {
        this.features = [];
        this.renderedFeatures = [];
        this.sortField = 'name';
        this.sortDirection = 'asc';
        this.quickFilter = null;
        this.init();
    }

    init() {
        // Initial load
        this.loadInventory();
        this.loadLatestReportSummary();
        this.syncQuickFilterButtons();
    }

    syncQuickFilterButtons() {
        const btns = document.querySelectorAll('[data-qf]');
        btns.forEach((b) => {
            const key = b.getAttribute('data-qf');
            if (!key) return;
            b.classList.toggle('is-active', this.quickFilter === key);
        });
    }

    applyQuickFilter(key) {
        this.quickFilter = (this.quickFilter === key) ? null : key;

        // For status-based quick filters, set the status dropdown.
        const statusFilter = document.getElementById('statusFilter');
        if (statusFilter) {
            if (this.quickFilter === 'orphaned') statusFilter.value = 'orphaned';
            else if (this.quickFilter === 'planned') statusFilter.value = 'planned';
            else if (this.quickFilter === null || this.quickFilter === 'missingDocs') statusFilter.value = 'all';
        }

        this.syncQuickFilterButtons();
        this.applyFilters();
    }

    clearQuickFilter() {
        this.quickFilter = null;
        const statusFilter = document.getElementById('statusFilter');
        if (statusFilter) statusFilter.value = 'all';
        this.syncQuickFilterButtons();
        this.applyFilters();
    }

    setScanStatus(message) {
        const el = document.getElementById('scanStatus');
        if (!el) return;
        el.textContent = message || '';
    }

    async loadLatestReportSummary() {
        const lastScanAt = document.getElementById('lastScanAt');
        const lastScanCounts = document.getElementById('lastScanCounts');
        if (!lastScanAt || !lastScanCounts) return;

        try {
            const resp = await fetch('/api/features/reports/latest');
            if (!resp.ok) {
                lastScanAt.textContent = 'No report yet';
                lastScanCounts.textContent = 'Run Scan Codebase';
                return;
            }
            const report = await resp.json();
            const generated = report?.summary?.generatedAt;
            const counts = report?.summary?.counts;

            lastScanAt.textContent = generated ? new Date(generated).toLocaleString() : '—';
            if (counts) {
                lastScanCounts.textContent = `${counts.features ?? '—'} features, ${counts.backendEndpoints ?? '—'} endpoints, ${counts.docsFiles ?? '—'} docs`;
            } else {
                lastScanCounts.textContent = '—';
            }
        } catch {
            lastScanAt.textContent = '—';
            lastScanCounts.textContent = '—';
        }
    }

    openLatestReport() {
        window.open('/api/features/reports/latest', '_blank', 'noopener,noreferrer');
    }

    async loadInventory() {
        console.log("Loading inventory from API...");
        try {
            const response = await fetch('/api/features/inventory');
            if (response.ok) {
                const json = await response.json();
                this.features = json.data || [];
                
                // If empty, suggest scanning
                if (this.features.length === 0) {
                    console.log("No features found in DB. You might need to scan first.");
                    document.getElementById('emptyState').style.display = 'flex';
                    document.getElementById('featuresTable').style.display = 'none';
                } else {
                    document.getElementById('emptyState').style.display = 'none';
                    document.getElementById('featuresTable').style.display = 'table';
                }

                this.renderTable(this.features);
                this.updateStats(this.features);
                this.loadLatestReportSummary();
            } else {
                console.error("Failed to load inventory:", response.status);
            }
        } catch (err) {
            console.error("Error loading inventory:", err);
            // Fallback to empty state
            this.features = [];
            this.renderTable(this.features);
        }
    }

    async scanCodebase() {
        const overlay = document.getElementById('loadingOverlay');
        overlay.style.display = 'flex';

        this.setScanStatus('Scanning codebase…');

        try {
            const response = await fetch('/api/features/inventory/scan', { 
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            if (response.ok) {
                console.log("Scan complete.");
                this.setScanStatus('Scan complete. Reloading inventory…');
                // Reload data to reflect changes
                await this.loadInventory();
                this.setScanStatus('Ready.');
            } else {
                console.error("Scan failed:", response.status);
                alert("Scan failed. Check server logs.");
                this.setScanStatus('Scan failed.');
            }
        } catch (err) {
            console.error("Error during scan:", err);
            alert("Error during scan: " + err.message);
            this.setScanStatus('Scan error.');
        } finally {
            overlay.style.display = 'none';
        }
    }

    renderTable(data) {
        this.renderedFeatures = data;
        const tbody = document.getElementById('tableBody');
        const emptyState = document.getElementById('emptyState');
        
        tbody.innerHTML = '';

        if (data.length === 0) {
            emptyState.style.display = 'block';
            return;
        } else {
            emptyState.style.display = 'none';
        }

        data.forEach((feature, index) => {
            const row = document.createElement('tr');
            row.id = `row-${index}`;

            const why = this.getWhyText(feature);
            
            row.innerHTML = `
                <td>
                    <div class="feature-name">${feature.name}</div>
                    <div class="feature-category">${feature.category}</div>
                    <div class="why-text">${why}</div>
                </td>
                <td>${this.renderStatusIcon(feature.frontend.exists)}</td>
                <td>${this.renderStatusIcon(feature.backend.exists)}</td>
                <td>${this.renderStatusIcon(feature.documentation.exists)}</td>
                <td>${this.renderRoadmapBadge(feature.roadmap.status)}</td>
                <td>${this.renderOverallStatus(feature.status)}</td>
                <td>
                    <a href="#" class="action-link" onclick="window.inventoryApp.toggleDetails(event, ${index})">View / Edit</a>
                </td>
            `;
            tbody.appendChild(row);

            // Details Row
            const detailsRow = document.createElement('tr');
            detailsRow.className = 'details-row';
            detailsRow.id = `details-${index}`;
            detailsRow.innerHTML = `
                <td colspan="7">
                    <div class="details-content">
                        <div class="details-grid">
                            ${this.renderDetailSection('Frontend', feature.frontend)}
                            ${this.renderDetailSection('Backend', feature.backend)}
                            ${this.renderDetailSection('Documentation', feature.documentation)}
                        </div>

                        <div class="update-panel">
                            <div class="update-title">Update feature metadata</div>
                            <div class="update-grid">
                                <div class="field">
                                    <label for="category-${index}">Category</label>
                                    <select id="category-${index}">
                                        <option value="core">Core</option>
                                        <option value="analytics">Analytics</option>
                                        <option value="operations">Operations</option>
                                        <option value="experimental">Experimental</option>
                                        <option value="deprecated">Deprecated</option>
                                    </select>
                                </div>

                                <div class="field">
                                    <label for="status-${index}">Status</label>
                                    <select id="status-${index}">
                                        <option value="complete">Complete</option>
                                        <option value="partial">Partial</option>
                                        <option value="planned">Planned</option>
                                        <option value="orphaned">Orphaned</option>
                                        <option value="deprecated">Deprecated</option>
                                    </select>
                                </div>

                                <div class="field">
                                    <label for="roadmapStatus-${index}">Roadmap</label>
                                    <select id="roadmapStatus-${index}">
                                        <option value="complete">Complete</option>
                                        <option value="in-progress">In Progress</option>
                                        <option value="planned">Planned</option>
                                        <option value="backlog">Backlog</option>
                                        <option value="not-tracked">Not Tracked</option>
                                    </select>
                                </div>

                                <div class="field">
                                    <label for="roadmapPriority-${index}">Priority</label>
                                    <select id="roadmapPriority-${index}">
                                        <option value="critical">Critical</option>
                                        <option value="high">High</option>
                                        <option value="medium">Medium</option>
                                        <option value="low">Low</option>
                                    </select>
                                </div>

                                <div class="field" style="grid-column: 1 / -1;">
                                    <label for="desc-${index}">Description</label>
                                    <input id="desc-${index}" type="text" placeholder="Short description (optional)" />
                                </div>

                                <div class="field" style="grid-column: 1 / -1;">
                                    <label for="tags-${index}">Tags</label>
                                    <input id="tags-${index}" type="text" placeholder="Comma-separated tags (optional)" />
                                </div>

                                <div class="update-actions" style="grid-column: 1 / -1;">
                                    <button class="btn btn-primary" onclick="window.inventoryApp.saveFeature(event, ${index})">Save</button>
                                    <button class="btn" onclick="window.inventoryApp.resetFeatureForm(event, ${index})">Reset</button>
                                </div>
                            </div>

                            <div class="hint" id="saveHint-${index}"></div>
                        </div>
                    </div>
                </td>
            `;
            tbody.appendChild(detailsRow);

            // set form defaults after insertion
            this.populateFeatureForm(index, feature);
        });
    }

    renderStatusIcon(exists) {
        return exists 
            ? '<span class="status-icon status-check" title="Exists">✅</span>' 
            : '<span class="status-icon status-missing" title="Missing">❌</span>';
    }

    renderRoadmapBadge(status) {
        let classColor = 'badge-planned';
        if (status === 'released') classColor = 'badge-complete';
        if (status === 'in-progress') classColor = 'badge-partial';
        
        // Capitalize info
        const label = status.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        
        return `<span class="badge ${classColor}">${label}</span>`;
    }

    renderOverallStatus(status) {
        let classColor = '';
        let icon = '';
        let label = '';

        switch(status) {
            case 'complete': 
                classColor = 'badge-complete'; 
                label = 'Complete';
                break;
            case 'partial': 
                classColor = 'badge-partial'; 
                label = 'Partial';
                break;
            case 'missing': 
                classColor = 'badge-missing'; 
                label = 'Missing';
                break;
            case 'planned': 
                classColor = 'badge-planned'; 
                label = 'Planned';
                break;
            default:
                classColor = 'badge-planned';
                label = status;
        }

        return `<span class="badge ${classColor}">${label}</span>`;
    }

    renderDetailSection(title, data) {
        let content = '';
        if (title === 'Frontend') {
            const pages = Array.isArray(data?.pages) ? data.pages : [];
            const lines = Array.isArray(data?.lines) ? data.lines : [];

            content = data.exists ? `
                <ul class="detail-list">
                    <li><strong>Pages:</strong> ${pages.length ? pages.map(p => `<span class="file-path">${p}</span>`).join(' ') : '<span class="status-missing">—</span>'}</li>
                    <li><strong>Lines:</strong> ${lines.length ? lines.join(', ') : '<span class="status-missing">—</span>'}</li>
                </ul>` : '<span class="status-missing">No frontend files found.</span>';
        } else if (title === 'Backend') {
             const services = Array.isArray(data?.services) ? data.services : [];
             const endpoints = Array.isArray(data?.endpoints) ? data.endpoints : [];

             content = data.exists ? `
                <ul class="detail-list">
                    <li><strong>Services:</strong> ${services.length ? services.map(p => `<span class="file-path">${p}</span>`).join(' ') : '<span class="status-missing">—</span>'}</li>
                    <li><strong>Endpoints:</strong> ${endpoints.length ? endpoints.map(p => `<span class="file-path">${p}</span>`).join(' ') : '<span class="status-missing">—</span>'}</li>
                </ul>` : '<span class="status-missing">No backend services found.</span>';
        } else if (title === 'Documentation') {
            const files = Array.isArray(data?.files) ? data.files : [];
            const completeness = Number.isFinite(data?.completeness) ? data.completeness : 0;
            content = data.exists ? `
                <ul class="detail-list">
                    <li><strong>Files:</strong> ${files.length ? files.map(p => `<span class="file-path">${p}</span>`).join(' ') : '<span class="status-missing">—</span>'}</li>
                    <li><strong>Completeness:</strong> ${completeness}%</li>
                </ul>` : '<span class="status-missing">No documentation found.</span>';
        }

        return `
            <div class="detail-section">
                <h4>${title}</h4>
                ${content}
            </div>
        `;
    }

    toggleDetails(event, index) {
        event.preventDefault();
        const detailsRow = document.getElementById(`details-${index}`);
        const mainRow = document.getElementById(`row-${index}`);
        
        if (detailsRow.classList.contains('visible')) {
            detailsRow.classList.remove('visible');
            mainRow.classList.remove('row-expanded');
        } else {
            detailsRow.classList.add('visible');
            mainRow.classList.add('row-expanded');
        }
    }

    applyFilters() {
        const searchInput = document.getElementById('searchInput').value.toLowerCase();
        const categoryFilter = document.getElementById('categoryFilter').value;
        const statusFilter = document.getElementById('statusFilter')?.value || 'all';
        const hasFrontend = !!document.getElementById('hasFrontend')?.checked;
        const hasBackend = !!document.getElementById('hasBackend')?.checked;
        const hasDocs = !!document.getElementById('hasDocs')?.checked;

        const filtered = this.features.filter(f => {
            const matchesSearch = f.name.toLowerCase().includes(searchInput);
            const matchesCategory = categoryFilter === 'all' || f.category === categoryFilter;
            const matchesStatus = statusFilter === 'all' || f.status === statusFilter;

            const matchesFrontend = !hasFrontend || !!f.frontend?.exists;
            const matchesBackend = !hasBackend || !!f.backend?.exists;
            const matchesDocs = !hasDocs || !!f.documentation?.exists;

            const matchesQuickFilter = this.quickFilter === 'missingDocs'
                ? !f.documentation?.exists
                : true;

            return matchesSearch && matchesCategory && matchesStatus && matchesFrontend && matchesBackend && matchesDocs && matchesQuickFilter;
        });

        // Apply sort
        this.sortData(filtered);
        this.renderTable(filtered);
        this.updateStats(filtered);
    }

    getWhyText(feature) {
        const missing = [];
        if (!feature.frontend?.exists) missing.push('UI');
        if (!feature.backend?.exists) missing.push('Backend');
        if (!feature.documentation?.exists) missing.push('Docs');

        if (missing.length === 0) return 'All signals present.';

        if (feature.status === 'orphaned' || (!feature.frontend?.exists && feature.backend?.exists && !feature.documentation?.exists)) {
            return 'Backend only (no UI, no docs).';
        }

        return `Missing: ${missing.join(', ')}.`;
    }

    sortBy(field) {
        if (this.sortField === field) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortField = field;
            this.sortDirection = 'asc';
        }
        
        // Update headers visual state
        document.querySelectorAll('th').forEach(th => {
            th.classList.remove('sorted-asc', 'sorted-desc');
        });
        const index = ['name', 'frontend', 'backend', 'documentation', 'roadmap', 'status'].indexOf(field);
        if (index > -1) {
             const th = document.querySelectorAll('th')[index];
             th.classList.add(this.sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
        }

        this.applyFilters();
    }

    sortData(data) {
        data.sort((a, b) => {
            let valA, valB;

            if (this.sortField === 'name' || this.sortField === 'status') {
                valA = a[this.sortField];
                valB = b[this.sortField];
            } else if (['frontend', 'backend', 'documentation'].includes(this.sortField)) {
                // Sort by existence boolean for these objects
                valA = a[this.sortField].exists;
                valB = b[this.sortField].exists;
            } else if (this.sortField === 'roadmap') {
                valA = a.roadmap.status;
                valB = b.roadmap.status;
            }

            if (valA < valB) return this.sortDirection === 'asc' ? -1 : 1;
            if (valA > valB) return this.sortDirection === 'asc' ? 1 : -1;
            return 0;
        });
    }

    updateStats(data) {
        const counts = {
            complete: 0,
            partial: 0,
            missing: 0,
            planned: 0,
            orphaned: 0,
            deprecated: 0
        };

        data.forEach(f => {
            if (counts[f.status] !== undefined) {
                counts[f.status]++;
            }
        });

        document.getElementById('statComplete').textContent = counts.complete;
        document.getElementById('statPartial').textContent = counts.partial;
        document.getElementById('statMissing').textContent = counts.missing;
        document.getElementById('statPlanned').textContent = counts.planned;
        const orphanedEl = document.getElementById('statOrphaned');
        if (orphanedEl) orphanedEl.textContent = counts.orphaned;
        const deprecatedEl = document.getElementById('statDeprecated');
        if (deprecatedEl) deprecatedEl.textContent = counts.deprecated;
    }

    populateFeatureForm(index, feature) {
        const category = document.getElementById(`category-${index}`);
        const status = document.getElementById(`status-${index}`);
        const roadmapStatus = document.getElementById(`roadmapStatus-${index}`);
        const roadmapPriority = document.getElementById(`roadmapPriority-${index}`);
        const desc = document.getElementById(`desc-${index}`);
        const tags = document.getElementById(`tags-${index}`);

        if (category) category.value = feature.category || 'experimental';
        if (status) status.value = feature.status || 'partial';
        if (roadmapStatus) roadmapStatus.value = feature.roadmap?.status || 'planned';
        if (roadmapPriority) roadmapPriority.value = feature.roadmap?.priority || 'medium';
        if (desc) desc.value = feature.metadata?.description || '';
        if (tags) tags.value = Array.isArray(feature.metadata?.tags) ? feature.metadata.tags.join(', ') : '';

        const hint = document.getElementById(`saveHint-${index}`);
        if (hint) hint.textContent = '';
    }

    resetFeatureForm(event, index) {
        event.preventDefault();
        event.stopPropagation();
        const feature = this.renderedFeatures[index];
        if (!feature) return;
        this.populateFeatureForm(index, feature);
    }

    async saveFeature(event, index) {
        event.preventDefault();
        event.stopPropagation();

        const feature = this.renderedFeatures[index];
        if (!feature) return;

        const hint = document.getElementById(`saveHint-${index}`);
        const setHint = (msg) => { if (hint) hint.textContent = msg; };

        const payload = {
            name: feature.name,
            category: document.getElementById(`category-${index}`)?.value,
            status: document.getElementById(`status-${index}`)?.value,
            roadmap: {
                status: document.getElementById(`roadmapStatus-${index}`)?.value,
                priority: document.getElementById(`roadmapPriority-${index}`)?.value,
                lastUpdated: new Date().toISOString()
            },
            metadata: {
                description: document.getElementById(`desc-${index}`)?.value || '',
                tags: String(document.getElementById(`tags-${index}`)?.value || '')
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean)
            }
        };

        setHint('Saving…');
        try {
            const resp = await fetch('/api/features/inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!resp.ok) {
                setHint(`Save failed (HTTP ${resp.status}). Are you logged in?`);
                return;
            }

            // Refresh inventory to reflect changes consistently
            await this.loadInventory();
            setHint('Saved.');
        } catch (err) {
            setHint(`Save error: ${err.message}`);
        }
    }

    exportReport() {
        if (this.features.length === 0) {
            alert("No data to export.");
            return;
        }

        const headers = ["Feature", "Category", "Frontend", "Backend", "Docs", "Status", "Roadmap"];
        const rows = this.features.map(f => [
            f.name,
            f.category,
            f.frontend.exists ? "Yes" : "No",
            f.backend.exists ? "Yes" : "No",
            f.documentation.exists ? "Yes" : "No",
            f.status,
            f.roadmap.status
        ]);

        let csvContent = "data:text/csv;charset=utf-8," 
            + headers.join(",") + "\n" 
            + rows.map(e => e.join(",")).join("\n");

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", "feature_inventory_report.csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
}

// Initialize and expose to window
window.inventoryApp = new FeatureInventory();
