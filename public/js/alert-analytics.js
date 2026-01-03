/**
 * Alert Analytics Dashboard
 * Comprehensive analytics showing trends, patterns, and insights for alerts
 *
 * Features:
 * 1. Alert volume over time (line chart)
 * 2. Alerts by severity (pie chart)
 * 3. Top alerting components (bar chart)
 * 4. Mean time to acknowledge (MTTA)
 * 5. Mean time to resolution (MTTR)
 * 6. Alert recurrence heatmap
 * 7. Delivery success rate by channel
 */

import { apiClient } from './utils/api-client.js';

class AlertAnalytics {
    constructor(options = {}) {
        this.containerId = options.containerId || 'alert-analytics-container';
        this.refreshInterval = options.refreshInterval || 60000; // 1 minute
        this.timeRange = options.timeRange || 7; // days

        // Chart instances
        this.charts = {};

        // Data cache
        this.cache = {
            statistics: null,
            alerts: [],
            lastUpdate: null
        };

        // Color schemes
        this.colors = {
            critical: '#dc3545',
            high: '#fd7e14',
            warning: '#ffc107',
            medium: '#ffc107',
            low: '#17a2b8',
            info: '#6c757d',
            primary: '#0d6efd',
            success: '#198754',
            danger: '#dc3545'
        };

        // Chart.js defaults
        Chart.defaults.font.family = "'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        Chart.defaults.color = '#8b95a1';
    }

    /**
     * Initialize the dashboard
     */
    async init() {
        try {
            console.log('Initializing Alert Analytics Dashboard...');
            this.renderLayout();
            await this.loadData();
            await this.renderAllCharts();
            this.startAutoRefresh();
            console.log('Alert Analytics Dashboard initialized');
        } catch (error) {
            console.error('Failed to initialize Alert Analytics:', error);
            this.showError('Failed to initialize analytics dashboard');
        }
    }

    /**
     * Render the dashboard layout
     */
    renderLayout() {
        const container = document.getElementById(this.containerId);
        if (!container) {
            console.error(`Container #${this.containerId} not found`);
            return;
        }

        container.innerHTML = `
            <div class="alert-analytics">
                <!-- Header with controls -->
                <div class="analytics-header">
                    <div class="header-info">
                        <h2><i class="fas fa-chart-line"></i> Alert Analytics</h2>
                        <p class="subtitle">Trends, patterns, and insights from your alert data</p>
                    </div>
                    <div class="header-controls">
                        <select id="timeRangeSelect" class="form-select">
                            <option value="1">Last 24 hours</option>
                            <option value="7" selected>Last 7 days</option>
                            <option value="14">Last 14 days</option>
                            <option value="30">Last 30 days</option>
                            <option value="90">Last 90 days</option>
                        </select>
                        <button id="refreshAnalytics" class="btn btn-primary">
                            <i class="fas fa-sync-alt"></i> Refresh
                        </button>
                    </div>
                </div>

                <!-- Key Metrics Row -->
                <div class="metrics-grid">
                    <div class="metric-card">
                        <div class="metric-icon" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
                            <i class="fas fa-bell"></i>
                        </div>
                        <div class="metric-content">
                            <div class="metric-label">Total Alerts</div>
                            <div class="metric-value" id="totalAlerts">-</div>
                            <div class="metric-change" id="alertsChange"></div>
                        </div>
                    </div>

                    <div class="metric-card">
                        <div class="metric-icon" style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);">
                            <i class="fas fa-exclamation-triangle"></i>
                        </div>
                        <div class="metric-content">
                            <div class="metric-label">Critical Alerts</div>
                            <div class="metric-value" id="criticalAlerts">-</div>
                            <div class="metric-change" id="criticalChange"></div>
                        </div>
                    </div>

                    <div class="metric-card">
                        <div class="metric-icon" style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);">
                            <i class="fas fa-clock"></i>
                        </div>
                        <div class="metric-content">
                            <div class="metric-label">MTTA</div>
                            <div class="metric-value" id="mttaValue">-</div>
                            <div class="metric-subtitle">Mean Time To Acknowledge</div>
                        </div>
                    </div>

                    <div class="metric-card">
                        <div class="metric-icon" style="background: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);">
                            <i class="fas fa-check-circle"></i>
                        </div>
                        <div class="metric-content">
                            <div class="metric-label">MTTR</div>
                            <div class="metric-value" id="mttrValue">-</div>
                            <div class="metric-subtitle">Mean Time To Resolution</div>
                        </div>
                    </div>
                </div>

                <!-- Charts Grid -->
                <div class="charts-container">
                    <!-- Alert Volume Over Time -->
                    <div class="chart-card full-width">
                        <div class="chart-header">
                            <h3><i class="fas fa-chart-area"></i> Alert Volume Over Time</h3>
                            <div class="chart-legend" id="volumeLegend"></div>
                        </div>
                        <div class="chart-wrapper">
                            <canvas id="volumeChart"></canvas>
                        </div>
                    </div>

                    <!-- Alerts by Severity -->
                    <div class="chart-card">
                        <div class="chart-header">
                            <h3><i class="fas fa-chart-pie"></i> Alerts by Severity</h3>
                        </div>
                        <div class="chart-wrapper">
                            <canvas id="severityChart"></canvas>
                        </div>
                    </div>

                    <!-- Top Alerting Components -->
                    <div class="chart-card">
                        <div class="chart-header">
                            <h3><i class="fas fa-chart-bar"></i> Top Alerting Components</h3>
                        </div>
                        <div class="chart-wrapper">
                            <canvas id="componentsChart"></canvas>
                        </div>
                    </div>

                    <!-- Alert Status Distribution -->
                    <div class="chart-card">
                        <div class="chart-header">
                            <h3><i class="fas fa-tasks"></i> Alert Status Distribution</h3>
                        </div>
                        <div class="chart-wrapper">
                            <canvas id="statusChart"></canvas>
                        </div>
                    </div>

                    <!-- Delivery Success Rate -->
                    <div class="chart-card">
                        <div class="chart-header">
                            <h3><i class="fas fa-paper-plane"></i> Delivery Success Rate by Channel</h3>
                        </div>
                        <div class="chart-wrapper">
                            <canvas id="deliveryChart"></canvas>
                        </div>
                    </div>

                    <!-- Alert Recurrence Heatmap -->
                    <div class="chart-card full-width">
                        <div class="chart-header">
                            <h3><i class="fas fa-th"></i> Alert Recurrence Heatmap</h3>
                            <p class="chart-subtitle">24-hour pattern of alert activity</p>
                        </div>
                        <div class="chart-wrapper">
                            <canvas id="heatmapChart"></canvas>
                        </div>
                    </div>
                </div>

                <!-- Loading Overlay -->
                <div id="analyticsLoading" class="loading-overlay" style="display: none;">
                    <div class="spinner"></div>
                    <p>Loading analytics data...</p>
                </div>

                <!-- Error Message -->
                <div id="analyticsError" class="error-message" style="display: none;">
                    <i class="fas fa-exclamation-circle"></i>
                    <span id="errorText"></span>
                </div>
            </div>
        `;

        // Attach event listeners
        this.attachEventListeners();
    }

    /**
     * Attach event listeners
     */
    attachEventListeners() {
        const refreshBtn = document.getElementById('refreshAnalytics');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this.refresh());
        }

        const timeRangeSelect = document.getElementById('timeRangeSelect');
        if (timeRangeSelect) {
            timeRangeSelect.addEventListener('change', (e) => {
                this.timeRange = parseInt(e.target.value);
                this.refresh();
            });
        }
    }

    /**
     * Load all analytics data
     */
    async loadData() {
        this.showLoading(true);

        try {
            const fromDate = new Date();
            fromDate.setDate(fromDate.getDate() - this.timeRange);

            // Fetch comprehensive statistics from new endpoint
            const response = await apiClient.get('/alerts/statistics', {
                from: fromDate.toISOString()
            });

            this.cache.statistics = response.data;
            this.cache.lastUpdate = new Date();

            console.log('Analytics data loaded:', {
                summary: this.cache.statistics.summary,
                dataPoints: {
                    timeSeries: this.cache.statistics.timeSeries?.length || 0,
                    heatmap: this.cache.statistics.heatmap?.length || 0
                }
            });
        } catch (error) {
            console.error('Failed to load analytics data:', error);
            throw error;
        } finally {
            this.showLoading(false);
        }
    }

    /**
     * Render all charts
     */
    async renderAllCharts() {
        await this.updateMetrics();
        await this.renderVolumeChart();
        await this.renderSeverityChart();
        await this.renderComponentsChart();
        await this.renderStatusChart();
        await this.renderDeliveryChart();
        await this.renderHeatmap();
    }

    /**
     * Update key metrics
     */
    async updateMetrics() {
        const stats = this.cache.statistics;

        if (!stats || !stats.summary) return;

        // Total alerts
        const totalAlerts = stats.summary.totalAlerts || 0;
        document.getElementById('totalAlerts').textContent = totalAlerts.toLocaleString();

        // Critical alerts
        const criticalCount = stats.bySeverity?.critical || 0;
        document.getElementById('criticalAlerts').textContent = criticalCount.toLocaleString();

        // MTTA (Mean Time To Acknowledge) - from backend
        const mtta = stats.summary.avgAcknowledgmentTime || 0;
        document.getElementById('mttaValue').textContent = this.formatDuration(mtta);

        // MTTR (Mean Time To Resolution) - from backend
        const mttr = stats.summary.avgResolutionTime || 0;
        document.getElementById('mttrValue').textContent = this.formatDuration(mttr);
    }


    /**
     * Render alert volume over time chart
     */
    async renderVolumeChart() {
        const ctx = document.getElementById('volumeChart');
        if (!ctx) return;

        const stats = this.cache.statistics;
        const timeData = this.formatTimeSeriesData(stats.timeSeries || []);

        // Destroy existing chart
        if (this.charts.volume) {
            this.charts.volume.destroy();
        }

        this.charts.volume = new Chart(ctx, {
            type: 'line',
            data: {
                labels: timeData.labels,
                datasets: [
                    {
                        label: 'Critical',
                        data: timeData.critical,
                        borderColor: this.colors.critical,
                        backgroundColor: this.hexToRgba(this.colors.critical, 0.1),
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4
                    },
                    {
                        label: 'High',
                        data: timeData.high,
                        borderColor: this.colors.high,
                        backgroundColor: this.hexToRgba(this.colors.high, 0.1),
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4
                    },
                    {
                        label: 'Warning',
                        data: timeData.warning,
                        borderColor: this.colors.warning,
                        backgroundColor: this.hexToRgba(this.colors.warning, 0.1),
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4
                    },
                    {
                        label: 'Info',
                        data: timeData.info,
                        borderColor: this.colors.info,
                        backgroundColor: this.hexToRgba(this.colors.info, 0.1),
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top'
                    },
                    tooltip: {
                        callbacks: {
                            footer: (tooltipItems) => {
                                const total = tooltipItems.reduce((sum, item) => sum + item.parsed.y, 0);
                                return `Total: ${total}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            display: false
                        }
                    },
                    y: {
                        beginAtZero: true,
                        ticks: {
                            precision: 0
                        }
                    }
                }
            }
        });
    }

    /**
     * Render severity distribution pie chart
     */
    async renderSeverityChart() {
        const ctx = document.getElementById('severityChart');
        if (!ctx) return;

        const stats = this.cache.statistics;
        const severityData = stats?.bySeverity || {};

        const labels = Object.keys(severityData);
        const data = Object.values(severityData);
        const colors = labels.map(sev => this.colors[sev] || this.colors.info);

        // Destroy existing chart
        if (this.charts.severity) {
            this.charts.severity.destroy();
        }

        this.charts.severity = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels.map(l => l.charAt(0).toUpperCase() + l.slice(1)),
                datasets: [{
                    data: data,
                    backgroundColor: colors,
                    borderWidth: 2,
                    borderColor: '#1a1d29'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom'
                    },
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                const label = context.label || '';
                                const value = context.parsed;
                                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                const percentage = ((value / total) * 100).toFixed(1);
                                return `${label}: ${value} (${percentage}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    /**
     * Render top alerting components bar chart
     */
    async renderComponentsChart() {
        const ctx = document.getElementById('componentsChart');
        if (!ctx) return;

        const stats = this.cache.statistics;
        const bySource = stats.bySource || {};

        // Get top 10 components
        const sorted = Object.entries(bySource)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const labels = sorted.map(([name]) => name);
        const data = sorted.map(([, count]) => count);

        // Destroy existing chart
        if (this.charts.components) {
            this.charts.components.destroy();
        }

        this.charts.components = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Alert Count',
                    data: data,
                    backgroundColor: this.colors.primary,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        ticks: {
                            precision: 0
                        }
                    }
                }
            }
        });
    }

    /**
     * Render status distribution chart
     */
    async renderStatusChart() {
        const ctx = document.getElementById('statusChart');
        if (!ctx) return;

        const stats = this.cache.statistics;
        const statusData = stats?.byStatus || {};

        const labels = Object.keys(statusData);
        const data = Object.values(statusData);

        const statusColors = {
            active: this.colors.danger,
            acknowledged: this.colors.warning,
            resolved: this.colors.success,
            suppressed: this.colors.info
        };

        const colors = labels.map(status => statusColors[status] || this.colors.info);

        // Destroy existing chart
        if (this.charts.status) {
            this.charts.status.destroy();
        }

        this.charts.status = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels.map(l => l.charAt(0).toUpperCase() + l.slice(1)),
                datasets: [{
                    label: 'Alerts',
                    data: data,
                    backgroundColor: colors,
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            precision: 0
                        }
                    }
                }
            }
        });
    }

    /**
     * Render delivery success rate chart
     */
    async renderDeliveryChart() {
        const ctx = document.getElementById('deliveryChart');
        if (!ctx) return;

        const stats = this.cache.statistics;
        const deliveryStats = this.formatDeliveryStats(stats.deliveryStats || []);

        const channels = Object.keys(deliveryStats);
        const successRates = channels.map(ch => deliveryStats[ch].successRate);

        // Destroy existing chart
        if (this.charts.delivery) {
            this.charts.delivery.destroy();
        }

        this.charts.delivery = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: channels.map(ch => ch.charAt(0).toUpperCase() + ch.slice(1)),
                datasets: [{
                    label: 'Success Rate (%)',
                    data: successRates,
                    backgroundColor: channels.map((_, idx) => {
                        const hue = (idx * 137.5) % 360;
                        return `hsl(${hue}, 70%, 60%)`;
                    }),
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                const channel = channels[context.dataIndex];
                                const stats = deliveryStats[channel];
                                return [
                                    `Success Rate: ${context.parsed.y.toFixed(1)}%`,
                                    `Sent: ${stats.sent}`,
                                    `Failed: ${stats.failed}`
                                ];
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        max: 100,
                        ticks: {
                            callback: (value) => value + '%'
                        }
                    }
                }
            }
        });
    }

    /**
     * Render alert recurrence heatmap
     */
    async renderHeatmap() {
        const ctx = document.getElementById('heatmapChart');
        if (!ctx) return;

        const stats = this.cache.statistics;
        const heatmapData = this.formatHeatmapData(stats.heatmap || []);

        // Destroy existing chart
        if (this.charts.heatmap) {
            this.charts.heatmap.destroy();
        }

        // Generate dataset for matrix visualization
        const datasets = heatmapData.days.map((day, dayIdx) => {
            return {
                label: day,
                data: heatmapData.hours.map((hour, hourIdx) => ({
                    x: hour,
                    y: day,
                    v: heatmapData.data[dayIdx][hourIdx]
                })),
                backgroundColor: (context) => {
                    const value = context.parsed?.v || 0;
                    const maxValue = Math.max(...heatmapData.data.flat());
                    const intensity = maxValue > 0 ? value / maxValue : 0;
                    return this.hexToRgba(this.colors.primary, intensity);
                },
                borderWidth: 1,
                borderColor: '#1a1d29',
                width: ({ chart }) => (chart.width / heatmapData.hours.length) - 2,
                height: ({ chart }) => (chart.height / heatmapData.days.length) - 2
            };
        });

        this.charts.heatmap = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: heatmapData.hours,
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'right'
                    },
                    tooltip: {
                        callbacks: {
                            title: (items) => {
                                const item = items[0];
                                return `${item.dataset.label} at ${item.label}:00`;
                            },
                            label: (context) => {
                                return `Alerts: ${context.parsed.v || 0}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: 'Hour of Day'
                        }
                    },
                    y: {
                        stacked: false
                    }
                }
            }
        });
    }

    /**
     * Format time series data from backend
     */
    formatTimeSeriesData(timeSeries) {
        const data = {
            labels: [],
            critical: [],
            high: [],
            warning: [],
            info: []
        };

        timeSeries.forEach(point => {
            // Format label based on time range
            const date = new Date(point._id.year, point._id.month - 1, point._id.day, point._id.hour);
            let label;

            if (this.timeRange <= 1) {
                // Hourly for 24 hours
                label = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            } else if (this.timeRange <= 7) {
                // Daily with hour for up to 7 days
                label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit' });
            } else {
                // Daily for longer ranges
                label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            }

            data.labels.push(label);
            data.critical.push(point.critical || 0);
            data.high.push(point.high || 0);
            data.warning.push(point.warning || 0);
            data.info.push(point.info || 0);
        });

        return data;
    }

    /**
     * Format delivery statistics from backend
     */
    formatDeliveryStats(deliveryStats) {
        const stats = {};

        deliveryStats.forEach(item => {
            if (!item._id) return;

            const channel = item._id;
            const sent = item.sent || 0;
            const failed = item.failed || 0;
            const total = sent + failed;

            stats[channel] = {
                sent,
                failed,
                successRate: total > 0 ? (sent / total) * 100 : 0
            };
        });

        return stats;
    }

    /**
     * Format heatmap data from backend
     */
    formatHeatmapData(heatmapData) {
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const hours = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0'));

        // Initialize matrix
        const data = Array(7).fill(0).map(() => Array(24).fill(0));

        // Fill in data from backend
        heatmapData.forEach(item => {
            const dayOfWeek = item._id.dayOfWeek - 1; // MongoDB dayOfWeek is 1-7, we need 0-6
            const hour = item._id.hour;
            data[dayOfWeek][hour] = item.count;
        });

        return { days, hours, data };
    }

    /**
     * Format duration in human-readable format
     */
    formatDuration(ms) {
        if (!ms || ms === 0) return 'N/A';

        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m`;
        return `${seconds}s`;
    }

    /**
     * Convert hex color to rgba
     */
    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    /**
     * Show loading overlay
     */
    showLoading(show) {
        const loader = document.getElementById('analyticsLoading');
        if (loader) {
            loader.style.display = show ? 'flex' : 'none';
        }
    }

    /**
     * Show error message
     */
    showError(message) {
        const errorDiv = document.getElementById('analyticsError');
        const errorText = document.getElementById('errorText');

        if (errorDiv && errorText) {
            errorText.textContent = message;
            errorDiv.style.display = 'block';

            setTimeout(() => {
                errorDiv.style.display = 'none';
            }, 5000);
        }
    }

    /**
     * Refresh all data and charts
     */
    async refresh() {
        try {
            await this.loadData();
            await this.renderAllCharts();
        } catch (error) {
            console.error('Failed to refresh analytics:', error);
            this.showError('Failed to refresh analytics data');
        }
    }

    /**
     * Start auto-refresh timer
     */
    startAutoRefresh() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }

        this.refreshTimer = setInterval(() => {
            console.log('Auto-refreshing analytics...');
            this.refresh();
        }, this.refreshInterval);
    }

    /**
     * Stop auto-refresh timer
     */
    stopAutoRefresh() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    /**
     * Destroy all charts and cleanup
     */
    destroy() {
        this.stopAutoRefresh();

        Object.values(this.charts).forEach(chart => {
            if (chart) chart.destroy();
        });

        this.charts = {};
        this.cache = { statistics: null, alerts: [], lastUpdate: null };
    }
}

// Export for use in other modules
export default AlertAnalytics;

// Auto-initialize if container exists
if (typeof window !== 'undefined') {
    window.AlertAnalytics = AlertAnalytics;
}
