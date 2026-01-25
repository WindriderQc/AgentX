/**
 * Benchmark Analytics - Batch Comparison
 * Compare batches and export comparison data
 */

import { BENCHMARK_API, lastComparisonData, setLastComparisonData } from './config.js';
import { formatDuration, formatPercent, calculateDelta, getDeltaClass, showToast } from './utils.js';

/**
 * Compare multiple batches
 */
export async function compareBatches() {
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
        setLastComparisonData(data);

        // Show export button
        const exportBtn = document.getElementById('exportComparisonBtn');
        if (exportBtn) exportBtn.style.display = 'inline-block';

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
                        ${data.comparison.map(b => `<td>${formatPercent(b.success_rate)}</td>`).join('')}
                        <td class="${getDeltaClass(data.comparison, 'success_rate')}">
                            ${calculateDelta(data.comparison, 'success_rate')}%
                        </td>
                    </tr>
                    <tr>
                        <td>Avg Quality</td>
                        ${data.comparison.map(b => `<td>${b.avg_quality !== null ? b.avg_quality : 'N/A'}</td>`).join('')}
                        <td class="${getDeltaClass(data.comparison, 'avg_quality')}">
                            ${calculateDelta(data.comparison, 'avg_quality')}
                        </td>
                    </tr>
                    <tr>
                        <td>Avg Composite</td>
                        ${data.comparison.map(b => `<td>${b.avg_composite !== null ? b.avg_composite : 'N/A'}</td>`).join('')}
                        <td class="${getDeltaClass(data.comparison, 'avg_composite')}">
                            ${calculateDelta(data.comparison, 'avg_composite')}
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
 * Export comparison data as CSV
 */
export function exportComparisonCSV() {
    if (!lastComparisonData || !lastComparisonData.comparison) {
        showToast('No comparison data to export', 'warning');
        return;
    }

    const data = lastComparisonData.comparison;
    const headers = ['Metric', ...data.map(b => b.run_name), 'Delta'];
    const rows = [];

    // Helper to get delta
    const getDelta = (field) => calculateDelta(data, field);

    // Total Tests
    rows.push(['Total Tests', ...data.map(b => b.total_tests), getDelta('total_tests')]);

    // Success Rate
    rows.push(['Success Rate', ...data.map(b => b.success_rate + '%'), getDelta('success_rate') + '%']);

    // Avg Quality
    rows.push(['Avg Quality', ...data.map(b => b.avg_quality !== null ? b.avg_quality : 'N/A'), getDelta('avg_quality')]);

    // Avg Composite
    rows.push(['Avg Composite', ...data.map(b => b.avg_composite !== null ? b.avg_composite : 'N/A'), getDelta('avg_composite')]);

    // Duration
    rows.push(['Duration', ...data.map(b => b.execution_metrics?.total_duration_ms ? formatDuration(b.execution_metrics.total_duration_ms) : 'N/A'),
        data[0].execution_metrics && data[1].execution_metrics
            ? formatDuration(Math.abs(data[0].execution_metrics.total_duration_ms - data[1].execution_metrics.total_duration_ms))
            : 'N/A'
    ]);

    // Tests/min
    rows.push(['Tests/min', ...data.map(b => b.execution_metrics?.tests_per_minute || 'N/A'),
        calculateDelta(data.map(b => ({ tests_per_minute: b.execution_metrics?.tests_per_minute || 0 })), 'tests_per_minute')
    ]);

    // Convert to CSV
    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    // Download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `benchmark_comparison_${new Date().toISOString().slice(0,10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}
