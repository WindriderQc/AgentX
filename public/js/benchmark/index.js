// index.js - Main entry point, DOMContentLoaded init, orchestration

import * as state from './state.js';
import { escapeHtml, debugLog } from './utils.js';
import { getWorkspaceHeaders, fetchBenchmarkConfig } from './api.js';
import { initChartDefaults } from './charts.js';
import { loadOllamaHosts, loadModelsForHost, loadBatchModels, filterModelList, selectAllVisibleModels, loadModelRegistry, renderCategoryTabs } from './models.js';
import { BENCHMARK_PRESETS, updateBatchInfo, updateLevelsSummary, applyLevelPreset, applyPresetLevels, setAdvancedMode, setHyperMode, hydrateThresholdInputs, bindThresholdInputs } from './batch-config.js';
import { runBatch, stopBatch, pollBatchProgress, resetBatchUI, recoverBatch, loadBatchDetails, loadBatchHistory } from './batch-execution.js';
import { showJudgeDetails, closeJudgeDetails } from './judge-details.js';
import { pickRepresentativeResultId } from './results-analysis.js';
import { loadRecentTestsTimeline, getTimelineMode, scheduleTimelineScrollSync, showTimelineTooltip } from './timeline.js';
import { rerenderRecentTests, toggleSuccessRateDetails } from './recent-tests.js';

/**
 * Setup modals (close on click outside, escape key)
 */
function setupModals() {
    // Click outside to close
    window.addEventListener('click', (e) => {
        const judgeModal = document.getElementById('judgeDetailsModal');
        const presetModal = document.getElementById('presetManagementModal');

        if (e.target === judgeModal) {
            judgeModal.style.display = 'none';
        }
        if (e.target === presetModal) {
            presetModal.style.display = 'none';
        }
    });

    // Close buttons
    document.querySelectorAll('.modal-close, [data-modal-close]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const modal = e.target.closest('.modal');
            if (modal) modal.style.display = 'none';
        });
    });

    // Escape key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal').forEach(modal => {
                if (modal.style.display !== 'none') {
                    modal.style.display = 'none';
                }
            });
        }
    });
}

/**
 * Switch between category tabs
 */
function switchCategoryTab(category) {
    const tabs = document.querySelectorAll('.category-tab');
    tabs.forEach(tab => {
        const isActive = tab.dataset.category === category;
        if (isActive) {
            tab.classList.add('active');
            tab.style.borderBottomColor = 'var(--accent)';
            tab.style.color = 'var(--accent)';
        } else {
            tab.classList.remove('active');
            tab.style.borderBottomColor = 'transparent';
            tab.style.color = 'var(--muted)';
        }
    });

    const modelFilter = document.getElementById('modelCategoryFilter');
    if (modelFilter) {
        modelFilter.value = category;
    }

    if (window.BenchmarkAnalytics && typeof window.BenchmarkAnalytics.filterByModelCategory === 'function') {
        window.BenchmarkAnalytics.filterByModelCategory(category);
    }

    updateLeaderboardHeader(category);
    showCategoryInsights(category);
}

/**
 * Update leaderboard header based on active category
 */
function updateLeaderboardHeader(category) {
    const headerText = document.querySelector('.leaderboard h2');
    const bestOverallText = document.getElementById('bestOverallText');

    let title = 'Model Leaderboard';
    let subtitle = 'All models ranked across all task types';

    if (category) {
        title = `${category.charAt(0).toUpperCase() + category.slice(1)} Specialists`;
        subtitle = `Models in the '${category}' category`;
    }

    if (headerText) {
        headerText.innerHTML = `<i class="fas fa-trophy" style="color: var(--accent);"></i> ${title}`;
    }
    if (bestOverallText) {
        bestOverallText.textContent = subtitle;
    }
}

/**
 * Show category-specific insights
 */
function showCategoryInsights(category) {
    const insightsPanel = document.getElementById('categoryInsights');
    const insightsTitle = document.getElementById('insightsTitle');
    const insightsContent = document.getElementById('insightsContent');

    if (!category) {
        if (insightsTitle) insightsTitle.textContent = 'Universal Leaderboard - All Models';
        if (insightsContent) insightsContent.innerHTML = '<strong>Overview:</strong> All models ranked across all task types using composite scoring<br><strong>Key Metric:</strong> Composite score balances quality (40%), speed (40%), and reliability (20%)<br><strong>Tip:</strong> This view is useful for general comparison, but use category tabs for task-specific rankings.';
        if (insightsPanel) insightsPanel.style.display = 'block';
        return;
    }

    if (insightsTitle) insightsTitle.textContent = `${category.charAt(0).toUpperCase() + category.slice(1)} Category`;
    if (insightsContent) insightsContent.innerHTML = `<strong>Overview:</strong> Showing models tagged with <code>${escapeHtml(category)}</code>.<br><strong>Tip:</strong> Use this view to compare models within this specific domain.`;
    if (insightsPanel) insightsPanel.style.display = 'block';
}

/**
 * Load judge configuration
 */
async function loadJudgeConfig() {
    try {
        const json = await fetchBenchmarkConfig();
        if (json.data && json.data.judgeConfig) {
            state.setCurrentJudgeConfig(json.data.judgeConfig);
        }
        if (json.data && json.data.executionConfig) {
            state.setCurrentExecutionConfig(json.data.executionConfig);
        }
    } catch (err) {
        console.error('Failed to load judge config:', err);
    }
}

/**
 * Initialize benchmark UI
 */
async function initBenchmarkUI() {
    debugLog('Initializing Benchmark UI...');

    // Initialize Chart.js defaults
    initChartDefaults();

    // Setup modals
    setupModals();

    // Host change handler
    const hostSelect = document.getElementById('host');
    if (hostSelect) {
        hostSelect.addEventListener('change', async (e) => {
            loadModelsForHost(e.target.value);
            await loadBatchModels(e.target.value);
        });
    }

    // Model search and filter
    const modelSearchInput = document.getElementById('modelSearchInput');
    const modelCategoryFilterSelect = document.getElementById('modelCategoryFilterSelect');
    if (modelSearchInput) {
        modelSearchInput.addEventListener('input', filterModelList);
    }
    if (modelCategoryFilterSelect) {
        modelCategoryFilterSelect.addEventListener('change', filterModelList);
    }

    // Select all/none buttons
    const selectAllBtn = document.getElementById('selectAllModelsBtn');
    const selectNoneBtn = document.getElementById('selectNoneModelsBtn');
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', () => selectAllVisibleModels(true));
    }
    if (selectNoneBtn) {
        selectNoneBtn.addEventListener('click', () => selectAllVisibleModels(false));
    }
    const selectAllCheckbox = document.getElementById('selectAllModelsTable');
    if (selectAllCheckbox) {
        selectAllCheckbox.addEventListener('change', (e) => {
            selectAllVisibleModels(e.target.checked);
        });
    }

    // Batch model checkbox changes
    document.addEventListener('change', (e) => {
        if (e.target.classList.contains('batch-model-checkbox')) {
            updateBatchInfo();
        }
    });

    // Run batch button
    const runBatchBtn = document.getElementById('runBatchBtn');
    if (runBatchBtn) {
        runBatchBtn.addEventListener('click', runBatch);
    }

    // Stop batch button
    const stopBatchBtn = document.getElementById('stopBatchBtn');
    if (stopBatchBtn) {
        stopBatchBtn.addEventListener('click', stopBatch);
    }

    // Profile selector
    const profileSelector = document.getElementById('scoringProfile');
    if (profileSelector) {
        profileSelector.addEventListener('change', (e) => {
            const profile = e.target.value;
            const sortSelector = document.getElementById('sortBy');
            if (['composite', 'interactive', 'reasoning', 'coding'].includes(state.currentSortBy)) {
                state.setCurrentSortBy(profile);
                if (sortSelector) sortSelector.value = 'composite';
            }
        });
    }

    // Sort selector
    const sortBy = document.getElementById('sortBy');
    if (sortBy) {
        sortBy.addEventListener('change', (e) => {
            const val = e.target.value;
            if (val === 'composite') {
                const profile = document.getElementById('scoringProfile')?.value || 'interactive';
                state.setCurrentSortBy(profile);
            } else {
                state.setCurrentSortBy(val);
            }
        });
    }

    // Test form
    const testForm = document.getElementById('testForm');
    if (testForm) {
        testForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('runBtn');
            const status = document.getElementById('status');

            btn.disabled = true;
            btn.textContent = 'Running...';
            status.style.display = 'none';

            try {
                const res = await fetch(`${state.BENCHMARK_API}/test`, {
                    method: 'POST',
                    headers: getWorkspaceHeaders(),
                    body: JSON.stringify({
                        model: document.getElementById('model').value,
                        host: document.getElementById('host').value,
                        prompt: document.getElementById('prompt').value
                    })
                });

                const json = await res.json();
                const data = json.data || json;

                if (data.success) {
                    status.className = 'status success';
                    status.textContent = `Test completed in ${data.latency}ms (${data.tokens_per_sec} tokens/s)`;
                } else {
                    status.className = 'status error';
                    status.textContent = `Test failed: ${data.error || json.error}`;
                }

                status.style.display = 'block';
            } catch (err) {
                status.className = 'status error';
                status.textContent = `Error: ${err.message}`;
                status.style.display = 'block';
            } finally {
                btn.disabled = false;
                btn.textContent = 'Run Test';
            }
        });
    }

    // Load Ollama hosts
    try {
        await loadOllamaHosts();
    } catch (err) {
        console.error('Failed to load Ollama hosts:', err);
    }

    // Disclosure defaults
    if (localStorage.getItem('benchmarkShowAdvanced') === null) {
        localStorage.setItem('benchmarkShowAdvanced', 'false');
    }
    if (localStorage.getItem('benchmarkShowHyper') === null) {
        localStorage.setItem('benchmarkShowHyper', 'false');
    }

    // Advanced toggle
    const toggleAdvancedBtn = document.getElementById('toggleAdvancedBtn');
    if (toggleAdvancedBtn) {
        toggleAdvancedBtn.addEventListener('click', () => {
            const current = localStorage.getItem('benchmarkShowAdvanced') === 'true';
            setAdvancedMode(!current);
        });
    }

    // Hyper toggle
    const toggleHyperBtn = document.getElementById('toggleHyperBtn');
    if (toggleHyperBtn) {
        toggleHyperBtn.addEventListener('click', () => {
            const current = localStorage.getItem('benchmarkShowHyper') === 'true';
            setHyperMode(!current);
        });
    }

    // Timeline toggle
    const toggleTimelineBtn = document.getElementById('toggleTimelineBtn');
    if (toggleTimelineBtn) {
        toggleTimelineBtn.addEventListener('click', () => {
            const content = document.getElementById('timelineContent');
            const chevron = document.getElementById('timelineChevron');
            if (content && chevron) {
                const isHidden = content.style.display === 'none';
                content.style.display = isHidden ? 'block' : 'none';
                chevron.className = isHidden ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
            }
        });
    }

    // Copy hyper JSON button
    const copyHyperJsonBtn = document.getElementById('copyHyperJsonBtn');
    if (copyHyperJsonBtn) {
        copyHyperJsonBtn.addEventListener('click', async () => {
            const pre = document.getElementById('hyperBatchJson');
            if (!pre) return;
            try {
                await navigator.clipboard.writeText(pre.textContent || '');
                const prev = copyHyperJsonBtn.textContent;
                copyHyperJsonBtn.textContent = 'Copied';
                setTimeout(() => { copyHyperJsonBtn.textContent = prev; }, 800);
            } catch (e) { /* ignore */ }
        });
    }

    // Batch inspect buttons
    const bindBatchInspect = (btn, mode) => {
        if (!btn) return;
        btn.addEventListener('click', () => {
            const idOrIndex = pickRepresentativeResultId(mode);
            if (idOrIndex !== null) {
                showJudgeDetails(idOrIndex);
            }
        });
    };

    bindBatchInspect(document.getElementById('inspectBatchFailureBtn'), 'failure');
    bindBatchInspect(document.getElementById('inspectBatchWorstLatencyBtn'), 'worst_latency');
    bindBatchInspect(document.getElementById('inspectBatchWorstThroughputBtn'), 'worst_throughput');
    bindBatchInspect(document.getElementById('inspectBatchLongestJudgeBtn'), 'longest_judge');
    bindBatchInspect(document.getElementById('inspectBatchLowestQualityBtn'), 'lowest_quality');

    // Apply initial state
    setAdvancedMode(localStorage.getItem('benchmarkShowAdvanced') === 'true');

    // Load batch models
    const firstHost = document.getElementById('host')?.value;
    if (firstHost) {
        await loadBatchModels(firstHost);
    }

    // Load judge config
    await loadJudgeConfig();

    // Check for active batch
    const savedBatchId = localStorage.getItem('currentBatchId');
    if (savedBatchId) {
        debugLog('Attempting to resume batch:', savedBatchId);
        try {
            const res = await fetch(`${state.BENCHMARK_API}/batch/${savedBatchId}`);
            if (res.ok) {
                const json = await res.json();
                const batch = json.data;

                if (batch && (batch.status === 'running' || batch.status === 'judging')) {
                    debugLog('Resuming active batch:', savedBatchId);
                    state.setCurrentBatchId(savedBatchId);

                    const btn = document.getElementById('runBatchBtn');
                    const stopBtn = document.getElementById('stopBatchBtn');
                    btn.disabled = true;
                    btn.textContent = 'Resuming...';
                    stopBtn.style.display = 'inline-block';

                    pollBatchProgress();
                    const interval = setInterval(pollBatchProgress, 2000);
                    state.setBatchPollInterval(interval);
                } else {
                    localStorage.removeItem('currentBatchId');
                }
            } else {
                localStorage.removeItem('currentBatchId');
            }
        } catch (err) {
            console.error('Failed to validate saved batch:', err);
            localStorage.removeItem('currentBatchId');
        }
    }

    // Load history
    loadBatchHistory();
    const refreshHistoryBtn = document.getElementById('refreshHistoryBtn');
    if (refreshHistoryBtn) {
        refreshHistoryBtn.addEventListener('click', loadBatchHistory);
    }

    // Recent tests filters
    const recentTestsFailuresOnly = document.getElementById('recentTestsFailuresOnly');
    if (recentTestsFailuresOnly) {
        recentTestsFailuresOnly.addEventListener('change', rerenderRecentTests);
    }
    const recentTestsModelFilter = document.getElementById('recentTestsModelFilter');
    if (recentTestsModelFilter) {
        recentTestsModelFilter.addEventListener('change', rerenderRecentTests);
    }

    // Success rate card
    const successRateCard = document.getElementById('successRateCard');
    if (successRateCard) {
        successRateCard.style.cursor = 'pointer';
        successRateCard.title = 'Click for breakdown';
        successRateCard.addEventListener('click', toggleSuccessRateDetails);
    }

    // Reset buttons
    const resetLeaderboardBtn = document.getElementById('resetLeaderboardBtn');
    if (resetLeaderboardBtn) {
        resetLeaderboardBtn.addEventListener('click', async () => {
            if (!confirm('Reset all benchmark tests? This cannot be undone.')) return;
            if (!confirm('Are you sure?')) return;

            try {
                resetLeaderboardBtn.disabled = true;
                resetLeaderboardBtn.textContent = 'Resetting...';

                const res = await fetch(`${state.BENCHMARK_API}/results`, { method: 'DELETE' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                if (window.loadDashboard) await window.loadDashboard();

                resetLeaderboardBtn.textContent = 'Reset Tests';
                resetLeaderboardBtn.disabled = false;
            } catch (err) {
                console.error('Failed to reset results:', err);
                alert(`Failed to reset: ${err.message}`);
                resetLeaderboardBtn.textContent = 'Reset Tests';
                resetLeaderboardBtn.disabled = false;
            }
        });
    }

    // Level preset buttons (updated to use new .preset-chip class)
    const levelPresetButtons = document.querySelectorAll('.preset-chip');
    levelPresetButtons.forEach(btn => {
        btn.addEventListener('click', function() {
            applyLevelPreset(this.getAttribute('data-preset'));
        });
    });

    // Clear levels button
    const clearLevelsBtn = document.getElementById('clearLevelsBtn');
    if (clearLevelsBtn) {
        clearLevelsBtn.addEventListener('click', () => {
            for (let i = 1; i <= 10; i++) {
                const checkbox = document.getElementById(`level${i}`);
                if (checkbox) checkbox.checked = false;
            }
            updateLevelsSummary();
            updateBatchInfo();
        });
    }

    // Level checkbox listeners
    for (let i = 1; i <= 10; i++) {
        const checkbox = document.getElementById(`level${i}`);
        if (checkbox) {
            checkbox.addEventListener('change', () => {
                updateLevelsSummary();
                updateBatchInfo();
            });
        }
    }

    // Benchmark preset selector
    const presetSelect = document.getElementById('benchmarkPresetSelect');
    const presetSummary = document.getElementById('presetSummary');
    const presetSummaryTitle = document.getElementById('presetSummaryTitle');
    const presetSummaryDetails = document.getElementById('presetSummaryDetails');

    if (presetSelect) {
        presetSelect.addEventListener('change', function() {
            const selectedPreset = this.value;
            if (selectedPreset === 'custom') {
                if (presetSummary) presetSummary.style.display = 'none';
            } else {
                const preset = BENCHMARK_PRESETS[selectedPreset];
                if (preset) {
                    if (presetSummaryTitle) presetSummaryTitle.textContent = preset.name;
                    if (presetSummaryDetails) {
                        presetSummaryDetails.innerHTML = preset.details.map(d => `<li>${d}</li>`).join('');
                    }
                    if (presetSummary) presetSummary.style.display = 'block';
                    applyPresetLevels(preset.levels);
                }
            }
        });

        if (presetSelect.value === 'standard') {
            presetSelect.dispatchEvent(new Event('change'));
        }
    }

    // Manage presets button
    const managePresetsBtn = document.getElementById('managePresetsBtn');
    const presetManagementModal = document.getElementById('presetManagementModal');
    if (managePresetsBtn && presetManagementModal) {
        managePresetsBtn.addEventListener('click', () => {
            presetManagementModal.style.display = 'block';
        });
    }

    // Timeline controls
    const timelineModeSelect = document.getElementById('timelineMode');
    const timelineOrderSelect = document.getElementById('timelineOrder');
    const timelineZoomSelect = document.getElementById('timelineZoom');

    const updateTimelineControls = () => {
        const mode = getTimelineMode();
        if (timelineZoomSelect) {
            timelineZoomSelect.style.display = mode === 'events' ? '' : 'none';
        }
        if (timelineOrderSelect) {
            timelineOrderSelect.style.display = mode === 'events' ? 'none' : '';
        }
    };

    if (timelineOrderSelect) {
        const savedOrder = localStorage.getItem('benchmarkTimelineOrder');
        if (savedOrder) {
            timelineOrderSelect.value = savedOrder;
        }
        timelineOrderSelect.addEventListener('change', () => {
            localStorage.setItem('benchmarkTimelineOrder', timelineOrderSelect.value);
            loadRecentTestsTimeline();
        });
    }

    if (timelineModeSelect) {
        timelineModeSelect.addEventListener('change', () => {
            updateTimelineControls();
            loadRecentTestsTimeline();
        });
    }

    if (timelineZoomSelect) {
        timelineZoomSelect.addEventListener('change', loadRecentTestsTimeline);
    }

    updateTimelineControls();
    loadRecentTestsTimeline();

    // Periodic refresh
    setInterval(() => {
        if (window.loadDashboard) window.loadDashboard();
        loadRecentTestsTimeline();
    }, 2000);

    // Initialize UI
    updateLevelsSummary();
    updateBatchInfo();

    debugLog('Benchmark UI initialized');
}

// Expose functions to window for legacy inline onclick handlers
window.switchCategoryTab = switchCategoryTab;
window.showJudgeDetails = showJudgeDetails;
window.closeJudgeDetails = closeJudgeDetails;
window.recoverBatch = recoverBatch;
window.loadBatchDetails = loadBatchDetails;
window.showTimelineTooltip = showTimelineTooltip;

// Initialize on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBenchmarkUI);
} else {
    initBenchmarkUI();
}
