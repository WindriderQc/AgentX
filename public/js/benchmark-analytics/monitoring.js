/**
 * Benchmark Analytics - Active Monitoring
 * Real-time monitoring of active batches
 */

import { PollingController } from '../utils/polling-controller.js';
import { BENCHMARK_API, poller, setPoller } from './config.js';
import { formatDuration } from './utils.js';

/**
 * Start real-time monitoring of active batches
 */
export function startActiveMonitoring() {
    // Initial load
    loadActiveStats();

    // Poll every 3 seconds (pause-on-blur via shared controller)
    if (poller) poller.destroy();
    const newPoller = new PollingController();
    newPoller.addTask('active-batches', loadActiveStats, 3000, { runOnStart: false });
    newPoller.start();
    setPoller(newPoller);
}

/**
 * Stop active monitoring
 */
export function stopActiveMonitoring() {
    if (poller) {
        poller.destroy();
        setPoller(null);
    }
}

/**
 * Load active batch statistics
 */
export async function loadActiveStats() {
    try {
        const res = await fetch(`${BENCHMARK_API}/active-stats`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { data } = await res.json();

        const container = document.getElementById('activeStatsContainer');
        if (!container) return;

        if (data.active_batches === 0) {
            container.innerHTML = `
                <div class="no-active-batches">
                    <i class="fas fa-check-circle"></i>
                    <p>No active batches</p>
                    <button class="btn-secondary btn-sm" onclick="document.querySelector('.batch-section')?.scrollIntoView({ behavior: 'smooth' })" style="margin-top: 12px;">
                        <i class="fas fa-plus"></i> Start New Batch
                    </button>
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
                            <div class="batch-progress-fill" style="width: ${batch.progress}%"></div>
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
