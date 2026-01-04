/**
 * Benchmark Analytics Enhancements
 * Provides advanced analytics UI components for benchmark system
 * - Configuration Presets
 * - Real-Time Active Batch Monitoring
 * - Performance Trends Charts
 * - Batch Comparison
 * - Tag Management
 */

const BenchmarkAnalytics = (() => {
    const BENCHMARK_API = '/api/benchmark';
    let pollInterval = null;
    let trendsChart = null;
    let comparisonChart = null;

    /**
     * Initialize all analytics components
     */
    function init() {
        loadPresets();
        startActiveMonitoring();
        loadTrends();
        loadTagStats();
        setupEventListeners();
    }

    /**
     * Setup event listeners
     */
    function setupEventListeners() {
        // Trends time period selector
        const periodSelector = document.getElementById('trendsPeriod');
        if (periodSelector) {
            periodSelector.addEventListener('change', () => loadTrends());
        }

        // Trend model filter
        const modelFilter = document.getElementById('trendsModelFilter');
        if (modelFilter) {
            modelFilter.addEventListener('change', () => loadTrends());
        }

        // Batch comparison selector
        const compareBtn = document.getElementById('compareBatchesBtn');
        if (compareBtn) {
            compareBtn.addEventListener('click', compareBatches);
        }

        // Tag filter chips
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('tag-chip')) {
                const tag = e.target.dataset.tag;
                filterByTag(tag);
            }
        });
    }

    /**
     * Load and display configuration presets
     */
    async function loadPresets() {
        try {
            const res = await fetch(`${BENCHMARK_API}/presets`);
            const { data } = await res.json();

            const container = document.getElementById('presetsContainer');
            if (!container) return;

            container.innerHTML = data.presets.map(preset => `
                <div class="preset-card" data-preset-id="${preset.id}">
                    <div class="preset-header">
                        <h4>${preset.name}</h4>
                        <span class="preset-duration">${preset.estimated_duration}</span>
                    </div>
                    <p class="preset-description">${preset.description}</p>
                    <div class="preset-config">
                        <div class="preset-badge">
                            <i class="fas fa-layer-group"></i> Levels: ${preset.config.levels.join(', ')}
                        </div>
                        <div class="preset-badge">
                            ${preset.config.quality_scoring
                                ? '<i class="fas fa-check-circle"></i> Quality Scoring'
                                : '<i class="fas fa-times-circle"></i> No Scoring'}
                        </div>
                    </div>
                    <div class="preset-recommended">
                        <i class="fas fa-lightbulb"></i> ${preset.recommended_for}
                    </div>
                    <button class="btn-preset" onclick="BenchmarkAnalytics.applyPreset('${preset.id}')">
                        <i class="fas fa-bolt"></i> Use Preset
                    </button>
                </div>
            `).join('');
        } catch (err) {
            console.error('Failed to load presets:', err);
        }
    }

    /**
     * Apply a configuration preset
     */
    async function applyPreset(presetId) {
        try {
            const res = await fetch(`${BENCHMARK_API}/presets`);
            const { data } = await res.json();
            const preset = data.presets.find(p => p.id === presetId);

            if (!preset) return;

            // Apply levels
            [1, 2, 3, 4, 5].forEach(level => {
                const checkbox = document.getElementById(`level${level}`);
                if (checkbox) {
                    checkbox.checked = preset.config.levels.includes(level);
                }
            });

            // Apply quality scoring
            const qualityCheckbox = document.getElementById('enableQualityScoring');
            if (qualityCheckbox) {
                qualityCheckbox.checked = preset.config.quality_scoring;
            }

            // Show confirmation
            showToast(`✓ ${preset.name} preset applied`, 'success');

            // Scroll to batch form
            document.querySelector('.batch-section')?.scrollIntoView({ behavior: 'smooth' });
        } catch (err) {
            console.error('Failed to apply preset:', err);
            showToast('Failed to apply preset', 'error');
        }
    }

    /**
     * Start real-time monitoring of active batches
     */
    function startActiveMonitoring() {
        // Initial load
        loadActiveStats();

        // Poll every 3 seconds
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(loadActiveStats, 3000);
    }

    /**
     * Stop active monitoring
     */
    function stopActiveMonitoring() {
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
    }

    /**
     * Load active batch statistics
     */
    async function loadActiveStats() {
        try {
            const res = await fetch(`${BENCHMARK_API}/active-stats`);
            const { data } = await res.json();

            const container = document.getElementById('activeStatsContainer');
            if (!container) return;

            if (data.active_batches === 0) {
                container.innerHTML = `
                    <div class="no-active-batches">
                        <i class="fas fa-check-circle"></i>
                        <p>No active batches</p>
                    </div>
                `;
                return;
            }

            // Update active batches widget
            container.innerHTML = `
                <div class="active-stats-header">
                    <h3><i class="fas fa-play-circle"></i> Active Batches (${data.active_batches})</h3>
                    ${data.estimated_completion_time ? `
                        <div class="eta-badge">
                            <i class="fas fa-clock"></i>
                            ETA: ${formatDuration(data.estimated_completion_time)}
                        </div>
                    ` : ''}
                </div>
                <div class="active-batches-grid">
                    ${data.batches.map(batch => `
                        <div class="active-batch-card">
                            <div class="batch-name">${batch.run_name}</div>
                            <div class="batch-progress-bar">
                                <div class="progress-fill" style="width: ${batch.progress}%"></div>
                            </div>
                            <div class="batch-stats">
                                <span>${batch.completed} / ${batch.total}</span>
                                <span>${batch.progress.toFixed(1)}%</span>
                                ${batch.eta_ms ? `<span class="eta">${formatDuration(batch.eta_ms)}</span>` : ''}
                            </div>
                            ${batch.judge_progress !== undefined ? `
                                <div class="judge-progress">
                                    <small>Quality Scoring: ${batch.judge_progress.toFixed(0)}%</small>
                                </div>
                            ` : ''}
                        </div>
                    `).join('')}
                </div>
            `;
        } catch (err) {
            console.error('Failed to load active stats:', err);
        }
    }

    /**
     * Load performance trends chart
     */
    async function loadTrends() {
        try {
            const period = document.getElementById('trendsPeriod')?.value || '7';
            const model = document.getElementById('trendsModelFilter')?.value || '';

            const res = await fetch(`${BENCHMARK_API}/trends?days=${period}${model ? `&model=${model}` : ''}`);
            const { data } = await res.json();

            const ctx = document.getElementById('trendsChart');
            if (!ctx) return;

            // Prepare chart data
            const labels = data.trends.map(t => {
                if (t._id.hour !== undefined) {
                    return `${t._id.month}/${t._id.day} ${t._id.hour}:00`;
                }
                return `${t._id.month}/${t._id.day}`;
            });

            const datasets = [
                {
                    label: 'Avg Latency (ms)',
                    data: data.trends.map(t => t.avg_latency),
                    borderColor: '#7CF0FF',
                    backgroundColor: 'rgba(124, 240, 255, 0.1)',
                    yAxisID: 'y',
                    tension: 0.3
                },
                {
                    label: 'Avg Quality Score',
                    data: data.trends.map(t => t.avg_quality || null),
                    borderColor: '#00FF9F',
                    backgroundColor: 'rgba(0, 255, 159, 0.1)',
                    yAxisID: 'y1',
                    tension: 0.3
                },
                {
                    label: 'Tokens/sec',
                    data: data.trends.map(t => t.avg_tokens_per_sec || null),
                    borderColor: '#FF6B9D',
                    backgroundColor: 'rgba(255, 107, 157, 0.1)',
                    yAxisID: 'y1',
                    tension: 0.3
                }
            ];

            // Destroy existing chart
            if (trendsChart) {
                trendsChart.destroy();
            }

            // Create new chart
            trendsChart = new Chart(ctx, {
                type: 'line',
                data: { labels, datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: {
                        mode: 'index',
                        intersect: false
                    },
                    plugins: {
                        legend: {
                            position: 'top',
                            labels: { color: '#E0E7FF' }
                        },
                        title: {
                            display: true,
                            text: `Performance Trends - ${data.model === 'all' ? 'All Models' : data.model}`,
                            color: '#E0E7FF'
                        }
                    },
                    scales: {
                        x: {
                            ticks: { color: '#94A3B8' },
                            grid: { color: 'rgba(255, 255, 255, 0.05)' }
                        },
                        y: {
                            type: 'linear',
                            display: true,
                            position: 'left',
                            title: { display: true, text: 'Latency (ms)', color: '#7CF0FF' },
                            ticks: { color: '#7CF0FF' },
                            grid: { color: 'rgba(124, 240, 255, 0.1)' }
                        },
                        y1: {
                            type: 'linear',
                            display: true,
                            position: 'right',
                            title: { display: true, text: 'Quality / Tokens/sec', color: '#00FF9F' },
                            ticks: { color: '#00FF9F' },
                            grid: { display: false }
                        }
                    }
                }
            });
        } catch (err) {
            console.error('Failed to load trends:', err);
        }
    }

    /**
     * Compare multiple batches
     */
    async function compareBatches() {
        try {
            const checkbox1 = document.getElementById('compareBatch1')?.value;
            const checkbox2 = document.getElementById('compareBatch2')?.value;

            if (!checkbox1 || !checkbox2) {
                showToast('Please select two batches to compare', 'warning');
                return;
            }

            const res = await fetch(`${BENCHMARK_API}/compare-batches`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ batch_ids: [checkbox1, checkbox2] })
            });

            const { data } = await res.json();

            // Display comparison table
            const container = document.getElementById('comparisonResults');
            if (!container) return;

            container.innerHTML = `
                <div class="comparison-stats">
                    <div class="comparison-stat">
                        <div class="stat-label">Avg Duration</div>
                        <div class="stat-value">${formatDuration(data.stats.avg_duration_ms)}</div>
                    </div>
                    ${data.stats.fastest_batch ? `
                        <div class="comparison-stat">
                            <div class="stat-label">Fastest</div>
                            <div class="stat-value">${data.stats.fastest_batch.name}</div>
                            <small>${formatDuration(data.stats.fastest_batch.duration)}</small>
                        </div>
                    ` : ''}
                    ${data.stats.slowest_batch ? `
                        <div class="comparison-stat">
                            <div class="stat-label">Slowest</div>
                            <div class="stat-value">${data.stats.slowest_batch.name}</div>
                            <small>${formatDuration(data.stats.slowest_batch.duration)}</small>
                        </div>
                    ` : ''}
                </div>
                <table class="comparison-table">
                    <thead>
                        <tr>
                            <th>Metric</th>
                            ${data.comparison.map(b => `<th>${b.run_name}</th>`).join('')}
                            <th>Delta</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>Total Tests</td>
                            ${data.comparison.map(b => `<td>${b.total_tests}</td>`).join('')}
                            <td>${calculateDelta(data.comparison, 'total_tests')}</td>
                        </tr>
                        <tr>
                            <td>Success Rate</td>
                            ${data.comparison.map(b => `<td>${b.success_rate}%</td>`).join('')}
                            <td class="${getDeltaClass(data.comparison, 'success_rate')}">
                                ${calculateDelta(data.comparison, 'success_rate')}%
                            </td>
                        </tr>
                        <tr>
                            <td>Duration</td>
                            ${data.comparison.map(b => `
                                <td>${b.execution_metrics?.total_duration_ms
                                    ? formatDuration(b.execution_metrics.total_duration_ms)
                                    : 'N/A'}</td>
                            `).join('')}
                            <td>${data.comparison[0].execution_metrics && data.comparison[1].execution_metrics
                                ? formatDuration(Math.abs(
                                    data.comparison[0].execution_metrics.total_duration_ms -
                                    data.comparison[1].execution_metrics.total_duration_ms
                                  ))
                                : 'N/A'}</td>
                        </tr>
                        <tr>
                            <td>Tests/min</td>
                            ${data.comparison.map(b => `
                                <td>${b.execution_metrics?.tests_per_minute || 'N/A'}</td>
                            `).join('')}
                            <td>${calculateDelta(data.comparison.map(b => ({
                                tests_per_minute: b.execution_metrics?.tests_per_minute || 0
                            })), 'tests_per_minute')}</td>
                        </tr>
                    </tbody>
                </table>
            `;

            container.style.display = 'block';
        } catch (err) {
            console.error('Failed to compare batches:', err);
            showToast('Failed to compare batches', 'error');
        }
    }

    /**
     * Load tag statistics
     */
    async function loadTagStats() {
        try {
            const res = await fetch(`${BENCHMARK_API}/stats-by-tag`);
            const { data } = await res.json();

            const container = document.getElementById('tagStatsContainer');
            if (!container) return;

            if (data.tags.length === 0) {
                container.innerHTML = '<p class="no-data">No tagged batches yet</p>';
                return;
            }

            container.innerHTML = `
                <div class="tag-chips">
                    ${data.tags.map(tag => `
                        <div class="tag-chip" data-tag="${tag.tag}">
                            <span class="tag-name">${tag.tag}</span>
                            <span class="tag-count">${tag.count}</span>
                            <div class="tag-details">
                                <small>✓ ${tag.completed} completed</small>
                                <small>⚡ ${tag.avg_success_rate} success</small>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        } catch (err) {
            console.error('Failed to load tag stats:', err);
        }
    }

    /**
     * Filter batches by tag
     */
    function filterByTag(tag) {
        // TODO: Implement batch filtering by tag
        console.log('Filter by tag:', tag);
        showToast(`Filtering by tag: ${tag}`, 'info');
    }

    /**
     * Calculate delta between two values
     */
    function calculateDelta(items, field) {
        if (items.length < 2) return '0';
        const val1 = parseFloat(items[0][field]) || 0;
        const val2 = parseFloat(items[1][field]) || 0;
        const delta = val2 - val1;
        return delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
    }

    /**
     * Get CSS class for delta (positive/negative)
     */
    function getDeltaClass(items, field) {
        const delta = calculateDelta(items, field);
        return parseFloat(delta) > 0 ? 'delta-positive' : 'delta-negative';
    }

    /**
     * Format duration in ms to human readable
     */
    function formatDuration(ms) {
        if (!ms) return 'N/A';
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}h ${minutes % 60}m`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    /**
     * Show toast notification
     */
    function showToast(message, type = 'info') {
        // Try to use existing toast if available
        if (window.Toast && typeof window.Toast.show === 'function') {
            window.Toast.show(message, type);
            return;
        }

        // Fallback to simple alert
        console.log(`[${type.toUpperCase()}] ${message}`);

        // Create simple toast element
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            background: ${type === 'success' ? '#00FF9F' : type === 'error' ? '#FF6B9D' : '#7CF0FF'};
            color: #0A0E27;
            border-radius: 8px;
            font-weight: 600;
            z-index: 10000;
            animation: slideIn 0.3s ease;
        `;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // Public API
    return {
        init,
        applyPreset,
        loadTrends,
        loadActiveStats,
        loadTagStats,
        compareBatches,
        stopActiveMonitoring
    };
})();

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => BenchmarkAnalytics.init());
} else {
    BenchmarkAnalytics.init();
}
