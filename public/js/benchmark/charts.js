// charts.js - Chart setup and updates

import * as state from './state.js';

/**
 * Disable Chart.js animations globally
 */
export function initChartDefaults() {
    if (typeof Chart !== 'undefined') {
        Chart.defaults.animation = false;
        Chart.defaults.animations = { colors: false, x: false };
        Chart.defaults.transitions = { active: { animation: { duration: 0 } } };
    }
}

/**
 * Create or update the latency chart
 */
export function setupLatencyChart(ctx, data) {
    if (state.latencyChart) {
        state.latencyChart.data = data;
        state.latencyChart.update();
    } else {
        const chart = new Chart(ctx, {
            type: 'bar',
            data: data,
            options: getChartOptions('Latency (ms)')
        });
        state.setLatencyChart(chart);
    }
}

/**
 * Create or update the tokens chart
 */
export function setupTokensChart(ctx, data) {
    if (state.tokensChart) {
        state.tokensChart.data = data;
        state.tokensChart.update();
    } else {
        const chart = new Chart(ctx, {
            type: 'bar',
            data: data,
            options: getChartOptions('Tokens/sec')
        });
        state.setTokensChart(chart);
    }
}

/**
 * Create or update the quality chart
 */
export function setupQualityChart(ctx, data) {
    if (state.qualityChart) {
        state.qualityChart.data = data;
        state.qualityChart.update();
    } else {
        const chart = new Chart(ctx, {
            type: 'bar',
            data: data,
            options: getChartOptions('Quality Score')
        });
        state.setQualityChart(chart);
    }
}

/**
 * Create or update the composite chart
 */
export function setupCompositeChart(ctx, data) {
    if (state.compositeChart) {
        state.compositeChart.data = data;
        state.compositeChart.update();
    } else {
        const chart = new Chart(ctx, {
            type: 'bar',
            data: data,
            options: getChartOptions('Composite Score')
        });
        state.setCompositeChart(chart);
    }
}

/**
 * Get common chart options
 */
function getChartOptions(title) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                display: false
            },
            title: {
                display: true,
                text: title,
                color: 'rgba(255, 255, 255, 0.9)'
            }
        },
        scales: {
            x: {
                ticks: {
                    color: 'rgba(255, 255, 255, 0.7)'
                },
                grid: {
                    color: 'rgba(255, 255, 255, 0.1)'
                }
            },
            y: {
                ticks: {
                    color: 'rgba(255, 255, 255, 0.7)'
                },
                grid: {
                    color: 'rgba(255, 255, 255, 0.1)'
                }
            }
        }
    };
}

/**
 * Highlight a chart temporarily
 */
export function highlightChart(chart) {
    if (!state.chartsInitialized) return;

    if (state.chartHighlightTimeout) {
        clearTimeout(state.chartHighlightTimeout);
    }

    // Add highlight effect
    if (chart && chart.canvas) {
        chart.canvas.style.boxShadow = '0 0 20px rgba(124, 240, 255, 0.5)';

        const timeout = setTimeout(() => {
            chart.canvas.style.boxShadow = 'none';
        }, 500);
        state.setChartHighlightTimeout(timeout);
    }
}
