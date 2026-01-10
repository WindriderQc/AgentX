/**
 * Feature Inventory Dashboard - Tab 1 Logic
 */

// Mock Data
const MOCK_DATA = [
    {
        name: "Cost Tracking",
        category: "analytics",
        status: "partial",
        frontend: { exists: true, pages: ["analytics.html"], lines: [103, 202] },
        backend: { exists: true, services: ["costCalculator.js"], endpoints: ["/api/analytics/costs"] },
        documentation: { exists: true, files: ["COST_TRACKING.md"], completeness: 90 },
        roadmap: { status: "in-progress", priority: "high" }
    },
    {
        name: "Voice Input",
        category: "experimental",
        status: "missing",
        frontend: { exists: false, pages: [], lines: [] },
        backend: { exists: true, services: ["voice_service.py"], endpoints: ["/api/voice/transcribe"] },
        documentation: { exists: false, files: [], completeness: 0 },
        roadmap: { status: "planned", priority: "low" }
    },
    {
        name: "RAG System",
        category: "core",
        status: "complete",
        frontend: { exists: true, pages: ["search.html"], lines: [45, 88] },
        backend: { exists: true, services: ["rag_engine.py", "vector_db.js"], endpoints: ["/api/search/rag"] },
        documentation: { exists: true, files: ["RAG_ARCH.md"], completeness: 100 },
        roadmap: { status: "released", priority: "critical" }
    },
    {
        name: "User Authentication",
        category: "core",
        status: "complete",
        frontend: { exists: true, pages: ["login.html", "signup.html"], lines: [12, 150] },
        backend: { exists: true, services: ["auth_service.js"], endpoints: ["/api/auth/login"] },
        documentation: { exists: true, files: ["AUTH_SPEC.md"], completeness: 100 },
        roadmap: { status: "released", priority: "critical" }
    },
    {
        name: "Advanced Filtering",
        category: "operations",
        status: "planned",
        frontend: { exists: false, pages: [], lines: [] },
        backend: { exists: false, services: [], endpoints: [] },
        documentation: { exists: false, files: [], completeness: 0 },
        roadmap: { status: "planned", priority: "medium" }
    },
    {
        name: "Data Visualization",
        category: "analytics",
        status: "partial",
        frontend: { exists: true, pages: ["dashboard.html"], lines: [300, 350] },
        backend: { exists: false, services: [], endpoints: [] },
        documentation: { exists: true, files: ["VIZ_GUIDE.md"], completeness: 50 },
        roadmap: { status: "in-progress", priority: "medium" }
    }
];

class FeatureInventory {
    constructor() {
        this.features = [];
        this.sortField = 'name';
        this.sortDirection = 'asc';
        this.init();
    }

    init() {
        // Initial load
        this.loadInventory();
    }

    async loadInventory() {
        console.log("Loading inventory...");
        // Simulate API call
        // const response = await fetch('/api/features/inventory');
        // const data = await response.json();
        
        // Using mock data for now
        setTimeout(() => {
            this.features = [...MOCK_DATA];
            this.renderTable(this.features);
            this.updateStats(this.features);
        }, 500); 
    }

    async scanCodebase() {
        const overlay = document.getElementById('loadingOverlay');
        overlay.style.display = 'flex';

        // Simulate API scanning delay
        // await fetch('/api/features/inventory/scan', { method: 'POST' });
        
        setTimeout(() => {
            overlay.style.display = 'none';
            // In a real app, we'd reload the data here using loadInventory()
            // For demo, we just refresh what we have or maybe add a dummy item
            this.loadInventory();
            alert("Scan complete! Inventory updated.");
        }, 2000);
    }

    renderTable(data) {
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
            
            row.innerHTML = `
                <td>
                    <div style="font-weight: 500;">${feature.name}</div>
                    <div style="font-size: 12px; color: #64748b;">${feature.category}</div>
                </td>
                <td>${this.renderStatusIcon(feature.frontend.exists)}</td>
                <td>${this.renderStatusIcon(feature.backend.exists)}</td>
                <td>${this.renderStatusIcon(feature.documentation.exists)}</td>
                <td>${this.renderRoadmapBadge(feature.roadmap.status)}</td>
                <td>${this.renderOverallStatus(feature.status)}</td>
                <td>
                    <a href="#" class="action-link" onclick="window.inventoryApp.toggleDetails(event, ${index})">View Details</a>
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
                    </div>
                </td>
            `;
            tbody.appendChild(detailsRow);
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
            content = data.exists ? `
                <ul class="detail-list">
                    <li><strong>Pages:</strong> ${data.pages.map(p => `<span class="file-path">${p}</span>`).join(', ')}</li>
                    <li><strong>Lines:</strong> ${data.lines.join(', ')}</li>
                </ul>` : '<span class="status-missing">No frontend files found.</span>';
        } else if (title === 'Backend') {
             content = data.exists ? `
                <ul class="detail-list">
                    <li><strong>Services:</strong> ${data.services.map(p => `<span class="file-path">${p}</span>`).join(', ')}</li>
                    <li><strong>Endpoints:</strong> ${data.endpoints.map(p => `<span class="file-path">${p}</span>`).join(', ')}</li>
                </ul>` : '<span class="status-missing">No backend services found.</span>';
        } else if (title === 'Documentation') {
            content = data.exists ? `
                <ul class="detail-list">
                    <li><strong>Files:</strong> ${data.files.map(p => `<span class="file-path">${p}</span>`).join(', ')}</li>
                    <li><strong>Completeness:</strong> ${data.completeness}%</li>
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

        const filtered = this.features.filter(f => {
            const matchesSearch = f.name.toLowerCase().includes(searchInput);
            const matchesCategory = categoryFilter === 'all' || f.category === categoryFilter;
            return matchesSearch && matchesCategory;
        });

        // Apply sort
        this.sortData(filtered);
        this.renderTable(filtered);
        this.updateStats(filtered);
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
            planned: 0
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
