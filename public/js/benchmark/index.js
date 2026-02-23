// index.js - Main entry point, DOMContentLoaded init, orchestration

import * as state from './state.js';
import { escapeHtml, debugLog } from './utils.js';
import { getWorkspaceHeaders, fetchBenchmarkConfig } from './api.js';
import { initChartDefaults } from './charts.js';
import { loadOllamaHosts, loadModelsForHost, loadBatchModels, filterModelList, selectAllVisibleModels, loadModelRegistry, renderCategoryTabs } from './models.js';
import { updateBatchInfo, renderDepthMatrix, bindDepthMatrix, updateDepthSummary, setAllDepths, getDepthConfig, getSelectedLevels, setAdvancedMode, setHyperMode, hydrateThresholdInputs, bindThresholdInputs } from './batch-config.js';
import { runBatch, stopBatch, pollBatchProgress, resetBatchUI, recoverBatch, loadBatchDetails, loadBatchHistory } from './batch-execution.js';
import { showJudgeDetails, closeJudgeDetails } from './judge-details.js';
import { pickRepresentativeResultId } from './results-analysis.js';
import { loadRecentTestsTimeline, getTimelineMode, scheduleTimelineScrollSync, showTimelineTooltip } from './timeline.js';
import { rerenderRecentTests, toggleSuccessRateDetails } from './recent-tests.js';

const JUDGE_CONFIG_STORAGE_KEY = 'benchmarkJudgeConfig';

/**
 * Setup modals (close on click outside, escape key)
 */
function setupModals() {
    // Click outside to close
    window.addEventListener('click', (e) => {
        const judgeModal = document.getElementById('judgeDetailsModal');
        const presetModal = document.getElementById('presetManagementModal');
        const settingsModal = document.getElementById('settingsModal');

        if (e.target === judgeModal) {
            judgeModal.style.display = 'none';
        }
        if (e.target === presetModal) {
            presetModal.style.display = 'none';
        }
        if (e.target === settingsModal) {
            settingsModal.style.display = 'none';
        }
    });

    // Close buttons
    document.querySelectorAll('.modal-close, [data-modal-close], .modal .close').forEach(btn => {
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

function readStoredJudgeConfig() {
    try {
        const raw = localStorage.getItem(JUDGE_CONFIG_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (err) {
        console.warn('Failed to parse stored judge config:', err);
        return null;
    }
}

function writeStoredJudgeConfig(config) {
    try {
        localStorage.setItem(JUDGE_CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch (err) {
        console.warn('Failed to persist judge config:', err);
    }
}

function coerceNumber(value, fallback = null) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function getJudgeModelCandidates() {
    const registryModels = Object.values(state.modelRegistryCache || {});
    let candidates = registryModels
        .filter(m => Array.isArray(m.categories) && m.categories.includes('judge'))
        .filter(Boolean);

    if (candidates.length === 0) {
        candidates = registryModels.filter(Boolean);
    }

    if (candidates.length === 0 && Array.isArray(state.ollamaHosts)) {
        const hostModels = [];
        state.ollamaHosts.forEach(host => {
            (host.models || []).forEach(model => hostModels.push({ modelName: model }));
        });
        candidates = hostModels;
    }

    // Always include the server's configured judge model
    const serverDefault = state.currentJudgeConfig.model;
    if (serverDefault && !candidates.some(c => c.modelName === serverDefault)) {
        candidates.push({ modelName: serverDefault });
    }

    // Deduplicate by modelName, keep first (richer metadata)
    const seen = new Set();
    const unique = [];
    for (const c of candidates) {
        const name = c.modelName || c;
        if (!seen.has(name)) {
            seen.add(name);
            unique.push(c);
        }
    }
    return unique.sort((a, b) => (a.modelName || '').localeCompare(b.modelName || ''));
}

/** Tier badge for judge model select */
function judgeTierBadge(model) {
    const tier = model.capabilities && model.capabilities.judgeTier;
    if (!tier) return '';
    const badges = { basic: 'BASIC', standard: 'STD', advanced: 'ADV', premium: 'PRO' };
    return badges[tier] ? ` [${badges[tier]}]` : '';
}

function populateJudgeModelSelect() {
    const select = document.getElementById('judgeModel');
    if (!select) return;
    const candidates = getJudgeModelCandidates();

    // Remove any previous warning banner
    const existingWarning = document.getElementById('judgeModelWarning');
    if (existingWarning) existingWarning.remove();

    if (candidates.length === 0) {
        select.innerHTML = '<option value="" disabled>No models available</option>';
        return;
    }

    const current = state.currentJudgeConfig.model || select.value || '';
    select.innerHTML = candidates
        .map(model => {
            const name = model.modelName || model;
            const badge = judgeTierBadge(model);
            return `<option value="${escapeHtml(name)}">${escapeHtml(name)}${badge}</option>`;
        })
        .join('');
    if (current && candidates.some(c => (c.modelName || c) === current)) {
        select.value = current;
    } else {
        // Configured model not in available list - show warning
        if (current) {
            const warningBanner = document.createElement('div');
            warningBanner.id = 'judgeModelWarning';
            warningBanner.style.cssText = 'background: rgba(243, 156, 18, 0.15); border: 1px solid rgba(243, 156, 18, 0.5); border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; font-size: 0.85em; color: #f39c12;';
            warningBanner.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Configured judge model <strong>${escapeHtml(current)}</strong> not found in available models. Using <strong>${escapeHtml((candidates[0] && candidates[0].modelName) || candidates[0])}</strong> instead.`;
            select.parentElement.insertBefore(warningBanner, select);
        }
        select.value = (candidates[0] && candidates[0].modelName) || candidates[0];
        const next = { ...state.currentJudgeConfig, model: select.value };
        state.setCurrentJudgeConfig(next);
        writeStoredJudgeConfig(next);
    }
}

function populateJudgeHostSelect() {
    const select = document.getElementById('judgeHost');
    if (!select) return;
    const currentValue = select.value || state.currentJudgeConfig.host || '';
    let options = '<option value="">(auto \u2014 opposite of exec host)</option>';
    if (Array.isArray(state.ollamaHosts)) {
        state.ollamaHosts.forEach(h => {
            const status = h.available ? '\u2713' : '\u2717';
            options += `<option value="${h.url}">${status} ${h.name} (${h.url})</option>`;
        });
    }
    select.innerHTML = options;
    if (currentValue) select.value = currentValue;
}

function applyJudgeConfigToForm(config) {
    if (!config) return;
    const judgeModel = document.getElementById('judgeModel');
    const judgeHost = document.getElementById('judgeHost');
    const judgeTemp = document.getElementById('judgeTemp');
    const judgeTempVal = document.getElementById('judgeTempVal');
    const judgeTimeout = document.getElementById('judgeTimeout');
    const judgeMaxTokens = document.getElementById('judgeMaxTokens');
    const judgeConcurrency = document.getElementById('judgeConcurrency');
    const judgeConcurrencyVal = document.getElementById('judgeConcurrencyVal');
    const judgeSameHost = document.getElementById('judgeSameHost');

    if (judgeHost) judgeHost.value = config.host || '';
    if (judgeModel && config.model) judgeModel.value = config.model;
    if (judgeTemp && config.temperature !== undefined && config.temperature !== null) {
        judgeTemp.value = String(config.temperature);
        if (judgeTempVal) judgeTempVal.textContent = String(config.temperature);
    }
    if (judgeTimeout && config.timeout !== undefined && config.timeout !== null) {
        judgeTimeout.value = String(config.timeout);
    }
    if (judgeMaxTokens && config.num_predict !== undefined && config.num_predict !== null) {
        judgeMaxTokens.value = String(config.num_predict);
    }
    if (judgeConcurrency && config.concurrency !== undefined && config.concurrency !== null) {
        judgeConcurrency.value = String(config.concurrency);
        if (judgeConcurrencyVal) judgeConcurrencyVal.textContent = String(config.concurrency);
    }
    if (judgeSameHost && typeof config.judge_same_host === 'boolean') {
        judgeSameHost.checked = config.judge_same_host;
    }
}

function getJudgeConfigOverridesFromForm() {
    const overrides = {};
    const judgeModel = document.getElementById('judgeModel');
    const judgeHostEl = document.getElementById('judgeHost');
    const judgeTemp = document.getElementById('judgeTemp');
    const judgeTimeout = document.getElementById('judgeTimeout');
    const judgeMaxTokens = document.getElementById('judgeMaxTokens');
    const judgeConcurrency = document.getElementById('judgeConcurrency');
    const judgeSameHost = document.getElementById('judgeSameHost');

    if (judgeHostEl && judgeHostEl.value) overrides.host = judgeHostEl.value;
    if (judgeModel && judgeModel.value) overrides.model = judgeModel.value;
    if (judgeTemp && judgeTemp.value !== '') overrides.temperature = coerceNumber(judgeTemp.value, 0.1);
    if (judgeTimeout && judgeTimeout.value !== '') overrides.timeout = coerceNumber(judgeTimeout.value, 120000);
    if (judgeMaxTokens && judgeMaxTokens.value !== '') overrides.num_predict = coerceNumber(judgeMaxTokens.value, 200);
    if (judgeConcurrency && judgeConcurrency.value !== '') overrides.concurrency = coerceNumber(judgeConcurrency.value, 2);
    if (judgeSameHost) overrides.judge_same_host = !!judgeSameHost.checked;

    return overrides;
}

function updateJudgeConfigFromForm() {
    const overrides = getJudgeConfigOverridesFromForm();
    const next = { ...state.currentJudgeConfig, ...overrides };
    state.setCurrentJudgeConfig(next);
    writeStoredJudgeConfig(next);
}

function bindJudgeSettingsUI() {
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    if (settingsBtn && settingsModal) {
        settingsBtn.addEventListener('click', () => {
            populateJudgeHostSelect();
            populateJudgeModelSelect();
            applyJudgeConfigToForm(state.currentJudgeConfig);
            settingsModal.style.display = 'block';
        });
    }

    const judgeTemp = document.getElementById('judgeTemp');
    const judgeTempVal = document.getElementById('judgeTempVal');
    if (judgeTemp) {
        judgeTemp.addEventListener('input', () => {
            if (judgeTempVal) judgeTempVal.textContent = judgeTemp.value;
            updateJudgeConfigFromForm();
        });
    }

    const judgeConcurrency = document.getElementById('judgeConcurrency');
    const judgeConcurrencyVal = document.getElementById('judgeConcurrencyVal');
    if (judgeConcurrency) {
        judgeConcurrency.addEventListener('input', () => {
            if (judgeConcurrencyVal) judgeConcurrencyVal.textContent = judgeConcurrency.value;
            updateJudgeConfigFromForm();
        });
    }

    ['judgeHost', 'judgeModel', 'judgeTimeout', 'judgeMaxTokens', 'judgeSameHost'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', () => {
            updateJudgeConfigFromForm();
        });
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
        const data = json.data || {};
        const judgeConfig = data.judge_config || data.judgeConfig || {};
        const executionConfig = data.execution_config || data.executionConfig || {};
        const storedJudgeConfig = readStoredJudgeConfig();

        // Server is authoritative for model.
        // localStorage persists UI preferences (host, temperature, concurrency, timeout, num_predict).
        const uiOnlyKeys = ['host', 'temperature', 'timeout', 'num_predict', 'concurrency', 'judge_same_host'];
        const storedUiPrefs = {};
        if (storedJudgeConfig) {
            for (const key of uiOnlyKeys) {
                if (storedJudgeConfig[key] !== undefined) {
                    storedUiPrefs[key] = storedJudgeConfig[key];
                }
            }
        }
        const mergedJudgeConfig = { ...storedUiPrefs, ...judgeConfig };

        state.setCurrentJudgeConfig(mergedJudgeConfig);
        state.setCurrentExecutionConfig(executionConfig);
        populateJudgeModelSelect();
        applyJudgeConfigToForm(mergedJudgeConfig);
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
    bindJudgeSettingsUI();

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

    // Depth matrix initialization
    renderDepthMatrix();
    bindDepthMatrix();

    // Depth quick-action buttons
    const depthAllLightBtn = document.getElementById('depthAllLightBtn');
    if (depthAllLightBtn) {
        depthAllLightBtn.addEventListener('click', () => setAllDepths('light'));
    }
    const depthAllOffBtn = document.getElementById('depthAllOffBtn');
    if (depthAllOffBtn) {
        depthAllOffBtn.addEventListener('click', () => setAllDepths('off'));
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
    updateDepthSummary();

    debugLog('Benchmark UI initialized');
}

// Expose functions to window for legacy inline onclick handlers
/** Run calibration test for the selected judge model */
async function calibrateJudgeModel() {
    const btn = document.getElementById('calibrateJudgeBtn');
    const resultDiv = document.getElementById('calibrationResult');
    const judgeModel = document.getElementById('judgeModel');
    if (!btn || !resultDiv || !judgeModel) return;

    const model = judgeModel.value;
    if (!model) return;

    // Get host from current config
    const host = state.currentJudgeConfig.host || '';

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Calibrating...';
    resultDiv.style.display = 'block';
    resultDiv.style.background = 'rgba(52, 152, 219, 0.1)';
    resultDiv.style.border = '1px solid rgba(52, 152, 219, 0.3)';
    resultDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running 5 calibration tests...';

    try {
        const res = await fetch('/api/benchmark/judge/calibrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, model })
        });
        const json = await res.json();

        if (json.status === 'success') {
            const d = json.data;
            const tierColors = { basic: '#e74c3c', standard: '#f39c12', advanced: '#2ecc71', premium: '#9b59b6' };
            const color = tierColors[d.tier] || '#95a5a6';
            const passRate = Math.round(d.reliability * 100);

            resultDiv.style.background = `rgba(${d.reliability >= 0.8 ? '46, 204, 113' : '231, 76, 60'}, 0.1)`;
            resultDiv.style.border = `1px solid ${color}`;
            resultDiv.innerHTML = `
                <div style="margin-bottom: 6px;"><strong>Tier:</strong> <span style="color: ${color}; font-weight: bold; text-transform: uppercase;">${d.tier}</span></div>
                <div><strong>Reliability:</strong> ${passRate}% (${d.tests_passed}/${d.tests_total} tests passed)</div>
                <div><strong>Avg Latency:</strong> ${d.avg_latency_ms}ms</div>
                <div style="margin-top: 6px; font-size: 0.8em; opacity: 0.7;">
                    ${d.details.map(t => `${t.passed ? '\u2705' : '\u274C'} ${t.id} (${t.latency_ms}ms)`).join(' | ')}
                </div>
            `;
        } else {
            resultDiv.style.background = 'rgba(231, 76, 60, 0.1)';
            resultDiv.style.border = '1px solid rgba(231, 76, 60, 0.5)';
            resultDiv.innerHTML = `<i class="fas fa-times-circle"></i> ${json.error || 'Calibration failed'}`;
        }
    } catch (err) {
        resultDiv.style.background = 'rgba(231, 76, 60, 0.1)';
        resultDiv.innerHTML = `<i class="fas fa-times-circle"></i> ${err.message}`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-flask"></i> Calibrate Judge';
    }
}

window.calibrateJudgeModel = calibrateJudgeModel;
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
