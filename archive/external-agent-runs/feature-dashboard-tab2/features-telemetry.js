// Mock Data Generator
const generateMockTelemetry = (timeRange) => {
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    const endpointsList = [
        '/api/auth/login', '/api/auth/register', '/api/users/profile', 
        '/api/dashboard/stats', '/api/projects/list', '/api/projects/create',
        '/api/tasks/update', '/api/features/inventory', '/api/features/telemetry',
        '/api/settings/config', '/api/rag/ingest', '/api/rag/query',
        '/api/notifications/mark-read'
    ];
    
    // Add some random/unused endpoints
    const unusedEndpoints = [
        '/api/deprecated/v1/login', '/api/temp/test-endpoint', '/api/admin/bulk-delete'
    ];

    const data = [];
    
    // Generate active endpoints
    endpointsList.forEach(endpoint => {
        const isError = Math.random() > 0.9;
        const isSlow = Math.random() > 0.8;
        
        let hits;
        if (timeRange === '1h') hits = Math.floor(Math.random() * 500);
        else if (timeRange === '6h') hits = Math.floor(Math.random() * 3000);
        else if (timeRange === '24h') hits = Math.floor(Math.random() * 10000);
        else hits = Math.floor(Math.random() * 50000);

        const avgLatency = isSlow ? Math.floor(Math.random() * 1000) + 200 : Math.floor(Math.random() * 150) + 10;
        
        data.push({
            endpoint: endpoint,
            method: methods[Math.floor(Math.random() * methods.length)],
            hits: hits,
            avgLatency: avgLatency,
            p95: Math.floor(avgLatency * 1.5),
            p99: Math.floor(avgLatency * 2.2),
            errors: isError ? Math.floor(hits * (Math.random() * 0.05)) : 0,
            lastCalled: new Date(Date.now() - Math.floor(Math.random() * 1000 * 60 * 60)).toISOString()
        });
    });

    // Generate unused
    unusedEndpoints.forEach(endpoint => {
        data.push({
            endpoint: endpoint,
            method: methods[Math.floor(Math.random() * methods.length)],
            hits: 0,
            avgLatency: 0,
            p95: 0,
            p99: 0,
            errors: 0,
            lastCalled: null
        });
    });

    return data;
};

class TelemetryDashboard {
    constructor() {
        this.data = [];
        this.currentTimeRange = '24h';
        this.autoRefreshInterval = null;
        this.refreshTimer = 30;
        this.charts = {};
        
        this.init();
    }

    init() {
        this.bindEvents();
        this.loadTelemetry('24h');
        this.startAutoRefresh();
    }

    bindEvents() {
        // Time range buttons
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.currentTimeRange = e.target.dataset.time;
                this.loadTelemetry(this.currentTimeRange);
            });
        });

        // Refresh button
        document.getElementById('refresh-btn').addEventListener('click', () => {
             this.loadTelemetry(this.currentTimeRange);
             this.resetAutoRefresh();
        });

        // Auto-refresh toggle
        document.getElementById('auto-refresh-toggle').addEventListener('change', (e) => {
            if (e.target.checked) this.startAutoRefresh();
            else this.stopAutoRefresh();
        });

        // Filters
        document.getElementById('status-filter').addEventListener('change', () => this.applyFilters());
        document.getElementById('sort-filter').addEventListener('change', () => this.applyFilters());

        // Collapsible
        const collapseBtn = document.getElementById('toggle-unused-btn');
        const collapseContent = document.getElementById('unused-content');
        collapseBtn.addEventListener('click', () => {
            collapseBtn.classList.toggle('active');
            if (collapseContent.style.maxHeight) {
                collapseContent.style.maxHeight = null;
            } else {
                collapseContent.style.maxHeight = collapseContent.scrollHeight + "px";
            }
        });
    }

    async loadTelemetry(timeRange) {
        this.showLoading(true);
        
        // Simulate API call delay
        await new Promise(resolve => setTimeout(resolve, 800));
        
        this.data = generateMockTelemetry(timeRange);
        
        this.updateStats();
        this.renderCharts();
        this.applyFilters(); // This calls renderTable
        this.renderUnusedTable();
        
        this.showLoading(false);
    }

    updateStats() {
        const totalRequests = this.data.reduce((sum, item) => sum + item.hits, 0);
        const usedEndpoints = this.data.filter(item => item.hits > 0);
        const avgLatency = usedEndpoints.length ? 
            Math.floor(usedEndpoints.reduce((sum, item) => sum + item.avgLatency, 0) / usedEndpoints.length) : 0;
        
        const totalErrors = this.data.reduce((sum, item) => sum + item.errors, 0);
        const errorRate = totalRequests ? ((totalErrors / totalRequests) * 100).toFixed(2) : 0;
        const unusedCount = this.data.filter(item => item.hits === 0).length;

        document.getElementById('stat-total-requests').textContent = totalRequests.toLocaleString();
        document.getElementById('stat-avg-latency').textContent = avgLatency;
        document.getElementById('stat-error-rate').textContent = errorRate;
        document.getElementById('stat-unused').textContent = unusedCount;
    }

    applyFilters() {
        const statusFilter = document.getElementById('status-filter').value;
        const sortFilter = document.getElementById('sort-filter').value;

        let filtered = [...this.data];

        // Filter valid endpoints (not unused) for main table, unless 'unused' status specifically requested
        if (statusFilter !== 'unused') {
            filtered = filtered.filter(item => item.hits > 0);
        }

        // Apply Status Filter
        if (statusFilter === 'slow') {
            filtered = filtered.filter(item => item.avgLatency > 100);
        } else if (statusFilter === 'errors') {
            filtered = filtered.filter(item => item.errors > 0);
        } else if (statusFilter === 'unused') {
            filtered = filtered.filter(item => item.hits === 0);
        }

        // Apply Sort
        filtered.sort((a, b) => {
            if (sortFilter === 'hits') return b.hits - a.hits;
            if (sortFilter === 'latency') return b.avgLatency - a.avgLatency;
            if (sortFilter === 'errors') return b.errors - a.errors;
            return 0;
        });

        this.renderTable(filtered);
    }

    renderTable(data) {
        const tbody = document.getElementById('telemetry-table-body');
        tbody.innerHTML = '';

        if (data.length === 0) {
            document.getElementById('empty-state').classList.remove('hidden');
            return;
        } else {
            document.getElementById('empty-state').classList.add('hidden');
        }

        data.forEach(item => {
            let latencyClass = 'latency-green';
            if (item.hits === 0) latencyClass = 'latency-gray';
            else if (item.avgLatency > 500) latencyClass = 'latency-red';
            else if (item.avgLatency > 100) latencyClass = 'latency-yellow';

            const methodClass = `method-${item.method}`;
            
            // Format time
            let timeDisplay = 'Never';
            if (item.lastCalled) {
                const date = new Date(item.lastCalled);
                const now = new Date();
                const diffMins = Math.floor((now - date) / 60000);
                if (diffMins < 60) timeDisplay = `${diffMins}m ago`;
                else if (diffMins < 1440) timeDisplay = `${Math.floor(diffMins/60)}h ago`;
                else timeDisplay = date.toLocaleDateString();
            }

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><code>${item.endpoint}</code></td>
                <td><span class="method-badge ${methodClass}">${item.method}</span></td>
                <td>${item.hits.toLocaleString()}</td>
                <td><span class="latency-badge ${latencyClass}">${item.avgLatency}ms</span></td>
                <td>${item.p95}ms</td>
                <td>${item.p99}ms</td>
                <td>${item.errors > 0 ? `<span style="color:var(--danger-color)">${item.errors}</span>` : '0'}</td>
                <td>${timeDisplay}</td>
                <td>${item.hits === 0 ? 'Unused' : (item.errors > 0 ? '⚠ Check' : 'Active')}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    renderUnusedTable() {
        const tbody = document.getElementById('unused-table-body');
        tbody.innerHTML = '';
        
        const unused = this.data.filter(item => item.hits === 0);
        
        unused.forEach(item => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><code>${item.endpoint}</code></td>
                <td>Never</td>
                <td>Consider deprecating</td>
            `;
            tbody.appendChild(tr);
        });
    }

    renderCharts() {
        this.destroyCharts();

        const activeData = this.data.filter(d => d.hits > 0);

        // 1. Top 10 Endpoints (Bar)
        const top10 = [...activeData].sort((a,b) => b.hits - a.hits).slice(0, 10);
        const ctx1 = document.getElementById('topEndpointsChart').getContext('2d');
        this.charts.top = new Chart(ctx1, {
            type: 'bar',
            data: {
                labels: top10.map(d => d.endpoint),
                datasets: [{
                    label: 'Hits',
                    data: top10.map(d => d.hits),
                    backgroundColor: '#0066cc',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: { display: true, text: 'Top 10 Endpoints by Hits' },
                    legend: { display: false }
                },
                scales: {
                    x: { ticks: { display: false } } // Hide labels if too long
                }
            }
        });

        // 2. Latency Distribution (Histogram approx)
        const buckets = { '0-50ms': 0, '50-100ms': 0, '100-200ms': 0, '200-500ms': 0, '500ms+': 0 };
        activeData.forEach(d => {
            if (d.avgLatency <= 50) buckets['0-50ms']++;
            else if (d.avgLatency <= 100) buckets['50-100ms']++;
            else if (d.avgLatency <= 200) buckets['100-200ms']++;
            else if (d.avgLatency <= 500) buckets['200-500ms']++;
            else buckets['500ms+']++;
        });

        const ctx2 = document.getElementById('latencyDistChart').getContext('2d');
        this.charts.latency = new Chart(ctx2, {
            type: 'bar',
            data: {
                labels: Object.keys(buckets),
                datasets: [{
                    label: 'Count',
                    data: Object.values(buckets),
                    backgroundColor: [
                        '#28a745', '#28a745', '#ffc107', '#fd7e14', '#dc3545'
                    ],
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: { display: true, text: 'Avg Latency Distribution' },
                    legend: { display: false }
                }
            }
        });

        // 3. Error Rate (Mock Trend)
        const ctx3 = document.getElementById('errorRateChart').getContext('2d');
        // Generate mock hourly trend
        const hours = Array.from({length: 12}, (_, i) => `${i*2}h`);
        const errorTrend = hours.map(() => Math.random() * 2); 
        
        this.charts.errors = new Chart(ctx3, {
            type: 'line',
            data: {
                labels: hours,
                datasets: [{
                    label: 'Error Rate %',
                    data: errorTrend,
                    borderColor: '#dc3545',
                    tension: 0.4,
                    fill: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: { display: true, text: 'Error Rate Trend (Last 24h)' }
                },
                scales: {
                    y: { beginAtZero: true }
                }
            }
        });
    }

    destroyCharts() {
        if (this.charts.top) this.charts.top.destroy();
        if (this.charts.latency) this.charts.latency.destroy();
        if (this.charts.errors) this.charts.errors.destroy();
    }

    showLoading(isLoading) {
        const loader = document.getElementById('loading-indicator');
        const tableBody = document.getElementById('telemetry-table-body');
        
        if (isLoading) {
            loader.classList.remove('hidden');
            tableBody.style.opacity = '0.5';
        } else {
            loader.classList.add('hidden');
            tableBody.style.opacity = '1';
        }
    }

    startAutoRefresh() {
        if (this.autoRefreshInterval) clearInterval(this.autoRefreshInterval);
        
        const updateTimer = () => {
            this.refreshTimer--;
            document.getElementById('refresh-timer').textContent = this.refreshTimer;
            if (this.refreshTimer <= 0) {
                this.loadTelemetry(this.currentTimeRange);
                this.refreshTimer = 30;
            }
        };

        this.autoRefreshInterval = setInterval(updateTimer, 1000);
    }

    stopAutoRefresh() {
        if (this.autoRefreshInterval) clearInterval(this.autoRefreshInterval);
    }

    resetAutoRefresh() {
        this.refreshTimer = 30;
        document.getElementById('refresh-timer').textContent = 30;
        if (document.getElementById('auto-refresh-toggle').checked) {
            this.startAutoRefresh();
        }
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    new TelemetryDashboard();
});
