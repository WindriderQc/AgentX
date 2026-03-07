// batch-execution.js - runBatch, pollBatchProgress orchestration

import * as state from './state.js';
import { getWorkspaceHeaders } from './api.js';
import { startBatchTest, stopBatchTest, fetchBatchProgress, fetchActiveBatches, recoverBatchApi, fetchBatchHistory, validateJudgeModelApi } from './api.js';
import { renderBatchPlan, setAdvancedMode, setHyperMode, getAnomalyThresholds, hydrateThresholdInputs, bindThresholdInputs, getDepthConfig, getSelectedLevels } from './batch-config.js';
import { escapeHtml, formatDuration, toFiniteNumber, summarizeNumbers, countBy, topCounts, formatHostLabel, findRowByAttr } from './utils.js';
import { updateTimeline, resetTimelineState } from './timeline.js';
import { pickRepresentativeResultId, pickRepresentativeResultIdForModel } from './results-analysis.js';
import { showJudgeDetails } from './judge-details.js';
import { buildBatchScoringBar } from './results-table.js';

/**
 * Load batch history
 */
export async function loadBatchHistory() {
    const container = document.getElementById('batchHistoryList');
    if (!container) return;

    try {
        const json = await fetchBatchHistory();

        if (json.status === 'success' && json.data.batches) {
            if (json.data.batches.length === 0) {
                container.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 15px;">No previous batches found</div>';
                return;
            }

            const recentBatches = json.data.batches.slice(0, 5);

            container.innerHTML = recentBatches.map(b => {
                const date = new Date(b.created_at).toLocaleString();
                const statusColor = b.status === 'completed' ? '#2ecc71' : (b.status === 'failed' ? '#e74c3c' : '#f1c40f');

                return `
                    <div class="history-item" style="padding: 12px; border: 1px solid var(--panel-border); border-radius: 8px; background: rgba(0,0,0,0.14);">
                        <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px;">
                            <div style="font-weight: 600; color: var(--text);">${b.run_name || 'Untitled Batch'}</div>
                            <div style="font-size: 0.8em; color: ${statusColor}; text-transform: capitalize; white-space: nowrap;">${b.status}</div>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px; gap: 12px; flex-wrap: wrap;">
                            <div style="font-size: 0.85em; color: var(--muted);">
                                ${b.models ? b.models.length : 0} models - ${b.total_tests || 0} tests
                            </div>
                            <div style="font-size: 0.8em; color: var(--muted);">
                                ${date}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }
    } catch (err) {
        console.error('Failed to load history:', err);
        container.innerHTML = '<div style="text-align: center; color: #e74c3c; padding: 15px;">Failed to load history</div>';
    }
}

// Expose to window for legacy code and onclick handlers
if (typeof window !== 'undefined') {
    window.showJudgeDetails = showJudgeDetails;
    window.recoverBatch = recoverBatch;
}
