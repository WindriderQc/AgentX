/**
 * Alerts Dashboard Component for AgentX
 * Real-time alert monitoring with filtering, actions, and statistics
 */

import { apiClient } from './utils/api-client.js';

class AlertsDashboard {
    constructor(options = {}) {
        this.containerId = options.containerId || 'alerts-container';
        this.statsContainerId = options.statsContainerId || 'alerts-stats';
        this.filtersContainerId = options.filtersContainerId || 'alerts-filters';
        this.refreshInterval = options.refreshInterval || 30000; // 30 seconds
        this.perPage = options.perPage || 20;
        
        // State
        this.currentPage = 1;
        this.totalAlerts = 0;
        this.filters = {
            severity: 'all',
            status: 'all',
            component: 'all',
            dateRange: 'today'
        };
        this.selectedAlerts = new Set();
        this.autoRefreshTimer = null;
        
        // Severity configuration
        this.severityConfig = {
            critical: { class: 'danger', icon: 'fa-exclamation-triangle', color: '#dc3545' },
            high: { class: 'warning', icon: 'fa-exclamation-circle', color: '#fd7e14' },
            medium: { class: 'warning', icon: 'fa-exclamation', color: '#ffc107' },
            low: { class: 'info', icon: 'fa-info-circle', color: '#0dcaf0' },
            info: { class: 'secondary', icon: 'fa-info', color: '#6c757d' }
        };
    }

    /**
     * Initialize the dashboard
     */
    async init() {
        try {
            await this.loadComponents();
            await this.loadAlerts();
            await this.loadStatistics();
            this.startAutoRefresh();
            console.log('Alerts Dashboard initialized');
        } catch (error) {
            console.error('Failed to initialize Alerts Dashboard:', error);
            this.showToast('Failed to initialize dashboard', 'error');
        }
    }

    /**
     * Load available components for filtering
     */
    async loadComponents() {
        try {
            const response = await apiClient.get('/alerts', { limit: 1000 });
            const alerts = response.data || response.alerts || [];
            
            // Extract unique components
            const components = new Set();
            alerts.forEach(alert => {
                if (alert.source) components.add(alert.source);
            });
            
            this.availableComponents = Array.from(components).sort();
        } catch (error) {
            console.error('Failed to load components:', error);
            this.availableComponents = [];
        }
    }

    /**
     * Load alerts with current filters
     */
    async loadAlerts() {
        try {
            const params = {
                limit: this.perPage,
                skip: (this.currentPage - 1) * this.perPage,
                sort: '-createdAt'
            };

            // Apply filters
            if (this.filters.severity !== 'all') {
                params.severity = this.filters.severity;
            }
            if (this.filters.status !== 'all') {
                params.status = this.filters.status;
            }
            if (this.filters.component !== 'all') {
                params.source = this.filters.component;
            }

            // Date range filter
            if (this.filters.dateRange !== 'all') {
                const dateFilter = this.getDateFilter(this.filters.dateRange);
                if (dateFilter) {
                    params.startDate = dateFilter.toISOString();
                }
            }

            const response = await apiClient.get('/alerts', params);
            const alerts = response.data || response.alerts || [];
            this.totalAlerts = response.total || alerts.length;

            this.renderAlerts(alerts);
            this.renderPagination();
        } catch (error) {
            console.error('Failed to load alerts:', error);
            this.showToast('Failed to load alerts', 'error');
        }
    }

    /**
     * Load alert statistics
     */
    async loadStatistics() {
        try {
            const response = await apiClient.get('/alerts/stats/summary');
            const stats = response.data || response.stats || {};
            
            this.renderStatistics(stats);
        } catch (error) {
            console.error('Failed to load statistics:', error);
            // Continue with empty stats
            this.renderStatistics({});
        }
    }

    /**
     * Render alert statistics banner
     */
    renderStatistics(stats) {
        const container = document.getElementById(this.statsContainerId);
        if (!container) return;

        const {
            totalAlerts = 0,
            critical = 0,
            high = 0,
            medium = 0,
            unacknowledged = 0,
            avgResolutionTime = 'N/A'
        } = stats;

        container.innerHTML = `
            <div class="row g-3">
                <div class="col-md-2">
                    <div class="card bg-dark text-white">
                        <div class="card-body text-center">
                            <h3 class="mb-0">${totalAlerts}</h3>
                            <small class="text-muted">Total Alerts</small>
                        </div>
                    </div>
                </div>
                <div class="col-md-2">
                    <div class="card bg-danger text-white">
                        <div class="card-body text-center">
                            <h3 class="mb-0">${critical}</h3>
                            <small>Critical</small>
                        </div>
                    </div>
                </div>
                <div class="col-md-2">
                    <div class="card bg-warning text-dark">
                        <div class="card-body text-center">
                            <h3 class="mb-0">${high}</h3>
                            <small>High</small>
                        </div>
                    </div>
                </div>
                <div class="col-md-2">
                    <div class="card bg-warning text-dark" style="opacity: 0.7">
                        <div class="card-body text-center">
                            <h3 class="mb-0">${medium}</h3>
                            <small>Medium</small>
                        </div>
                    </div>
                </div>
                <div class="col-md-2">
                    <div class="card bg-info text-white">
                        <div class="card-body text-center">
                            <h3 class="mb-0">${unacknowledged}</h3>
                            <small>Unacknowledged</small>
                        </div>
                    </div>
                </div>
                <div class="col-md-2">
                    <div class="card bg-secondary text-white">
                        <div class="card-body text-center">
                            <h3 class="mb-0">${avgResolutionTime}</h3>
                            <small>Avg Resolution</small>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Render alerts list
     */
    renderAlerts(alerts) {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        if (alerts.length === 0) {
            container.innerHTML = `
                <div class="alert alert-info text-center">
                    <i class="fas fa-info-circle"></i> No alerts found matching your criteria
                </div>
            `;
            return;
        }

        const alertsHtml = alerts.map(alert => this.renderAlertCard(alert)).join('');
        container.innerHTML = alertsHtml;
    }

    /**
     * Render individual alert card
     */
    renderAlertCard(alert) {
        const config = this.severityConfig[alert.severity] || this.severityConfig.info;
        const timeAgo = this.formatTimeAgo(alert.createdAt);
        const isSelected = this.selectedAlerts.has(alert._id);

        return `
            <div class="alert alert-${config.class} mb-2 alert-card" data-alert-id="${alert._id}">
                <div class="d-flex align-items-start">
                    <div class="form-check me-2">
                        <input class="form-check-input alert-checkbox" type="checkbox" 
                               ${isSelected ? 'checked' : ''} 
                               onchange="window.alertsDashboard.toggleSelection('${alert._id}')">
                    </div>
                    <div class="flex-grow-1">
                        <div class="d-flex justify-content-between align-items-start">
                            <h6 class="alert-heading mb-1">
                                <i class="fas ${config.icon}"></i> ${this.escapeHtml(alert.title)}
                            </h6>
                            <small class="text-muted">${timeAgo}</small>
                        </div>
                        <p class="mb-2">${this.escapeHtml(alert.message)}</p>
                        <div class="d-flex justify-content-between align-items-center flex-wrap">
                            <div class="mb-2 mb-sm-0">
                                <span class="badge bg-secondary me-1">${this.escapeHtml(alert.source || 'unknown')}</span>
                                ${alert.ruleName ? `<span class="badge bg-info">${this.escapeHtml(alert.ruleName)}</span>` : ''}
                                <span class="badge bg-dark ms-1">${this.escapeHtml(alert.status || 'active')}</span>
                            </div>
                            <div class="btn-group btn-group-sm" role="group">
                                ${alert.status === 'active' ? `
                                    <button class="btn btn-outline-primary" 
                                            onclick="window.alertsDashboard.acknowledgeAlert('${alert._id}')"
                                            title="Acknowledge">
                                        <i class="fas fa-check"></i> Acknowledge
                                    </button>
                                ` : ''}
                                ${alert.status !== 'resolved' ? `
                                    <button class="btn btn-outline-success" 
                                            onclick="window.alertsDashboard.resolveAlert('${alert._id}')"
                                            title="Resolve">
                                        <i class="fas fa-check-double"></i> Resolve
                                    </button>
                                ` : ''}
                                <button class="btn btn-outline-info" 
                                        onclick="window.alertsDashboard.viewDetails('${alert._id}')"
                                        title="View Details">
                                    <i class="fas fa-eye"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Render pagination controls
     */
    renderPagination() {
        const container = document.getElementById('alerts-pagination');
        if (!container) return;

        const totalPages = Math.ceil(this.totalAlerts / this.perPage);
        
        if (totalPages <= 1) {
            container.innerHTML = '';
            return;
        }

        let paginationHtml = '<nav><ul class="pagination justify-content-center">';
        
        // Previous button
        paginationHtml += `
            <li class="page-item ${this.currentPage === 1 ? 'disabled' : ''}">
                <a class="page-link" href="#" onclick="window.alertsDashboard.goToPage(${this.currentPage - 1}); return false;">
                    Previous
                </a>
            </li>
        `;

        // Page numbers
        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= this.currentPage - 2 && i <= this.currentPage + 2)) {
                paginationHtml += `
                    <li class="page-item ${i === this.currentPage ? 'active' : ''}">
                        <a class="page-link" href="#" onclick="window.alertsDashboard.goToPage(${i}); return false;">
                            ${i}
                        </a>
                    </li>
                `;
            } else if (i === this.currentPage - 3 || i === this.currentPage + 3) {
                paginationHtml += '<li class="page-item disabled"><span class="page-link">...</span></li>';
            }
        }

        // Next button
        paginationHtml += `
            <li class="page-item ${this.currentPage === totalPages ? 'disabled' : ''}">
                <a class="page-link" href="#" onclick="window.alertsDashboard.goToPage(${this.currentPage + 1}); return false;">
                    Next
                </a>
            </li>
        `;

        paginationHtml += '</ul></nav>';
        container.innerHTML = paginationHtml;
    }

    /**
     * Render filter controls
     */
    renderFilters() {
        const container = document.getElementById(this.filtersContainerId);
        if (!container) return;

        const componentOptions = this.availableComponents.map(comp => 
            `<option value="${comp}">${comp}</option>`
        ).join('');

        container.innerHTML = `
            <div class="row g-3 mb-3">
                <div class="col-md-3">
                    <label class="form-label">Severity</label>
                    <select class="form-select" id="filter-severity" onchange="window.alertsDashboard.updateFilter('severity', this.value)">
                        <option value="all">All Severities</option>
                        <option value="critical">Critical</option>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                        <option value="info">Info</option>
                    </select>
                </div>
                <div class="col-md-3">
                    <label class="form-label">Status</label>
                    <select class="form-select" id="filter-status" onchange="window.alertsDashboard.updateFilter('status', this.value)">
                        <option value="all">All Statuses</option>
                        <option value="active">Active</option>
                        <option value="acknowledged">Acknowledged</option>
                        <option value="resolved">Resolved</option>
                    </select>
                </div>
                <div class="col-md-3">
                    <label class="form-label">Component</label>
                    <select class="form-select" id="filter-component" onchange="window.alertsDashboard.updateFilter('component', this.value)">
                        <option value="all">All Components</option>
                        ${componentOptions}
                    </select>
                </div>
                <div class="col-md-3">
                    <label class="form-label">Date Range</label>
                    <select class="form-select" id="filter-daterange" onchange="window.alertsDashboard.updateFilter('dateRange', this.value)">
                        <option value="all">All Time</option>
                        <option value="hour">Last Hour</option>
                        <option value="today" selected>Today</option>
                        <option value="week">Last 7 Days</option>
                        <option value="month">Last 30 Days</option>
                    </select>
                </div>
            </div>
            <div class="row mb-3">
                <div class="col-md-12">
                    <button class="btn btn-primary btn-sm me-2" onclick="window.alertsDashboard.acknowledgeSelected()">
                        <i class="fas fa-check"></i> Acknowledge Selected
                    </button>
                    <button class="btn btn-success btn-sm me-2" onclick="window.alertsDashboard.resolveSelected()">
                        <i class="fas fa-check-double"></i> Resolve Selected
                    </button>
                    <button class="btn btn-secondary btn-sm me-2" onclick="window.alertsDashboard.exportToCSV()">
                        <i class="fas fa-download"></i> Export to CSV
                    </button>
                    <button class="btn btn-outline-secondary btn-sm" onclick="window.alertsDashboard.clearFilters()">
                        <i class="fas fa-times"></i> Clear Filters
                    </button>
                </div>
            </div>
        `;
    }

    /**
     * Update filter and reload alerts
     */
    updateFilter(filterType, value) {
        this.filters[filterType] = value;
        this.currentPage = 1;
        this.loadAlerts();
    }

    /**
     * Clear all filters
     */
    clearFilters() {
        this.filters = {
            severity: 'all',
            status: 'all',
            component: 'all',
            dateRange: 'today'
        };
        
        // Reset UI
        document.getElementById('filter-severity').value = 'all';
        document.getElementById('filter-status').value = 'all';
        document.getElementById('filter-component').value = 'all';
        document.getElementById('filter-daterange').value = 'today';
        
        this.currentPage = 1;
        this.loadAlerts();
    }

    /**
     * Go to specific page
     */
    goToPage(page) {
        const totalPages = Math.ceil(this.totalAlerts / this.perPage);
        if (page < 1 || page > totalPages) return;
        
        this.currentPage = page;
        this.loadAlerts();
    }

    /**
     * Toggle alert selection
     */
    toggleSelection(alertId) {
        if (this.selectedAlerts.has(alertId)) {
            this.selectedAlerts.delete(alertId);
        } else {
            this.selectedAlerts.add(alertId);
        }
    }

    /**
     * Acknowledge single alert
     */
    async acknowledgeAlert(alertId) {
        try {
            await apiClient.put(`/alerts/${alertId}/acknowledge`, {
                acknowledgedBy: 'user',
                comment: 'Acknowledged from dashboard'
            });
            
            this.showToast('Alert acknowledged', 'success');
            this.loadAlerts();
            this.loadStatistics();
        } catch (error) {
            console.error('Failed to acknowledge alert:', error);
            this.showToast('Failed to acknowledge alert', 'error');
        }
    }

    /**
     * Resolve single alert
     */
    async resolveAlert(alertId) {
        try {
            await apiClient.put(`/alerts/${alertId}/resolve`, {
                resolvedBy: 'user',
                resolution: 'Resolved from dashboard',
                method: 'manual'
            });
            
            this.showToast('Alert resolved', 'success');
            this.loadAlerts();
            this.loadStatistics();
        } catch (error) {
            console.error('Failed to resolve alert:', error);
            this.showToast('Failed to resolve alert', 'error');
        }
    }

    /**
     * Acknowledge selected alerts
     */
    async acknowledgeSelected() {
        if (this.selectedAlerts.size === 0) {
            this.showToast('No alerts selected', 'info');
            return;
        }

        const alertIds = Array.from(this.selectedAlerts);
        let successCount = 0;

        for (const alertId of alertIds) {
            try {
                await apiClient.put(`/alerts/${alertId}/acknowledge`, {
                    acknowledgedBy: 'user',
                    comment: 'Bulk acknowledged'
                });
                successCount++;
            } catch (error) {
                console.error(`Failed to acknowledge alert ${alertId}:`, error);
            }
        }

        this.selectedAlerts.clear();
        this.showToast(`${successCount} alert(s) acknowledged`, 'success');
        this.loadAlerts();
        this.loadStatistics();
    }

    /**
     * Resolve selected alerts
     */
    async resolveSelected() {
        if (this.selectedAlerts.size === 0) {
            this.showToast('No alerts selected', 'info');
            return;
        }

        const alertIds = Array.from(this.selectedAlerts);
        let successCount = 0;

        for (const alertId of alertIds) {
            try {
                await apiClient.put(`/alerts/${alertId}/resolve`, {
                    resolvedBy: 'user',
                    resolution: 'Bulk resolved',
                    method: 'manual'
                });
                successCount++;
            } catch (error) {
                console.error(`Failed to resolve alert ${alertId}:`, error);
            }
        }

        this.selectedAlerts.clear();
        this.showToast(`${successCount} alert(s) resolved`, 'success');
        this.loadAlerts();
        this.loadStatistics();
    }

    /**
     * View alert details
     */
    async viewDetails(alertId) {
        try {
            const response = await apiClient.get(`/alerts/${alertId}`);
            const alert = response.data || response;
            
            // Create modal with alert details
            const modalHtml = `
                <div class="modal fade" id="alertDetailsModal" tabindex="-1">
                    <div class="modal-dialog modal-lg">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title">Alert Details</h5>
                                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                            </div>
                            <div class="modal-body">
                                <h6>Title</h6>
                                <p>${this.escapeHtml(alert.title)}</p>
                                
                                <h6>Message</h6>
                                <p>${this.escapeHtml(alert.message)}</p>
                                
                                <h6>Details</h6>
                                <table class="table table-sm">
                                    <tr><td><strong>Severity:</strong></td><td>${alert.severity}</td></tr>
                                    <tr><td><strong>Status:</strong></td><td>${alert.status}</td></tr>
                                    <tr><td><strong>Source:</strong></td><td>${alert.source}</td></tr>
                                    <tr><td><strong>Created:</strong></td><td>${new Date(alert.createdAt).toLocaleString()}</td></tr>
                                    ${alert.acknowledgedAt ? `<tr><td><strong>Acknowledged:</strong></td><td>${new Date(alert.acknowledgedAt).toLocaleString()}</td></tr>` : ''}
                                    ${alert.resolvedAt ? `<tr><td><strong>Resolved:</strong></td><td>${new Date(alert.resolvedAt).toLocaleString()}</td></tr>` : ''}
                                </table>
                                
                                ${alert.context ? `
                                    <h6>Context</h6>
                                    <pre class="bg-dark text-light p-3">${JSON.stringify(alert.context, null, 2)}</pre>
                                ` : ''}
                            </div>
                            <div class="modal-footer">
                                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            // Remove existing modal if any
            const existingModal = document.getElementById('alertDetailsModal');
            if (existingModal) existingModal.remove();
            
            // Add modal to DOM
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            
            // Show modal (using Bootstrap 5)
            const modal = new bootstrap.Modal(document.getElementById('alertDetailsModal'));
            modal.show();
            
        } catch (error) {
            console.error('Failed to load alert details:', error);
            this.showToast('Failed to load alert details', 'error');
        }
    }

    /**
     * Export alerts to CSV
     */
    async exportToCSV() {
        try {
            // Get all alerts matching current filters
            const params = { ...this.filters, limit: 10000, sort: '-createdAt' };
            const response = await apiClient.get('/alerts', params);
            const alerts = response.data || response.alerts || [];

            if (alerts.length === 0) {
                this.showToast('No alerts to export', 'info');
                return;
            }

            // Create CSV content
            const headers = ['ID', 'Title', 'Message', 'Severity', 'Status', 'Source', 'Created', 'Acknowledged', 'Resolved'];
            const rows = alerts.map(alert => [
                alert._id,
                alert.title,
                alert.message,
                alert.severity,
                alert.status,
                alert.source,
                new Date(alert.createdAt).toISOString(),
                alert.acknowledgedAt ? new Date(alert.acknowledgedAt).toISOString() : '',
                alert.resolvedAt ? new Date(alert.resolvedAt).toISOString() : ''
            ]);

            const csvContent = [
                headers.join(','),
                ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
            ].join('\n');

            // Download CSV
            const blob = new Blob([csvContent], { type: 'text/csv' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `alerts_${new Date().toISOString().split('T')[0]}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);

            this.showToast('Alerts exported successfully', 'success');
        } catch (error) {
            console.error('Failed to export alerts:', error);
            this.showToast('Failed to export alerts', 'error');
        }
    }

    /**
     * Start auto-refresh
     */
    startAutoRefresh() {
        this.stopAutoRefresh();
        this.autoRefreshTimer = setInterval(() => {
            this.loadAlerts();
            this.loadStatistics();
        }, this.refreshInterval);
    }

    /**
     * Stop auto-refresh
     */
    stopAutoRefresh() {
        if (this.autoRefreshTimer) {
            clearInterval(this.autoRefreshTimer);
            this.autoRefreshTimer = null;
        }
    }

    /**
     * Utility: Get date filter
     */
    getDateFilter(range) {
        const now = new Date();
        switch (range) {
            case 'hour':
                return new Date(now - 60 * 60 * 1000);
            case 'today':
                return new Date(now.setHours(0, 0, 0, 0));
            case 'week':
                return new Date(now - 7 * 24 * 60 * 60 * 1000);
            case 'month':
                return new Date(now - 30 * 24 * 60 * 60 * 1000);
            default:
                return null;
        }
    }

    /**
     * Utility: Format time ago
     */
    formatTimeAgo(date) {
        const seconds = Math.floor((new Date() - new Date(date)) / 1000);
        
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
        
        return new Date(date).toLocaleDateString();
    }

    /**
     * Utility: Escape HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Show toast notification
     */
    showToast(message, type = 'info') {
        if (typeof showToast === 'function') {
            showToast(message, type);
        } else {
            console.log(`[${type.toUpperCase()}] ${message}`);
        }
    }

    /**
     * Cleanup
     */
    destroy() {
        this.stopAutoRefresh();
        this.selectedAlerts.clear();
    }
}

// Export for use in other modules
export default AlertsDashboard;

// Also expose globally for onclick handlers
window.AlertsDashboard = AlertsDashboard;
