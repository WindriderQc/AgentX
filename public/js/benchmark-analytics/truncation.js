/**
 * Benchmark Analytics - Truncation Stats
 * Truncation monitoring and inspector modal
 */

import {
    BENCHMARK_API,
    getActiveTruncationFilter,
    setActiveTruncationFilter,
    getInspectorActiveFilter,
    setInspectorActiveFilter,
    getInspectorData,
    setInspectorData
} from './config.js';
import { escapeHtml, showToast } from './utils.js';
import { currentBatchId, currentBatchResults } from '../benchmark/state.js';

/**
 * Load and display truncation statistics
 */
export async function loadTruncationStats() {
    const widget = document.getElementById('truncationStatsWidget');
    const grid = document.getElementById('truncationStatsGrid');
    const details = document.getElementById('truncationDetails');
    if (!widget || !grid) return;

    try {
        // If we have an active batch, show stats for entire batch (no limit)
        // Otherwise fall back to recent tests with a limit
        const batchIdParam = currentBatchId ? `?batch_id=${currentBatchId}` : '?limit=100';
        const res = await fetch(`${BENCHMARK_API}/truncation-stats${batchIdParam}`);
        const json = await res.json();
        if (json.status !== 'success') throw new Error(json.error);

        const stats = json.data;
        const hasIssues = stats.response_truncated > 0 ||
                          stats.judge_truncated > 0;

        if (!hasIssues || stats.total_analyzed === 0) {
            widget.style.display = 'none';
            setActiveTruncationFilter(null);
            return;
        }

        widget.style.display = 'block';

        // Determine severity color
        const totalTruncPct = ((stats.response_truncated + stats.judge_truncated) / stats.total_analyzed) * 100;
        let borderColor = 'rgba(241, 196, 15, 0.3)'; // warning yellow
        let bgColor = 'rgba(241, 196, 15, 0.08)';
        if (totalTruncPct > 10) {
            borderColor = 'rgba(255, 107, 107, 0.4)';
            bgColor = 'rgba(255, 107, 107, 0.1)';
        }
        widget.style.borderColor = borderColor;
        widget.style.background = bgColor;

        const makeCard = (type, count, label, pct, color, isClickable) => {
            const activeTruncationFilter = getActiveTruncationFilter();
            const isActive = activeTruncationFilter === type;
            const activeStyle = isActive ? 'border: 2px solid var(--accent); box-shadow: 0 0 12px rgba(124, 240, 255, 0.4);' : '';
            const cursor = isClickable && count > 0 ? 'cursor: pointer;' : '';
            const hoverEffect = isClickable && count > 0 ? 'transition: transform 0.2s, box-shadow 0.2s;' : '';
            const dataAttr = isClickable ? `data-filter="${type}"` : '';

            return `
                <div ${dataAttr} style="text-align: center; padding: 8px; background: rgba(0,0,0,0.15); border-radius: 6px; ${cursor} ${hoverEffect} ${activeStyle}"
                     ${isClickable && count > 0 ? `onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 12px rgba(0,0,0,0.3)';" onmouseout="this.style.transform=''; this.style.boxShadow='';"` : ''}>
                    <div style="font-size: 1.4em; font-weight: 700; color: ${color};">
                        ${count}
                    </div>
                    <div style="font-size: 0.75em; color: var(--muted);">${label}</div>
                    <div style="font-size: 0.7em; color: var(--muted);">${pct}</div>
                    ${isClickable && count > 0 && isActive ? '<div style="font-size: 0.65em; color: var(--accent); margin-top: 2px;">FILTERED</div>' : ''}
                    ${isClickable && count > 0 && !isActive ? '<div style="font-size: 0.65em; color: var(--muted); margin-top: 2px;">Click to filter</div>' : ''}
                </div>
            `;
        };

        const scopeLabel = currentBatchId ? 'Current Batch' : 'Recent Tests';

        grid.innerHTML = `
            ${makeCard('response_truncated', stats.response_truncated, 'Response Truncated', stats.response_truncated_pct, stats.response_truncated > 0 ? '#ff6b6b' : 'var(--text)', true)}
            ${makeCard('judge_truncated', stats.judge_truncated, 'Judge Truncated', stats.judge_truncated_pct, stats.judge_truncated > 0 ? '#ff6b6b' : 'var(--text)', true)}
            ${makeCard('total', stats.total_analyzed, scopeLabel, '', 'var(--text)', false)}
        `;

        // Attach click handlers to filterable cards - open inspector instead of inline filtering
        grid.querySelectorAll('[data-filter]').forEach(card => {
            card.addEventListener('click', function() {
                const filterType = this.getAttribute('data-filter');
                const count = parseInt(this.querySelector('div').textContent.trim());
                if (count > 0) {
                    // Set the filter type and open inspector
                    setInspectorActiveFilter(filterType);
                    openTruncationInspector();
                }
            });
        });

        // Build tips based on issues
        const tips = [];
        if (stats.response_truncated > 0) {
            tips.push('<i class="fas fa-lightbulb"></i> Increase <strong>Response Max Tokens</strong> in settings');
        }
        if (stats.judge_truncated > 0) {
            tips.push('<i class="fas fa-exclamation-circle"></i> Increase <strong>Judge Max Tokens</strong> - judge output cut off!');
        }

        if (details) {
            details.innerHTML = tips.length > 0
                ? tips.map(t => `<div style="margin-top: 4px;">${t}</div>`).join('')
                : '';
        }

    } catch (err) {
        console.error('Failed to load truncation stats:', err);
        widget.style.display = 'none';
    }
}

/**
 * Apply truncation filter to batch results table
 */
export function applyTruncationFilter() {
    const tbody = document.getElementById('batchResultsBody');
    if (!tbody || !currentBatchResults) return;

    const activeTruncationFilter = getActiveTruncationFilter();
    const allRows = tbody.querySelectorAll('tr');
    allRows.forEach((row, idx) => {
        const result = currentBatchResults[idx];
        if (!result) return;

        let shouldShow = true;
        if (activeTruncationFilter) {
            shouldShow = false;
            if (activeTruncationFilter === 'response_truncated' && result.response_truncated === true) {
                shouldShow = true;
            }
            if (activeTruncationFilter === 'judge_truncated' && result.judge_response_truncated === true) {
                shouldShow = true;
            }
        }

        row.style.display = shouldShow ? '' : 'none';
    });

    // Update table header to show filter status
    const container = document.getElementById('batchResultsContainer');
    if (container) {
        let filterBadge = container.querySelector('.truncation-filter-badge');
        if (activeTruncationFilter) {
            if (!filterBadge) {
                const table = container.querySelector('table');
                if (table) {
                    filterBadge = document.createElement('div');
                    filterBadge.className = 'truncation-filter-badge';
                    filterBadge.style.cssText = 'background: rgba(124, 240, 255, 0.15); border: 1px solid var(--accent); border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; font-size: 0.9em; color: var(--accent); display: flex; align-items: center; gap: 8px;';
                    table.parentNode.insertBefore(filterBadge, table);
                }
            }
            if (filterBadge) {
                const visibleCount = Array.from(allRows).filter(r => r.style.display !== 'none').length;
                filterBadge.innerHTML = `<i class="fas fa-filter"></i> Filtered: Showing ${visibleCount} ${activeTruncationFilter.replace('_', ' ')} tests`;
            }
        } else if (filterBadge) {
            filterBadge.remove();
        }
    }
}

/**
 * Setup truncation widget event listeners
 */
export function setupTruncationWidget() {
    const refreshBtn = document.getElementById('truncationRefreshBtn');
    const inspectBtn = document.getElementById('truncationInspectBtn');

    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadTruncationStats);
    }

    if (inspectBtn) {
        inspectBtn.addEventListener('click', openTruncationInspector);
    }

    loadTruncationStats();
}

/**
 * Open truncation inspector modal
 */
export async function openTruncationInspector() {
    const modal = document.getElementById('truncationInspectorModal');
    if (!modal) return;

    modal.style.display = 'block';
    await loadInspectorData();
}

/**
 * Load data for inspector modal
 */
async function loadInspectorData() {
    try {
        // Fetch all truncated tests from current batch
        const batchResults = currentBatchResults || [];

        // Helper to check truncation with fallback for nested structure
        const isResponseTruncated = (r) => r.response_truncated === true || r.truncation?.response_truncated === true;
        const isJudgeTruncated = (r) => r.judge_response_truncated === true || r.truncation?.judge_truncated === true;

        const newInspectorData = batchResults.filter(r =>
            isResponseTruncated(r) ||
            isJudgeTruncated(r)
        );
        setInspectorData(newInspectorData);

        // Get the updated data
        const inspectorData = getInspectorData();

        // Update counts
        const responseTruncated = inspectorData.filter(isResponseTruncated).length;
        const judgeTruncated = inspectorData.filter(isJudgeTruncated).length;

        const respCountEl = document.getElementById('inspectorResponseCount');
        const judgeCountEl = document.getElementById('inspectorJudgeCount');
        const totalCountEl = document.getElementById('inspectorTotalCount');

        if (respCountEl) respCountEl.textContent = responseTruncated;
        if (judgeCountEl) judgeCountEl.textContent = judgeTruncated;
        if (totalCountEl) totalCountEl.textContent = inspectorData.length;

        // Update tab counts
        const tabs = document.querySelectorAll('.truncation-filter-tab');
        tabs.forEach(tab => {
            const type = tab.getAttribute('data-type');
            let count = 0;
            if (type === 'all') count = inspectorData.length;
            else if (type === 'response_truncated') count = responseTruncated;
            else if (type === 'judge_truncated') count = judgeTruncated;

            const text = tab.innerHTML.replace(/\(\d+\)/, `(${count})`);
            if (!text.includes('(')) {
                tab.innerHTML = tab.innerHTML + ` (${count})`;
            } else {
                tab.innerHTML = text;
            }
        });

        renderInspectorTests();
    } catch (err) {
        console.error('Failed to load inspector data:', err);
        const listEl = document.getElementById('truncationTestsList');
        if (listEl) {
            listEl.innerHTML = '<div style="text-align: center; color: #e74c3c; padding: 40px;">Error loading data</div>';
        }
    }
}

/**
 * Render tests in inspector modal
 */
function renderInspectorTests() {
    const container = document.getElementById('truncationTestsList');
    const navInfo = document.getElementById('inspectorNavInfo');

    if (!container) return;

    // Get current state
    const inspectorData = getInspectorData();
    const inspectorActiveFilter = getInspectorActiveFilter();

    // Helper to check truncation with fallback
    const isResponseTruncated = (r) => r.response_truncated === true || r.truncation?.response_truncated === true;
    const isJudgeTruncated = (r) => r.judge_response_truncated === true || r.truncation?.judge_truncated === true;

    // Filter based on active tab
    let filtered = inspectorData;
    if (inspectorActiveFilter !== 'all') {
        filtered = inspectorData.filter(r => {
            if (inspectorActiveFilter === 'response_truncated') return isResponseTruncated(r);
            if (inspectorActiveFilter === 'judge_truncated') return isJudgeTruncated(r);
            return true;
        });
    }

    if (navInfo) {
        navInfo.textContent = `Showing ${filtered.length} test${filtered.length !== 1 ? 's' : ''}`;
    }

    if (filtered.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: var(--muted); padding: 40px;">No truncated tests found</div>';
        return;
    }

    container.innerHTML = filtered.map((r, idx) => {
        const truncationTypes = [];
        if (isResponseTruncated(r)) truncationTypes.push('<span style="color: #ff6b6b;"><i class="fas fa-cut"></i> Response</span>');
        if (isJudgeTruncated(r)) truncationTypes.push('<span style="color: #ff6b6b;"><i class="fas fa-gavel"></i> Judge</span>');

        const qualityScore = r.quality_score !== undefined && r.quality_score !== null ? r.quality_score : 'N/A';
        const latency = r.latency ? `${Math.round(r.latency)}ms` : 'N/A';
        const tpsValue = parseFloat(r.tokens_per_sec);
        const tps = !isNaN(tpsValue) ? tpsValue.toFixed(2) : 'N/A';

        return `
            <div style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255, 107, 107, 0.3); border-radius: 6px; padding: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                    <div>
                        <div style="font-weight: 600; font-size: 1.05em; color: var(--text); margin-bottom: 4px;">${escapeHtml(r.model)}</div>
                        <div style="font-size: 0.85em; color: var(--muted);">${escapeHtml(r.prompt_name)}</div>
                    </div>
                    <button class="btn-secondary btn-sm" onclick="showJudgeDetails('${r.id || idx}')" style="padding: 4px 10px;">
                        <i class="fas fa-eye"></i> Details
                    </button>
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 12px; font-size: 0.85em; color: var(--muted); margin-bottom: 8px;">
                    <div>Quality: <span style="color: var(--text); font-weight: 600;">${qualityScore}</span></div>
                    <div>Latency: <span style="color: var(--text);">${latency}</span></div>
                    <div>t/s: <span style="color: var(--text);">${tps}</span></div>
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 8px; font-size: 0.8em;">
                    ${truncationTypes.join(' ')}
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Setup inspector modal event listeners
 */
export function setupInspectorModal() {
    const modal = document.getElementById('truncationInspectorModal');
    if (!modal) return;

    // Close button
    const closeBtn = modal.querySelector('.close');
    if (closeBtn) {
        closeBtn.onclick = () => modal.style.display = 'none';
    }

    // Tab filters
    const tabs = document.querySelectorAll('.truncation-filter-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', function() {
            tabs.forEach(t => {
                t.classList.remove('active');
                t.style.background = t.style.background.replace('0.15', '0.1');
                t.style.fontWeight = 'normal';
            });
            this.classList.add('active');
            this.style.background = this.style.background.replace('0.1', '0.15');
            this.style.fontWeight = '600';

            setInspectorActiveFilter(this.getAttribute('data-type'));
            renderInspectorTests();
        });
    });

    // Refresh button
    const refreshBtn = document.getElementById('inspectorRefreshBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadInspectorData);
    }

    // Export button
    const exportBtn = document.getElementById('inspectorExportBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportInspectorData);
    }

    // Click outside to close
    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });
}

/**
 * Export inspector data to CSV
 */
function exportInspectorData() {
    // Get current state
    const inspectorData = getInspectorData();
    const inspectorActiveFilter = getInspectorActiveFilter();

    // Helper to check truncation with fallback
    const isResponseTruncated = (r) => r.response_truncated === true || r.truncation?.response_truncated === true;
    const isJudgeTruncated = (r) => r.judge_response_truncated === true || r.truncation?.judge_truncated === true;

    const filtered = inspectorActiveFilter === 'all' ? inspectorData :
        inspectorData.filter(r => {
            if (inspectorActiveFilter === 'response_truncated') return isResponseTruncated(r);
            if (inspectorActiveFilter === 'judge_truncated') return isJudgeTruncated(r);
            return true;
        });

    const csv = [
        ['Model', 'Prompt', 'Quality Score', 'Latency (ms)', 'Tokens/sec', 'Response Truncated', 'Judge Truncated', 'Host'].join(','),
        ...filtered.map(r => [
            `"${(r.model || '').replace(/"/g, '""')}"`,
            `"${(r.prompt_name || '').replace(/"/g, '""')}"`,
            r.quality_score !== undefined ? r.quality_score : '',
            r.latency || '',
            r.tokens_per_sec || '',
            isResponseTruncated(r) ? 'YES' : 'NO',
            isJudgeTruncated(r) ? 'YES' : 'NO',
            `"${(r.host || '').replace(/"/g, '""')}"`
        ].join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `truncated_tests_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
