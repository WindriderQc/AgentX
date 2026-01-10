/**
 * Feature Adoption Tab Logic
 * Handles data fetching, rendering, and interactions for Tab 3
 */

(function() {
    // State
    const state = {
        features: [], // All loaded features
        filters: {
            timeRange: '30d',
            category: 'all',
            minAdoption: 0
        },
        charts: {} // Store chart instances
    };

    // Mock Data Generator
    function generateMockData(timeRange) {
        const categories = ['core', 'analytics', 'operations', 'experimental'];
        const featureNames = [
            'RAG Upload', 'Cost Analytics', 'Model Comparison', 'Voice Input',
            'Workflow Gen', 'User Onboarding', 'API Keys', 'Team Settings',
            'Audit Logs', 'Notification Center', 'Dark Mode', 'Search Global',
            'Export PDF', 'Share Report', 'Invite Member', 'SSO Login',
            'Billing Dashboard', 'Support Ticket', 'Feedback Widget', 'Docs Viewer',
            'Playground', 'Prompt Library', 'History', 'Favorites',
            'Web Search', 'Image Gen', 'Code Interpreter', 'Data Connectors',
            'Slack Integration', 'Email Digest', 'Alerts', 'Mobile View',
            'Tablet View', 'Shortcuts', 'Command Palette'
        ]; // 35 features + I'll generate more to reach ~45

        const data = featureNames.map((name, i) => {
            const category = categories[Math.floor(Math.random() * categories.length)];
            const totalUsers = Math.floor(Math.random() * 500) + 50; // Random user base
            const adoptionRate = Math.floor(Math.random() * 100);
            
            // Correlate adoption with status
            let status = 'weak';
            if (adoptionRate > 50) status = 'strong';
            else if (adoptionRate >= 20) status = 'moderate';
            if (adoptionRate === 0) status = 'unused';

            // Trend (-20% to +20%)
            const trend = Math.floor(Math.random() * 41) - 20;
            
            // Duration (0.5 to 10 min)
            const duration = (Math.random() * 9.5 + 0.5).toFixed(1);

            return {
                id: `feat-${i}`,
                feature: name,
                page: name.toLowerCase().replace(/ /g, '-') + '.html',
                category: category,
                metrics: {
                    totalUsers: totalUsers,
                    activeUsers: Math.round(totalUsers * (adoptionRate / 100)),
                    adoptionRate: adoptionRate,
                    trend: trend,
                    avgDuration: parseFloat(duration),
                    lastWeekAdoption: Math.max(0, adoptionRate - trend) // approx
                },
                history: Array.from({length: 7}, () => Math.floor(Math.random() * 100)) // 7d history
            };
        });

        // Add some specifically requested edge cases
        data.push({
            id: 'feat-voice',
            feature: 'Voice Input',
            page: '-',
            category: 'operations',
            metrics: { totalUsers: 200, activeUsers: 0, adoptionRate: 0, trend: 0, avgDuration: 0, lastWeekAdoption: 0 },
            history: [0,0,0,0,0,0,0]
        });

        return data;
    }

    // Initialization
    function init() {
        console.log('Features Adoption Tab Initializing...');
        
        // Attach event listeners
        document.getElementById('filter-time-range').addEventListener('change', (e) => {
            state.filters.timeRange = e.target.value;
            loadAdoption();
        });
        document.getElementById('filter-category').addEventListener('change', (e) => {
            state.filters.category = e.target.value;
            applyFilters();
        });
        document.getElementById('filter-min-adoption').addEventListener('change', (e) => {
            state.filters.minAdoption = parseInt(e.target.value);
            applyFilters();
        });

        // Initial Load
        loadAdoption();
    }

    // Load Data
    function loadAdoption() {
        showLoading(true);
        
        // Simulate API call
        setTimeout(() => {
            const rawData = generateMockData(state.filters.timeRange);
            state.features = rawData;
            
            applyFilters(); // Renders everything
            showLoading(false);
        }, 800);
    }

    function showLoading(isLoading) {
        const tbody = document.getElementById('adoption-table-body');
        if (isLoading) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center p-4"><div class="spinner-border text-primary" role="status"></div><span class="ms-2">Loading metrics...</span></td></tr>';
        }
    }

    // Apply Filters & Render
    function applyFilters() {
        const { category, minAdoption } = state.filters;
        
        const filtered = state.features.filter(f => {
            const catMatch = category === 'all' || f.category === category;
            const adoptMatch = f.metrics.adoptionRate >= minAdoption;
            return catMatch && adoptMatch;
        });

        renderStats(filtered);
        renderTable(filtered);
        renderCharts(filtered);
        generateInsights(filtered);
    }

    // Render Stats Cards
    function renderStats(features) {
        const total = features.length;
        const adopted = features.filter(f => f.metrics.adoptionRate > 50).length;
        const under = features.filter(f => f.metrics.adoptionRate < 10).length;
        
        const avgDur = features.reduce((acc, curr) => acc + curr.metrics.avgDuration, 0) / (total || 1);

        updateElement('stat-total-features', total);
        updateElement('stat-adopted', adopted);
        updateElement('stat-underutilized', under);
        updateElement('stat-avg-engagement', avgDur.toFixed(1) + 'm');
    }

    function updateElement(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    // Render Table
    function renderTable(features) {
        const tbody = document.getElementById('adoption-table-body');
        if (!tbody) return;

        tbody.innerHTML = '';

        if (features.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center p-3 text-muted">No features match the current filters.</td></tr>';
            return;
        }

        // Sort by adoption rate desc by default
        const sorted = [...features].sort((a, b) => b.metrics.adoptionRate - a.metrics.adoptionRate);

        sorted.forEach(f => {
            const tr = document.createElement('tr');
            
            // Trend Icon
            let trendIcon = '→';
            let trendClass = 'trend-stable';
            let trendVal = f.metrics.trend;

            if (trendVal > 0) { trendIcon = '↑'; trendClass = 'trend-up'; }
            if (trendVal < 0) { trendIcon = '↓'; trendClass = 'trend-down'; }

            // Status Badge
            let badgeClass = 'status-unused';
            let badgeText = 'Unused';
            if (f.metrics.adoptionRate > 50) { badgeClass = 'status-strong'; badgeText = 'Strong'; }
            else if (f.metrics.adoptionRate >= 20) { badgeClass = 'status-moderate'; badgeText = 'Moderate'; }
            else if (f.metrics.adoptionRate > 0) { badgeClass = 'status-weak'; badgeText = 'Weak'; }

            tr.innerHTML = `
                <td>
                    <div class="fw-bold">${f.feature}</div>
                    <small class="text-muted">${f.category}</small>
                </td>
                <td><code class="small text-muted">${f.page}</code></td>
                <td>${f.metrics.activeUsers} / ${f.metrics.totalUsers}</td>
                <td>
                    <div class="d-flex align-items-center">
                        <div class="progress flex-grow-1 me-2" style="height: 6px; width: 60px;">
                            <div class="progress-bar ${getProgressBarColor(f.metrics.adoptionRate)}" role="progressbar" style="width: ${f.metrics.adoptionRate}%"></div>
                        </div>
                        <span>${f.metrics.adoptionRate}%</span>
                    </div>
                </td>
                <td>
                    <span class="trend-indicator ${trendClass}">
                        ${trendIcon} ${trendVal > 0 ? '+' : ''}${trendVal}%
                    </span>
                </td>
                <td>${f.metrics.avgDuration}m</td>
                <td><span class="badge badge-status ${badgeClass}">${badgeText}</span></td>
            `;
            tbody.appendChild(tr);
        });
    }

    function getProgressBarColor(rate) {
        if (rate > 50) return 'bg-success';
        if (rate >= 20) return 'bg-warning';
        return 'bg-danger';
    }

    // Render Charts
    function renderCharts(features) {
        if (typeof Chart === 'undefined') {
            console.warn('Chart.js not found. Skipping charts.');
            return;
        }

        renderCategoryChart(features);
        renderTrendChart(features);
        renderHeatmap(features); // Using custom grid implementation
    }

    function renderCategoryChart(features) {
        const ctx = document.getElementById('chart-category-dist');
        if (!ctx) return;

        // Group by category, sum adoption (or count)
        const catMap = {};
        features.forEach(f => {
            catMap[f.category] = (catMap[f.category] || 0) + 1;
        });

        const labels = Object.keys(catMap);
        const data = Object.values(catMap);

        if (state.charts.category) state.charts.category.destroy();

        state.charts.category = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: ['#4e73df', '#1cc88a', '#36b9cc', '#f6c23e'],
                    hoverBackgroundColor: ['#2e59d9', '#17a673', '#2c9faf', '#dda20a'],
                    hoverBorderColor: "rgba(234, 236, 244, 1)",
                }],
            },
            options: {
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom' }
                },
                cutout: '70%',
            },
        });
    }

    function renderTrendChart(features) {
        const ctx = document.getElementById('chart-adoption-trends');
        if (!ctx) return;

        // Take top 5 features by adoption
        const top5 = [...features]
            .sort((a, b) => b.metrics.adoptionRate - a.metrics.adoptionRate)
            .slice(0, 5);

        const labels = Array.from({length: 7}, (_, i) => `Day ${i+1}`); // 7 days
        
        const datasets = top5.map((f, i) => {
            const colors = ['#4e73df', '#1cc88a', '#36b9cc', '#f6c23e', '#e74a3b'];
            return {
                label: f.feature,
                data: f.history, // Mock 7d history
                borderColor: colors[i % colors.length],
                fill: false,
                tension: 0.3
            };
        });

        if (state.charts.trends) state.charts.trends.destroy();

        state.charts.trends = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: datasets
            },
            options: {
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true, max: 100 }
                },
                plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 10 } }
                }
            }
        });
    }

    function renderHeatmap(features) {
        const container = document.getElementById('heatmap-container');
        if (!container) return;

        // Destroy canvas if it exists, replace with custom grid
        container.innerHTML = '';
        
        const grid = document.createElement('div');
        grid.className = 'heatmap-grid';
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = '40px repeat(24, 1fr)';
        grid.style.gridTemplateRows = 'repeat(7, 1fr)';
        grid.style.gap = '2px';
        grid.style.height = '100%';

        const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

        days.forEach(day => {
            // Label
            const label = document.createElement('div');
            label.className = 'heatmap-label';
            label.textContent = day;
            label.style.fontSize = '10px';
            grid.appendChild(label);

            // 24 Cells
            for (let h = 0; h < 24; h++) {
                const cell = document.createElement('div');
                cell.className = 'heatmap-cell';
                
                // Random intensity
                const intensity = Math.random();
                // Blue scaling
                cell.style.backgroundColor = `rgba(78, 115, 223, ${intensity * 0.8 + 0.1})`;
                cell.title = `${day} ${h}:00 - Intensity: ${(intensity * 100).toFixed(0)}%`;
                
                grid.appendChild(cell);
            }
        });

        container.appendChild(grid);
    }

    // Automated Insights
    function generateInsights(features) {
        const list = document.getElementById('insights-list');
        if (!list) return;

        list.innerHTML = '';
        const insights = [];

        // 1. Spikes
        const spiked = features.filter(f => f.metrics.trend > 15);
        if (spiked.length) {
            spiked.slice(0, 3).forEach(f => {
                insights.push({
                    type: 'positive',
                    text: `<strong>${f.feature}</strong> adoption grew by ${f.metrics.trend}% this week.`
                });
            });
        }

        // 2. Underutilized
        const dead = features.filter(f => f.metrics.adoptionRate === 0 && f.metrics.totalUsers > 0);
        if (dead.length) {
            insights.push({
                type: 'negative',
                text: `<strong>${dead.length} features</strong> have 0 active users (e.g., ${dead[0].feature}). Consider deprecation.`
            });
        }

        // 3. Dropoffs
        const dropping = features.filter(f => f.metrics.trend < -10);
        if (dropping.length) {
            dropping.slice(0, 2).forEach(f => {
                insights.push({
                    type: 'negative',
                    text: `<strong>${f.feature}</strong> usage dropped by ${Math.abs(f.metrics.trend)}%. Investigation recommended.`
                });
            });
        }

        // 4. Stable/Good
        const winners = features.filter(f => f.metrics.adoptionRate > 70);
        if (winners.length) {
            insights.push({
                type: 'neutral',
                text: `<strong>${winners.length} features</strong> are performing exceptionally well (>70% adoption).`
            });
        }

        // Render
        if (insights.length === 0) {
            list.innerHTML = '<p class="text-muted">No significant insights found for this period.</p>';
            return;
        }

        insights.forEach(ins => {
            const div = document.createElement('div');
            div.className = `insight-item insight-${ins.type}`;
            div.innerHTML = ins.text;
            list.appendChild(div);
        });
    }

    // Export to global scope
    window.featuresAdoption = {
        loadAdoption: loadAdoption,
        applyFilters: applyFilters
    };

    // Auto-init if DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
