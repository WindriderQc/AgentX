// recent-tests.js - Recent tests panel, filters

import * as state from './state.js';
import { escapeHtml, toFiniteNumber, formatHostLabel } from './utils.js';

/**
 * Render recent tests panel
 */
export function renderRecentTests(tests) {
    const container = document.getElementById('recentTestsContainer');
    if (!container) return;

    state.setLastRecentTests(tests);

    if (!tests || tests.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 20px;">No recent tests</div>';
        return;
    }

    // Get filter values
    const failuresOnly = document.getElementById('recentTestsFailuresOnly')?.checked || false;
    const modelFilter = document.getElementById('recentTestsModelFilter')?.value || '';

    // Apply filters
    let filtered = [...tests];

    if (failuresOnly) {
        filtered = filtered.filter(t => t.success === false);
    }

    if (modelFilter) {
        filtered = filtered.filter(t => t.model === modelFilter);
    }

    // Update model filter dropdown
    updateModelFilterDropdown(tests);

    if (filtered.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 20px;">No tests match filters</div>';
        return;
    }

    // Sort by timestamp (most recent first)
    filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Limit to recent 50
    const displayed = filtered.slice(0, 50);

    container.innerHTML = displayed.map(test => {
        const isFailed = test.success === false;
        const qualityScore = test.quality_score;
        const hasQuality = qualityScore !== undefined && qualityScore !== null;

        let qualityBadge = '';
        if (hasQuality) {
            let color = '#2ecc71';
            if (qualityScore < 4) color = '#e74c3c';
            else if (qualityScore < 7) color = '#f39c12';
            qualityBadge = `<span style="color: ${color}; font-weight: 600;">Q${qualityScore.toFixed(1)}</span>`;
        }

        const lat = toFiniteNumber(test.latency);
        const latencyText = lat !== null ? (lat < 1000 ? `${lat}ms` : `${(lat / 1000).toFixed(1)}s`) : '-';

        const tps = toFiniteNumber(test.tokens_per_sec);
        const tpsText = tps !== null ? `${tps.toFixed(1)} t/s` : '-';

        const timestamp = new Date(test.timestamp).toLocaleTimeString();

        const rowStyle = isFailed
            ? 'background: rgba(231, 76, 60, 0.1); border-left: 3px solid #e74c3c;'
            : 'border-left: 3px solid transparent;';

        return `
            <div class="recent-test-item" style="padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); ${rowStyle}">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                    <div style="font-weight: 600; color: var(--text);">
                        ${isFailed ? '<i class="fas fa-exclamation-triangle" style="color: #e74c3c; margin-right: 6px;"></i>' : ''}
                        ${escapeHtml(test.model)}
                    </div>
                    <div style="font-size: 0.8em; color: var(--muted);">${timestamp}</div>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-size: 0.85em; color: var(--muted);">
                        ${escapeHtml(test.prompt_name || test.prompt?.substring(0, 30) || 'Unknown')}
                    </div>
                    <div style="font-size: 0.85em; display: flex; gap: 12px;">
                        ${isFailed
                            ? '<span style="color: #e74c3c;">FAILED</span>'
                            : `
                                <span style="color: var(--muted);">${latencyText}</span>
                                <span style="color: var(--muted);">${tpsText}</span>
                                ${qualityBadge}
                            `
                        }
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Update model filter dropdown
 */
function updateModelFilterDropdown(tests) {
    const select = document.getElementById('recentTestsModelFilter');
    if (!select) return;

    const currentValue = select.value;
    const models = new Set();

    tests.forEach(t => {
        if (t.model) models.add(t.model);
    });

    const sortedModels = Array.from(models).sort();

    select.innerHTML = '<option value="">All Models</option>' +
        sortedModels.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');

    // Restore selection if still valid
    if (models.has(currentValue)) {
        select.value = currentValue;
    }
}

/**
 * Re-render recent tests (for filter changes)
 */
export function rerenderRecentTests() {
    renderRecentTests(state.lastRecentTests);
}

/**
 * Toggle success rate details
 */
export function toggleSuccessRateDetails() {
    state.setShowSuccessRateDetails(!state.showSuccessRateDetails);

    const detailsEl = document.getElementById('successRateDetails');
    if (detailsEl) {
        detailsEl.style.display = state.showSuccessRateDetails ? 'block' : 'none';
    }
}

// Expose to window for legacy code
if (typeof window !== 'undefined') {
    window.rerenderRecentTests = rerenderRecentTests;
    window.toggleSuccessRateDetails = toggleSuccessRateDetails;
}
