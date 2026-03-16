/**
 * Benchmark Analytics - Trends & Timeline
 * Performance trends charts, timeline visualization, and batch history
 */

import { BENCHMARK_API, chartInstances, currentFilters } from './config.js';
import { formatDuration, escapeHtml, showToast } from './utils.js';

/**
 * Load performance trends chart
 */
export async function loadTrends() {
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
                label: 'Avg Quality Score (x10)',
                data: data.trends.map(t => t.avg_quality ? t.avg_quality * 10 : null),
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
        if (chartInstances.trendsChart) {
            chartInstances.trendsChart.destroy();
        }

        // Create new chart
        chartInstances.trendsChart = new Chart(ctx, {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
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
 * Load and render execution timeline for a batch
 */
export async function loadTimeline(batchId) {
    const container = document.getElementById('timelineContainer');
    const emptyState = document.getElementById('timelineEmptyState');
    const canvas = document.getElementById('timelineChart');

    if (!batchId) {
        if (container) container.style.display = 'none';
        if (emptyState) emptyState.style.display = 'block';
        return;
    }

    try {
        const res = await fetch(`${BENCHMARK_API}/batch/${batchId}/timeline`);
        const json = await res.json();

        if (!json.data || !json.data.timeline) {
           throw new Error('No timeline data found');
        }

        const timeline = json.data.timeline;

        if (container) container.style.display = 'block';
        if (emptyState) emptyState.style.display = 'none';

        if (!canvas) return;

        // Filter for completed tests and judges which have duration
        const tasks = timeline.filter(e => (e.event === 'test_complete' || e.event === 'judge_complete') && e.duration_ms);

        // Create data points [start, end]
        const chartData = tasks.map((t, index) => {
            const end = t.time_since_start_ms;
            const start = Math.max(0, end - t.duration_ms);
            // Use prompt text or ID for label if available, otherwise generic
            let label = `Task ${index + 1}`;
            if (t.event === 'judge_complete') label += ' (Judge)';

            return {
                x: [start, end],
                y: label,
                type: t.event === 'test_complete' ? 'Test' : 'Judge',
                details: t
            };
        });

        if (chartInstances.timelineChart) {
            chartInstances.timelineChart.destroy();
        }

        chartInstances.timelineChart = new Chart(canvas, {
            type: 'bar',
            data: {
                labels: chartData.map(d => d.y),
                datasets: [
                    {
                        label: 'Execution Duration',
                        data: chartData.map(d => d.x),
                        backgroundColor: chartData.map(d => d.type === 'Test' ? 'rgba(124, 240, 255, 0.6)' : 'rgba(255, 107, 157, 0.6)'),
                        borderColor: chartData.map(d => d.type === 'Test' ? '#7CF0FF' : '#FF6B9D'),
                        borderWidth: 1,
                        borderSkipped: false,
                        barPercentage: 0.8,
                        categoryPercentage: 0.8
                    }
                ]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const raw = context.raw; // [start, end]
                                const duration = raw[1] - raw[0];
                                const item = chartData[context.dataIndex];
                                return `${item.type}: ${duration.toFixed(0)}ms (Start: ${raw[0].toFixed(0)}ms)`;
                            }
                        }
                    },
                    title: {
                        display: true,
                        text: `Timeline - ${json.data.batch_id}`,
                        color: '#E0E7FF'
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        position: 'bottom',
                        title: { display: true, text: 'Time since start (ms)', color: '#94A3B8' },
                        ticks: { color: '#94A3B8' },
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        min: 0
                    },
                    y: {
                        ticks: {
                            color: '#E0E7FF',
                            font: { size: 10 }
                        },
                        grid: { color: 'rgba(255, 255, 255, 0.05)' }
                    }
                }
            }
        });

    } catch (err) {
        console.error('Failed to load timeline:', err);
        // Don't overwrite container if it failed, just log
    }
}

/**
 * Load batch history for dropdowns
 */
export async function loadBatchHistory() {
    try {
        const res = await fetch(`${BENCHMARK_API}/batches?limit=50`);
        const json = await res.json();
        const batches = json.data?.batches || [];

        const populate = (id) => {
            const el = document.getElementById(id);
            if (!el) return;
            const current = el.value;
            el.innerHTML = '<option value="">Select batch...</option>' +
                batches.map(b => `<option value="${b._id}">${b.run_name || 'Batch ' + b._id.substring(0,8)} (${new Date(b.started_at).toLocaleString()})</option>`).join('');
            if (current) el.value = current;
        };

        populate('compareBatch1');
        populate('compareBatch2');
        populate('timelineBatchSelect');

    } catch (err) {
        console.error('Failed to load batch history:', err);
    }
}

/**
 * Load tag statistics
 */
export async function loadTagStats() {
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
                ${data.tags.map(tag => {
                    const isActive = currentFilters.tag === tag.tag;
                    return `
                    <div class="tag-chip ${isActive ? 'active' : ''}"
                         data-tag="${tag.tag}"
                         onclick="BenchmarkAnalytics.filterByTag('${tag.tag}')"
                         style="${isActive ? 'border-color: var(--accent); background: rgba(124, 240, 255, 0.1);' : ''}">
                        <span class="tag-name">${tag.tag}</span>
                        <span class="tag-count">${tag.count}</span>
                        <div class="tag-details">
                            <small>${tag.completed} completed</small>
                            <small>${tag.avg_success_rate} exec success</small>
                        </div>
                    </div>
                `}).join('')}
            </div>
        `;
    } catch (err) {
        console.error('Failed to load tag stats:', err);
    }
}

/**
 * Filter batches by tag
 */
export function filterByTag(tag) {
    currentFilters.tag = tag;
    showToast(`Filtering by tag: ${tag}`, 'info');
    if (window.loadDashboard) window.loadDashboard();
}

/**
 * Filter by model category
 */
export function filterByModelCategory(category) {
    currentFilters.modelCategory = category || null;
    if (window.loadDashboard) window.loadDashboard();
}

/**
 * Filter by prompt category
 */
export function filterByPromptCategory(category) {
    currentFilters.promptCategory = category || null;
    if (window.loadDashboard) window.loadDashboard();
}

/**
 * Get active filters
 */
export function getActiveFilters() {
    return currentFilters;
}

/**
 * Clear all filters
 */
export function clearAllFilters() {
    currentFilters.modelCategory = null;
    currentFilters.promptCategory = null;
    currentFilters.tag = null;
    currentFilters.sort = 'composite';
    const modelFilter = document.getElementById('modelCategoryFilter');
    if (modelFilter) modelFilter.value = '';
    const promptFilter = document.getElementById('promptCategoryFilter');
    if (promptFilter) promptFilter.value = '';
    if (window.loadDashboard) window.loadDashboard();
}
