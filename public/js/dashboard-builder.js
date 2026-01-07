/**
 * Dashboard Builder Module
 * 
 * Handles Creation, Layout, and Rendering of Custom Dashboards.
 * Uses Chart.js for visualizations.
 * 
 * Week 4 Day 4 - Advanced Analytics
 */

const DashboardManager = {
    dashboards: [],
    currentDashboard: null,
    isEditMode: false,
    charts: {}, // Store Chart.js instances by widgetId

    async init() {
        console.log('[Dashboard] Initializing...');
        await this.loadDashboards();
    },

    // ===================================
    // DATA LOADING
    // ===================================

    async loadDashboards() {
        try {
            const fetchOptions = { credentials: 'include' };
            const url = window.WorkspaceManager ? 
                WorkspaceManager.addWorkspaceParam('/api/dashboards') : '/api/dashboards';
            
            const res = await fetch(url, window.WorkspaceManager ? 
                WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions);
            
            const result = await res.json();
            
            if (result.status === 'success') {
                this.dashboards = result.data;
                this.renderSidebar();
                
                // Select first dashboard if available
                if (this.dashboards.length > 0) {
                    this.selectDashboard(this.dashboards[0]._id);
                } else {
                    this.renderEmptyState();
                }
            }
        } catch (error) {
            console.error('[Dashboard] Failed to load dashboards:', error);
        }
    },

    async loadDashboardData(id) {
        try {
            const fetchOptions = { 
                method: 'POST',
                credentials: 'include' 
            };
            const url = `/api/dashboards/${id}/refresh`;
            
            const res = await fetch(url, window.WorkspaceManager ? 
                WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions);
            
            const result = await res.json();
            if (result.status === 'success') {
                return result.data;
            }
        } catch (error) {
            console.error('[Dashboard] Failed to refresh data:', error);
        }
        return {};
    },

    // ===================================
    // UI RENDERING
    // ===================================

    renderSidebar() {
        const list = document.getElementById('dashboardList');
        if (this.dashboards.length === 0) {
            list.innerHTML = '<div style="padding:10px; color:var(--muted);">No dashboards found. Create one!</div>';
            return;
        }

        list.innerHTML = this.dashboards.map(d => `
            <div class="dashboard-list-item ${this.currentDashboard && this.currentDashboard._id === d._id ? 'active' : ''}" 
                 onclick="DashboardManager.selectDashboard('${d._id}')">
                <i class="fas fa-chart-line"></i> ${d.name}
                ${d.isPublic ? '<i class="fas fa-globe" title="Public" style="font-size:10px; margin-left:auto;"></i>' : ''}
            </div>
        `).join('');
    },

    renderEmptyState() {
        document.getElementById('dashboardTitle').textContent = 'No Dashboard Selected';
        document.getElementById('dashboardDesc').textContent = '';
        document.getElementById('dashboardControls').style.display = 'none';
        document.getElementById('widgetGrid').innerHTML = `
            <div style="grid-column: span 4; text-align:center; padding:40px; color:var(--muted);">
                <h2><i class="fas fa-columns"></i></h2>
                <p>Create a custom dashboard to visualize your workspace data.</p>
                <button class="btn btn-primary" onclick="DashboardManager.openCreateModal()" style="margin-top:16px;">
                    Create Dashboard
                </button>
            </div>
        `;
    },

    async selectDashboard(id) {
        const dashboard = this.dashboards.find(d => d._id === id);
        if (!dashboard) return;

        this.currentDashboard = dashboard;
        this.renderSidebar(); // Update active state
        this.isEditMode = false;

        document.getElementById('dashboardTitle').textContent = dashboard.name;
        document.getElementById('dashboardDesc').textContent = dashboard.description || '';
        document.getElementById('dashboardControls').style.display = 'flex';
        document.getElementById('btnEditMode').textContent = 'Edit Layout';
        
        // Show delete button only if creator
        // TODO: Access check logic (client-side simplified)
        document.getElementById('btnDelete').style.display = 'block';

        await this.renderGrid();
    },

    async renderGrid() {
        const grid = document.getElementById('widgetGrid');
        grid.innerHTML = '';
        
        // Load data fresh
        const data = await this.loadDashboardData(this.currentDashboard._id);

        this.charts = {}; // Reset charts

        this.currentDashboard.layout.forEach(widget => {
            const card = document.createElement('div');
            card.className = `widget-card widget-span-${widget.w}`;
            if (widget.h > 1) card.classList.add(`widget-span-row-${widget.h}`);

            const widgetData = data[widget.id] || {};
            const hasError = widgetData.error;

            let contentHtml = '';
            if (hasError) {
                contentHtml = `<div style="color:red; font-size:12px;">Error: ${widgetData.error}</div>`;
            } else if (widget.type === 'metric') {
                contentHtml = `<div class="metric-value">${widgetData.value !== undefined ? widgetData.value : '-'}</div>`;
            } else if (widget.type === 'chart') {
                contentHtml = `<canvas id="chart-${widget.id}"></canvas>`;
            } else if (widget.type === 'table') {
                // Table content handled specifically to keep logic clean
                // We'll inject a placeholder and let renderTableWidget fill it
                contentHtml = `<div class="table-widget-container" id="table-container-${widget.id}"></div>`;
            } else {
                contentHtml = '<div>Unknown Widget</div>';
            }

            card.innerHTML = `
                <div class="widget-header">
                    <div class="widget-title">${widget.title}</div>
                    <div class="widget-actions" ${this.isEditMode ? 'style="opacity:1"' : ''}>
                        ${widget.type === 'table' ? `<button class="btn-action" title="Export CSV" onclick="DashboardManager.exportTableCSV('${widget.id}')"><i class="fas fa-download"></i></button>` : ''}
                        <button class="btn-action" onclick="DashboardManager.editWidget('${widget.id}')"><i class="fas fa-cog"></i></button>
                        <button class="btn-action" onclick="DashboardManager.deleteWidget('${widget.id}')"><i class="fas fa-times"></i></button>
                    </div>
                </div>
                <div class="widget-content" style="${widget.type === 'table' ? 'overflow:hidden; padding:0;' : ''}">
                    ${contentHtml}
                </div>
            `;

            grid.appendChild(card);

            // Init Widget renderers
            if (!hasError) {
                if (widget.type === 'chart') {
                    this.initChart(widget, widgetData);
                } else if (widget.type === 'table') {
                    this.renderTableWidget(widget, document.getElementById(`table-container-${widget.id}`), widgetData);
                }
            }
        });

        // Add "Add Widget" placeholder if in edit mode
        if (this.isEditMode) {
            const addBtn = document.createElement('div');
            addBtn.className = 'add-widget-placeholder widget-span-1';
            addBtn.innerHTML = '<i class="fas fa-plus"></i> Add Widget';
            addBtn.onclick = () => this.openAddWidgetModal();
            grid.appendChild(addBtn);
        }
    },

    initChart(widget, data) {
        const ctx = document.getElementById(`chart-${widget.id}`);
        if (!ctx || !data.datasets) return;

        const chartType = widget.chartType || 'line';
        const colors = ['#7cf0ff', '#eeb0ff', '#ffe082', '#ff8a80', '#b9f6ca'];

        this.charts[widget.id] = new Chart(ctx, {
            type: chartType,
            data: {
                labels: data.labels || [],
                datasets: data.datasets.map((ds, i) => ({
                    ...ds,
                    backgroundColor: chartType === 'line' ? 'rgba(124, 240, 255, 0.1)' : colors,
                    borderColor: chartType === 'line' ? '#7cf0ff' : 'transparent',
                    borderWidth: 2,
                    tension: 0.4
                }))
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: chartType !== 'bar' }
                },
                scales: chartType !== 'pie' && chartType !== 'doughnut' ? {
                    y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.1)' } },
                    x: { grid: { display: false } }
                } : {}
            }
        });
    },

    // ===================================
    // TABLE WIDGET LOGIC
    // ===================================

    renderTableWidget(widget, container, data) {
        if (!data.rows || data.rows.length === 0) {
            container.innerHTML = '<div style="padding:20px; text-align:center; color:var(--muted);">No data available</div>';
            return;
        }

        const tableHtml = `
            <div class="table-container" style="max-height: 250px; overflow-y: auto;">
                <table class="data-table" id="table-${widget.id}" style="width:100%; border-collapse:collapse; font-size:13px;">
                    <thead style="position:sticky; top:0; background:var(--panel-bg); z-index:1;">
                        <tr>
                            ${data.columns.map(col => `
                                <th onclick="DashboardManager.sortTable('${widget.id}', '${col}')" 
                                    style="padding:8px; text-align:left; border-bottom:1px solid var(--panel-border); cursor:pointer;">
                                    ${col} <span class="sort-indicator" style="font-size:10px; margin-left:4px; opacity:0.5">⇅</span>
                                </th>
                            `).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${data.rows.map(row => `
                            <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                                ${row.map(cell => `<td style="padding:8px; color:var(--text);">${this.formatCell(cell)}</td>`).join('')}
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            <div class="table-footer" style="padding:8px; font-size:12px; color:var(--muted); border-top:1px solid var(--panel-border);">
                Total: ${data.total || data.rows.length} rows
            </div>
        `;

        container.innerHTML = tableHtml;
    },

    formatCell(value) {
        if (!value) return '';
        // Format timestamps
        if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}T/)) {
            return new Date(value).toLocaleDateString() + ' ' + new Date(value).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        }
        // Format numbers
        if (typeof value === 'number') {
            return value.toLocaleString();
        }
        return value;
    },

    sortTable(widgetId, columnName) {
        const table = document.getElementById(`table-${widgetId}`);
        if (!table) return;
        
        const tbody = table.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));

        // Get column index
        const headers = Array.from(table.querySelectorAll('th'));
        const columnIndex = headers.findIndex(th => th.textContent.includes(columnName));
        if (columnIndex === -1) return;

        // Toggle sort direction
        const currentDir = table.dataset.sortDir || 'asc';
        const newDir = currentDir === 'asc' ? 'desc' : 'asc';
        table.dataset.sortDir = newDir;

        // Sort rows
        rows.sort((a, b) => {
            const aVal = a.children[columnIndex].textContent;
            const bVal = b.children[columnIndex].textContent;

            // Try numeric comparison
            const aNum = parseFloat(aVal.replace(/,/g, ''));
            const bNum = parseFloat(bVal.replace(/,/g, ''));

            if (!isNaN(aNum) && !isNaN(bNum)) {
                return newDir === 'asc' ? aNum - bNum : bNum - aNum;
            }

            // String comparison
            return newDir === 'asc'
                ? aVal.localeCompare(bVal)
                : bVal.localeCompare(aVal);
        });

        // Re-append sorted rows
        rows.forEach(row => tbody.appendChild(row));

        // Update sort indicators
        headers.forEach(th => {
            const ind = th.querySelector('.sort-indicator');
            if (ind) ind.textContent = '⇅';
        });
        const activeHeader = headers[columnIndex].querySelector('.sort-indicator');
        if (activeHeader) activeHeader.textContent = newDir === 'asc' ? '↑' : '↓';
    },

    exportTableCSV(widgetId) {
        const table = document.getElementById(`table-${widgetId}`);
        if (!table) return;

        // Extract headers
        const headers = Array.from(table.querySelectorAll('th'))
            .map(th => th.textContent.replace('⇅', '').replace('↑', '').replace('↓', '').trim());

        // Extract rows
        const rows = Array.from(table.querySelectorAll('tbody tr'))
            .map(tr => Array.from(tr.querySelectorAll('td'))
                .map(td => `"${td.textContent.trim().replace(/"/g, '""')}"`)); // Escape quotes

        // Generate CSV
        const csv = [
            headers.join(','),
            ...rows.map(row => row.join(','))
        ].join('\n');

        // Download
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `table-export-${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    // ===================================
    // EDIT MODE & MODALS
    // ===================================

    toggleEditMode() {
        this.isEditMode = !this.isEditMode;
        document.getElementById('btnEditMode').innerHTML = this.isEditMode ? 
            '<i class="fas fa-check"></i> Done' : '<i class="fas fa-pencil-alt"></i> Edit Layout';
        
        if (!this.isEditMode) {
            this.saveDashboardLayout(); // Save on exit
        }
        
        this.renderGrid();
    },

    openCreateModal() {
        document.getElementById('modalCreateDashboard').classList.add('active');
    },

    openAddWidgetModal() {
        document.getElementById('modalAddWidget').classList.add('active');
        document.getElementById('widgetId').value = ''; // New widget
    },

    closeModals() {
        document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
    },

    updateWidgetForm() {
        const type = document.getElementById('widgetType').value;
        const chartOpts = document.getElementById('chartOptions');
        const aggOpts = document.getElementById('aggOptions');
        const tableOpts = document.getElementById('tableOptions');
        
        // Reset all
        chartOpts.style.display = 'none';
        aggOpts.style.display = 'none';
        if (tableOpts) tableOpts.style.display = 'none';

        if (type === 'chart') {
            chartOpts.style.display = 'block';
        } else if (type === 'table') {
            if (tableOpts) tableOpts.style.display = 'block';
        } else {
            // Metric
            aggOpts.style.display = 'block';
        }
    },

    // ===================================
    // ACTIONS
    // ===================================

    async createDashboard(e) {
        e.preventDefault();
        const name = document.getElementById('newDashName').value;
        const description = document.getElementById('newDashDesc').value;
        const isPublic = document.getElementById('newDashPublic').checked;

        try {
            const fetchOptions = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, description, isPublic, layout: [] })
            };

            const res = await fetch('/api/dashboards', window.WorkspaceManager ? 
                WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions);
            
            const result = await res.json();
            if (result.status === 'success') {
                this.closeModals();
                await this.loadDashboards();
                this.selectDashboard(result.data._id);
                this.toggleEditMode(); // Enter edit mode immediately
            }
        } catch (error) {
            console.error('Create failed', error);
        }
    },

    async saveWidget(e) {
        e.preventDefault();
        // Construct widget object
        const type = document.getElementById('widgetType').value;
        const title = document.getElementById('widgetTitle').value;
        const size = parseInt(document.getElementById('widgetSize').value);
        const collection = document.getElementById('widgetCollection').value;
        
        const widgetConfig = {
            id: 'w_' + Date.now(),
            title,
            type,
            w: size,
            h: type === 'chart' ? 2 : 1, // Charts taller by default
            x: 0, y: 0, // Auto-layout handled by grid
            dataSource: {
                collection,
                aggregation: document.getElementById('widgetAgg').value
            }
        };

        if (type === 'chart') {
            widgetConfig.chartType = document.querySelector('input[name="chartStyle"]:checked').value;
            widgetConfig.dataSource.groupBy = document.getElementById('widgetGroupBy').value;
        } else if (type === 'table') {
            const pipelineStr = document.getElementById('widgetPipeline').value;
            if (pipelineStr && pipelineStr.trim().length > 0) {
                try {
                    widgetConfig.dataSource.pipeline = JSON.parse(pipelineStr);
                } catch (err) {
                    alert('Invalid JSON in Aggregation Pipeline');
                    return;
                }
            }
            widgetConfig.h = size >= 4 ? 3 : 2; // Tables need vertical space
        }

        // Add to current dashboard layout
        this.currentDashboard.layout.push(widgetConfig);
        
        // Save to backend
        await this.saveDashboardLayout();
        
        this.closeModals();
        this.renderGrid();
    },

    async deleteWidget(widgetId) {
        if (!confirm('Remove this widget?')) return;
        this.currentDashboard.layout = this.currentDashboard.layout.filter(w => w.id !== widgetId);
        await this.saveDashboardLayout();
        this.renderGrid();
    },

    async saveDashboardLayout() {
        if (!this.currentDashboard) return;
        
        try {
             const fetchOptions = {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ layout: this.currentDashboard.layout })
            };

            await fetch(`/api/dashboards/${this.currentDashboard._id}`, window.WorkspaceManager ? 
                WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions);
            
        } catch (error) {
            console.error('Save failed', error);
        }
    },
    
    async deleteDashboard() {
        if (!confirm('Are you sure you want to delete this dashboard?')) return;
        
        try {
             const fetchOptions = { method: 'DELETE' };
            await fetch(`/api/dashboards/${this.currentDashboard._id}`, window.WorkspaceManager ? 
                WorkspaceManager.addWorkspaceHeader(fetchOptions) : fetchOptions);
            
            this.currentDashboard = null;
            await this.loadDashboards();
            
        } catch (error) {
             console.error('Delete failed', error);
        }
    },

    async refreshData() {
        await this.renderGrid();
    }
};
