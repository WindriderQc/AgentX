/**
 * Unified Leaderboard - Main Module
 * Config, state, data loading, rendering, filtering, sorting
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

let CATEGORY_WEIGHTS = {};
let HOST_NAMES = {}; // URL -> friendly name, loaded from /api/benchmark/host-names

const LEADERBOARD_TAB_GROUPS = [
    { key: '',            label: 'All Models',  faIcon: 'fa-globe',       categories: [] },
    { key: 'coding',      label: 'Coding',      faIcon: 'fa-code',        categories: ['coding'] },
    { key: 'reasoning',   label: 'Reasoning',   faIcon: 'fa-brain',       categories: ['reasoning'] },
    { key: 'math',        label: 'Math',        faIcon: 'fa-calculator',  categories: ['math'] },
    { key: 'knowledge',   label: 'Knowledge',   faIcon: 'fa-book',        categories: ['knowledge'] },
    { key: 'instruction', label: 'Instruction', faIcon: 'fa-list-check',  categories: ['instruction'] },
    { key: 'creative',    label: 'Creative',    faIcon: 'fa-paint-brush', categories: ['creative'] },
    { key: 'translation', label: 'Translation', faIcon: 'fa-language',    categories: ['translation'] }
];

// Profile display metadata (actual scoring is server-side)
const PROFILE_WEIGHTS = {
    balanced:    { title: 'Balanced Profile',    quality: 45, speed: 30, fullPass: 25, note: 'General-purpose evaluation using quality, speed, and full pass rate' },
    interactive: { title: 'Interactive Profile',  quality: 40, speed: 40, fullPass: 20, note: 'Optimized for chatbots and real-time applications' },
    reasoning:   { title: 'Reasoning Profile',    quality: 80, speed: 10, fullPass: 10, note: 'Optimized for complex analysis with strict full-pass weighting' },
    coding:      { title: 'Coding Profile',       quality: 70, speed: 20, fullPass: 10, note: 'Balanced for code generation with quality preference and strict pass gating' }
};

// Profile -> backend field mapping
const PROFILE_SCORE_FIELD = {
    balanced: 'balanced_score',
    interactive: 'interactive_score',
    reasoning: 'reasoning_score',
    coding: 'coding_score'
};

if (typeof Chart !== 'undefined') {
    Chart.defaults.animation = false;
    Chart.defaults.color = '#94a3b8';
}

// ============================================================================
// STATE
// ============================================================================

let performanceData = [];
let qualityData = [];
let eliteScoreMap = {};
let charts = {};

let currentCategoryFilter = '';
let currentCategoryMatchList = [];
let currentPerfSort = 'composite';
let currentPerfSortDir = 'desc';
let currentQualSort = 'generalist';
let currentQualSortDir = 'desc';
let verifiedOnly = false;

let autoRefreshInterval = null;
const AUTO_REFRESH_MS = 60000;

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    buildCategoryTabs();
    updateProfileWeights();
    bindBlendControls();
    await refreshAllData();
    renderCategoryWeights();
    startAutoRefresh();
});

function getBenchmarkRequestOptions(options = {}) {
    const headers = { ...(options.headers || {}) };
    if (window.WorkspaceManager && typeof window.WorkspaceManager.addWorkspaceHeader === 'function') {
        const wrapped = window.WorkspaceManager.addWorkspaceHeader({ headers });
        return { ...options, headers: wrapped.headers || headers };
    }
    return { ...options, headers };
}

async function fetchBenchmarkJson(url, options = {}) {
    const response = await fetch(url, getBenchmarkRequestOptions(options));
    const json = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(json?.error || `HTTP ${response.status}`);
    }
    return json;
}

function bindBlendControls() {
    const toggle = document.getElementById('verifiedOnlyToggle');
    if (!toggle) return;
    toggle.checked = verifiedOnly;
    toggle.addEventListener('change', () => {
        verifiedOnly = toggle.checked;
        renderPerformanceBoard();
    });
}

function buildCategoryTabs() {
    const container = document.getElementById('categoryTabs');
    if (!container) return;
    container.innerHTML = LEADERBOARD_TAB_GROUPS.map(group => {
        const isActive = group.key === currentCategoryFilter;
        return `<button class="category-tab ${isActive ? 'active' : ''}" data-category="${group.key}" onclick="switchCategoryTab('${group.key}')">
            <i class="fas ${group.faIcon}"></i> ${group.label}
        </button>`;
    }).join('');
}

async function refreshAllData() {
    showLoading();
    try {
        await Promise.all([
            loadPerformanceData(),
            loadQualityData(),
            loadHostNames(),
            loadEliteScores()
        ]);
        updateStats();
        updateBestOverallBanner(currentCategoryFilter);
        initCharts();
        renderPerformanceBoard();
        renderQualityBoard();
        loadCategoryHeatmap();
        updateRefreshIndicator();
    } catch (err) {
        console.error('Failed to load data:', err);
        showError(err.message);
    }
}

// ============================================================================
// AUTO-REFRESH
// ============================================================================

function startAutoRefresh() {
    stopAutoRefresh();
    autoRefreshInterval = setInterval(() => refreshAllData(), AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    }
}

function updateRefreshIndicator() {
    const el = document.getElementById('statUpdated');
    if (el) el.textContent = new Date().toLocaleTimeString();
}

// ============================================================================
// CATEGORY FILTERING & SORTING
// ============================================================================

function switchCategoryTab(tabKey) {
    currentCategoryFilter = tabKey;
    const group = LEADERBOARD_TAB_GROUPS.find(g => g.key === tabKey);
    currentCategoryMatchList = group ? group.categories : [];

    document.querySelectorAll('.category-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.category === tabKey);
    });

    updateBestOverallBanner(tabKey);
    renderPerformanceBoard();
    renderQualityBoard();
}

function updateBestOverallBanner(category) {
    let data = performanceData.map(model => ({
        ...model,
        _score: getProfileScore(model)
    }));

    if (category) data = filterByCategory(data, 'recommended_category');

    const modelEl = document.getElementById('bestOverallModel');
    const scoreEl = document.getElementById('bestOverallScore');
    const subtitleEl = document.getElementById('bestOverallSubtitle');

    if (data.length === 0) {
        if (modelEl) modelEl.textContent = 'No models';
        if (scoreEl) scoreEl.textContent = '';
        const group = LEADERBOARD_TAB_GROUPS.find(g => g.key === category);
        if (subtitleEl) subtitleEl.textContent = category ? `No models in ${group?.label || category} category` : 'Run benchmarks to see rankings';
        return;
    }

    const best = data.reduce((a, b) => a._score > b._score ? a : b);
    if (modelEl) modelEl.textContent = best.model;
    if (scoreEl) scoreEl.textContent = `Score: ${best._score.toFixed(1)}`;

    if (category) {
        const group = LEADERBOARD_TAB_GROUPS.find(g => g.key === category);
        if (subtitleEl) subtitleEl.textContent = `Top ${group?.label || category} model by composite score`;
    } else {
        if (subtitleEl) subtitleEl.textContent = 'All models ranked by composite score';
    }
}

function sortPerformanceBy(column) {
    if (currentPerfSort === column) {
        currentPerfSortDir = currentPerfSortDir === 'desc' ? 'asc' : 'desc';
    } else {
        currentPerfSort = column;
        currentPerfSortDir = (column === 'latency' || column === 'model') ? 'asc' : 'desc';
    }
    updateSortIcons('perfTable', currentPerfSort, currentPerfSortDir);
    renderPerformanceBoard();
}

function sortQualityBy(column) {
    if (currentQualSort === column) {
        currentQualSortDir = currentQualSortDir === 'desc' ? 'asc' : 'desc';
    } else {
        currentQualSort = column;
        currentQualSortDir = column === 'model' ? 'asc' : 'desc';
    }
    updateSortIcons('qualTable', currentQualSort, currentQualSortDir);
    renderQualityBoard();
}

function updateSortIcons(tableId, sortColumn, sortDir) {
    const table = document.getElementById(tableId);
    if (!table) return;
    table.querySelectorAll('th.sortable').forEach(th => {
        const col = th.dataset.sort;
        const icons = th.querySelectorAll('i');
        const icon = icons.length > 0 ? icons[icons.length - 1] : null;
        if (!icon) return;
        if (col === sortColumn) {
            th.classList.add('active');
            icon.className = sortDir === 'desc' ? 'fas fa-sort-down' : 'fas fa-sort-up';
        } else {
            th.classList.remove('active');
            icon.className = 'fas fa-sort';
        }
    });
}

function filterByCategory(data, categoryField = 'recommended_category') {
    if (!currentCategoryFilter || currentCategoryMatchList.length === 0) return data;
    return data.filter(m => {
        const cat = (m[categoryField] || '').toLowerCase();
        return currentCategoryMatchList.some(c => c.toLowerCase() === cat);
    });
}

// ============================================================================
// RESET FUNCTIONS
// ============================================================================

async function resetAllTests() {
    if (!confirm('Reset ALL benchmark tests? This will clear the leaderboard and charts.')) return;
    if (!confirm('Are you ABSOLUTELY sure? This cannot be undone.')) return;
    const btn = document.getElementById('resetAllBtn');
    try {
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Resetting...'; }
        await fetchBenchmarkJson('/api/benchmark/results', { method: 'DELETE' });
        await refreshAllData();
    } catch (err) {
        alert(`Failed to reset results: ${err.message}`);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-trash"></i> Reset All'; }
    }
}

async function resetFailedTests() {
    if (!confirm('Reset FAILED benchmark tests only? Successful results will be kept.')) return;
    const btn = document.getElementById('resetFailedBtn');
    try {
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Resetting...'; }
        await fetchBenchmarkJson('/api/benchmark/results/failed', { method: 'DELETE' });
        await refreshAllData();
    } catch (err) {
        alert(`Failed to reset failed results: ${err.message}`);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-redo"></i> Reset Failed'; }
    }
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadPerformanceData() {
    const data = await fetchBenchmarkJson('/api/benchmark/dashboard?sort=composite');
    performanceData = data.data?.model_stats || [];
}

async function loadQualityData() {
    const result = await fetchBenchmarkJson('/api/benchmark/generalist-leaderboard');
    if (result.status !== 'success') throw new Error(result.error || 'API error');

    const { leaderboard, categoryWeights } = result.data;
    CATEGORY_WEIGHTS = categoryWeights;

    qualityData = leaderboard
        .filter(model => !model.filtered)
        .map(model => {
        const scores = Object.values(model.categoryAverages).filter(s => s > 0);
        const avgScore = scores.length > 0
            ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
            : 0;

        const stdDev = model.avgWithinCategoryStdDev || 0;
        const consistencyScore = Math.max(0, Math.round(100 - stdDev));

        const perfModel = performanceData.find(p => p.model === model.model && p.host === model.host);

        const eliteKey = `${model.model}@@${model.host || ''}`;
        const elite = eliteScoreMap[eliteKey];

        return {
            name: model.model,
            host: model.host,
            generalistScore: model.generalistScore,
            weightedSum: model.weightedSum,
            coveragePenalty: model.coveragePenalty,
            consistencyBonus: model.consistencyBonus,
            coverage: model.coverage,
            consistencyScore,
            categoryAverages: model.categoryAverages,
            topCategory: getTopCategory(model.categoryAverages),
            recommended_category: model.recommended_category || perfModel?.recommended_category || null,
            avgScore,
            totalTests: model.totalTests || perfModel?.total_tests || perfModel?.tests || 0,
            testsByLevel: perfModel?.level_stats || {},
            stdDev: Math.round(stdDev * 10) / 10,
            emptyRate: model.emptyRate || 0,
            confidenceMargin: model.confidenceMargin || null,
            atCeiling: model.generalistScore >= 95,
            eliteScore: elite?.eliteScore || null
        };
    });
}

async function loadHostNames() {
    try {
        const result = await fetchBenchmarkJson('/api/benchmark/host-names');
        HOST_NAMES = result.data || {};
    } catch (_) { /* non-critical */ }
}

async function loadEliteScores() {
    try {
        const result = await fetchBenchmarkJson('/api/benchmark/elite-scores');
        eliteScoreMap = {};
        for (const entry of (result.data || [])) {
            const key = `${entry.model}@@${entry.host || ''}`;
            eliteScoreMap[key] = entry;
        }
    } catch (_) { /* non-critical */ }
}

// ============================================================================
// PROFILE SCORES (server-side)
// ============================================================================

function getProfileScore(model) {
    const profile = document.getElementById('perfProfile')?.value || 'balanced';
    const field = PROFILE_SCORE_FIELD[profile];
    const serverScore = parseFloat(model[field]);
    if (Number.isFinite(serverScore)) return serverScore;
    // Fallback: use balanced_score or interactive_score
    return parseFloat(model.balanced_score) || parseFloat(model.interactive_score) || 0;
}

function updateProfileWeights() {
    const profile = document.getElementById('perfProfile')?.value || 'balanced';
    const config = PROFILE_WEIGHTS[profile] || PROFILE_WEIGHTS.balanced;

    const titleEl = document.getElementById('profileTitle');
    if (titleEl) titleEl.textContent = config.title;

    const qualityEl = document.querySelector('#weightQuality .weight-pct');
    const speedEl = document.querySelector('#weightSpeed .weight-pct');
    const fullPassEl = document.querySelector('#weightFullPass .weight-pct');

    if (qualityEl) qualityEl.textContent = config.quality + '%';
    if (speedEl) speedEl.textContent = config.speed + '%';
    if (fullPassEl) fullPassEl.textContent = config.fullPass + '%';

    const noteEl = document.getElementById('profileNote');
    if (noteEl) noteEl.textContent = config.note;
}

// ============================================================================
// PERFORMANCE BOARD RENDERING
// ============================================================================

function renderPerformanceBoard() {
    let data = performanceData
        .filter(model => !model.filtered)
        .map(model => ({
            ...model,
            _score: getProfileScore(model)
        }));

    if (verifiedOnly) {
        data = data.filter(model => model.host_test_verification && model.host_test_verification !== 'unverified');
    }

    data = filterByCategory(data, 'recommended_category');

    const offenders = calculateOffenders(data);
    const bestOverall = data.length > 0 ? data.reduce((a, b) => a._score > b._score ? a : b) : null;

    const sortMultiplier = currentPerfSortDir === 'desc' ? 1 : -1;
    data.sort((a, b) => {
        let comparison = 0;
        switch (currentPerfSort) {
            case 'composite': comparison = b._score - a._score; break;
            case 'quality': comparison = parseFloat(b.avg_quality || 0) - parseFloat(a.avg_quality || 0); break;
            case 'latency': comparison = (a.avg_latency || 99999) - (b.avg_latency || 99999); break;
            case 'tokens': comparison = parseFloat(b.avg_tokens_per_sec || 0) - parseFloat(a.avg_tokens_per_sec || 0); break;
            case 'full_pass':
            case 'reliability':
                const relA = Number.isFinite(Number(a.full_pass_rate)) ? Number(a.full_pass_rate) : 0;
                const relB = Number.isFinite(Number(b.full_pass_rate)) ? Number(b.full_pass_rate) : 0;
                comparison = relB - relA; break;
            case 'model':
                comparison = (a.model || '').localeCompare(b.model || '');
                return currentPerfSortDir === 'asc' ? comparison : -comparison;
            default: return 0;
        }
        return comparison * sortMultiplier;
    });

    const tbody = document.getElementById('perfTableBody');
    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" class="empty-cell">No data available. <a href="/benchmark.html">Run benchmarks</a></td></tr>';
        return;
    }

    tbody.innerHTML = data.map((model, idx) => {
        const composite = model._score;
        const quality = Number.isFinite(parseFloat(model.avg_quality)) ? parseFloat(model.avg_quality) : 0;
        const latency = model.avg_latency ?? 0;
        const tokensPerSec = Number.isFinite(parseFloat(model.avg_tokens_per_sec)) ? parseFloat(model.avg_tokens_per_sec) : 0;
        const tests = model.tests || 1;
        const failed = model.failed_tests ?? 0;
        const fullPassPct = Number.isFinite(Number(model.full_pass_rate)) ? Math.round(Number(model.full_pass_rate)) : 0;
        const judgeFailed = Number(model.judge_failed_tests) || 0;
        const judgePending = Number(model.judge_pending_tests) || 0;
        const execSuccessPct = Math.round(((tests - failed) / tests) * 100);

        const hostName = extractHostName(model.host);
        const levelStarsHtml = buildLevelStars(model.level_stats || {});
        const isBestOverall = bestOverall && model.model === bestOverall.model && model.host === bestOverall.host;
        const badgesHtml = buildModelBadges(model, offenders, isBestOverall);
        const verification = formatHostVerification(model);
        const measured = formatMeasuredMetrics(model);
        const measuredAge = formatMeasuredAge(model.host_test_tested_at, model.host_test_freshness);

        return `
            <tr class="${idx < 3 ? 'top-rank rank-' + (idx + 1) : ''} ${isBestOverall ? 'best-overall' : ''}" onclick="showModelDetail('${escapeHtml(model.model).replace(/'/g, "\\'")}', 'performance', '${escapeHtml(model.host || '').replace(/'/g, "\\'")}')">
                <td class="rank-col">${getRankDisplay(idx)}</td>
                <td class="model-col">
                    <span class="model-name">${isBestOverall ? '&#x1F451; ' : ''}${escapeHtml(model.model)}</span>
                    ${hostName ? `<span class="model-host">${escapeHtml(hostName)}</span>` : ''}
                    <div class="model-badges">${badgesHtml}</div>
                    <div class="level-stars">${levelStarsHtml}</div>
                </td>
                <td class="score-col ${getScoreClass(quality, 10)}">${quality.toFixed(1)}</td>
                <td class="latency-col">${latency.toLocaleString()}ms</td>
                <td class="tokens-col">${tokensPerSec.toFixed(1)}</td>
                <td class="host-verify-col">${verification}</td>
                <td>${measured}</td>
                <td>${measuredAge}</td>
                <td class="full-pass-col ${fullPassPct >= 95 ? 'high' : fullPassPct >= 80 ? 'medium' : 'low'}" title="Full pass = execution success plus completed judge score. Exec success: ${execSuccessPct}%${judgeFailed ? ` • Judge fail: ${judgeFailed}` : ''}${judgePending ? ` • Pending: ${judgePending}` : ''}">${fullPassPct}%${judgeFailed || judgePending ? `<div class="host-verify-meta">${judgeFailed ? `J${judgeFailed}` : ''}${judgeFailed && judgePending ? ' • ' : ''}${judgePending ? `P${judgePending}` : ''}</div>` : ''}</td>
                <td class="composite-col"><strong>${composite.toFixed(1)}</strong></td>
                <td class="tests-col">${model.tests || 0}</td>
            </tr>
        `;
    }).join('');

    updatePerformanceCharts(data);
}

// ============================================================================
// QUALITY BOARD RENDERING
// ============================================================================

function renderQualityBoard() {
    const minCoverage = parseInt(document.getElementById('qualMinCoverage')?.value, 10) || 0;
    let data = [...qualityData];

    // Filter by category using quality data's own recommended_category
    if (currentCategoryFilter && currentCategoryMatchList.length > 0) {
        data = data.filter(m => {
            const cat = (m.recommended_category || '').toLowerCase();
            return currentCategoryMatchList.some(c => c.toLowerCase() === cat);
        });
    }

    data = data.filter(m => m.coverage >= minCoverage);

    const sortMultiplier = currentQualSortDir === 'desc' ? 1 : -1;
    data.sort((a, b) => {
        let comparison = 0;
        switch (currentQualSort) {
            case 'generalist': comparison = b.generalistScore - a.generalistScore; break;
            case 'elite': comparison = (b.eliteScore || 0) - (a.eliteScore || 0); break;
            case 'coverage': comparison = b.coverage - a.coverage; break;
            case 'consistency': comparison = b.consistencyScore - a.consistencyScore; break;
            case 'avgScore': comparison = b.avgScore - a.avgScore; break;
            case 'model':
                comparison = (a.name || '').localeCompare(b.name || '');
                return currentQualSortDir === 'asc' ? comparison : -comparison;
            default: return 0;
        }
        return comparison * sortMultiplier;
    });

    const tbody = document.getElementById('qualTableBody');
    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="empty-cell">No data matches filters. <a href="/benchmark.html">Run benchmarks</a></td></tr>';
        return;
    }

    tbody.innerHTML = data.map((model, idx) => {
        const escapedName = escapeHtml(model.name).replace(/'/g, "\\'");
        const hostName = extractHostName(model.host);
        const penaltyStr = model.coveragePenalty > 0 ? `<span class="breakdown-penalty">-${model.coveragePenalty.toFixed(0)}</span>` : '';
        const bonusStr = model.consistencyBonus > 0 ? `<span class="breakdown-bonus">+${model.consistencyBonus}</span>` : '';

        return `
            <tr class="${idx < 3 ? 'top-rank rank-' + (idx + 1) : ''}">
                <td class="rank-col">${getRankDisplay(idx)}</td>
                <td class="model-col">
                    <span class="model-name">${escapeHtml(model.name)}</span>
                    ${hostName ? `<span class="model-host">${escapeHtml(hostName)}</span>` : ''}
                    ${model.consistencyBonus > 0 ? '<span class="badge badge-consistent" title="Low variance across categories">Consistent</span>' : ''}
                    ${model.atCeiling ? '<span class="badge badge-ceiling" title="Scoring at ceiling (95+) - elite score differentiates">Ceiling</span>' : ''}
                </td>
                <td class="score-col">
                    <div class="score-main">${model.generalistScore.toFixed(1)}${model.confidenceMargin !== null ? `<span class="confidence-margin" title="95% confidence interval: +/-${model.confidenceMargin}"> \u00b1${model.confidenceMargin}</span>` : ''}</div>
                    <div class="score-breakdown">${model.weightedSum.toFixed(1)} ${penaltyStr} ${bonusStr}</div>
                </td>
                <td class="elite-col ${model.eliteScore !== null ? getScoreClass(model.eliteScore / 10, 10) : ''}">
                    ${model.eliteScore !== null ? model.eliteScore.toFixed(1) : '<span style="opacity:0.3">-</span>'}
                </td>
                <td class="coverage-col">
                    <div class="coverage-wrapper">
                        <div class="coverage-bar">
                            <div class="coverage-fill" style="width: ${model.coverage}%; background: ${getCoverageColor(model.coverage)};"></div>
                        </div>
                        <span>${model.coverage}%</span>
                    </div>
                </td>
                <td class="consistency-col ${model.consistencyScore >= 90 ? 'high' : model.consistencyScore >= 70 ? 'medium' : 'low'}">
                    ${model.consistencyScore}%
                    <span class="stddev-label">${'\u03c3'}=${model.stdDev}</span>
                </td>
                <td class="category-col">${formatCategory(model.topCategory)}</td>
                <td class="tests-col">${model.totalTests}</td>
                <td class="actions-col">
                    <button class="btn-details" onclick="showModelDetail('${escapedName}', 'quality', '${escapeHtml(model.host || '').replace(/'/g, "\\'")}')">
                        <i class="fas fa-chart-bar"></i> Details
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

// ============================================================================
// STATS & UTILITIES
// ============================================================================

function updateStats() {
    document.getElementById('statModels').textContent = performanceData.length;
    const totalTests = performanceData.reduce((sum, m) => sum + (m.total_tests || m.tests || 0) + (m.failed_tests || 0), 0);
    document.getElementById('statTests').textContent = totalTests.toLocaleString();
    const categoryCount = Object.keys(CATEGORY_WEIGHTS).length || 7;
    document.getElementById('statCategories').textContent = categoryCount;
    document.getElementById('statUpdated').textContent = new Date().toLocaleTimeString();
}

function showLoading() {
    document.getElementById('perfTableBody').innerHTML = '<tr><td colspan="11" class="loading-cell"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>';
    document.getElementById('qualTableBody').innerHTML = '<tr><td colspan="9" class="loading-cell"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>';
}

function showError(message) {
    document.getElementById('perfTableBody').innerHTML = `<tr><td colspan="11" class="error-cell"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(message)}</td></tr>`;
    document.getElementById('qualTableBody').innerHTML = `<tr><td colspan="9" class="error-cell"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(message)}</td></tr>`;
}

function formatHostVerification(model) {
    const verification = model.host_test_verification || 'unverified';
    const freshness = model.host_test_freshness || 'missing';
    const label = verification.charAt(0).toUpperCase() + verification.slice(1);
    const meta = verification === 'unverified'
        ? 'No host probe yet'
        : `${freshness} • ${model.host_test_status || 'unknown'}`;
    return `
        <span class="host-verify-badge ${verification}">
            <i class="fas ${verification === 'aligned' ? 'fa-circle-check' : verification === 'drift' ? 'fa-compass-drafting' : verification === 'failed' || verification === 'timeout' ? 'fa-triangle-exclamation' : 'fa-clock'}"></i>
            ${label}
        </span>
        <span class="host-verify-meta">${escapeHtml(meta)}</span>`;
}

function formatMeasuredMetrics(model) {
    if (model.host_test_tokens_per_sec == null && model.host_test_latency_ms == null) {
        return '<span class="measured-stack">No measurement</span>';
    }
    const tokenDelta = formatDelta(model.host_test_tokens_delta_pct, true);
    const latencyDelta = formatDelta(model.host_test_latency_delta_pct, false);
    return `
        <span class="measured-stack">
            <strong>${model.host_test_tokens_per_sec != null ? Number(model.host_test_tokens_per_sec).toFixed(1) + ' tok/s' : '—'}</strong>
            ${model.host_test_latency_ms != null ? Math.round(model.host_test_latency_ms) + 'ms host latency' : 'No latency sample'}
            <span>${tokenDelta} • ${latencyDelta}</span>
        </span>`;
}

function formatMeasuredAge(testedAt, freshness) {
    if (!testedAt) return '<span class="measured-age">Never tested</span>';
    return `<span class="measured-age">${escapeHtml(relativeTime(testedAt))}<br>${escapeHtml(freshness || 'unknown')}</span>`;
}

function formatDelta(value, higherIsBetter) {
    if (value == null) return '<span class="delta-neutral">No delta</span>';
    const positive = value > 0;
    const good = higherIsBetter ? positive : !positive;
    const cls = good ? 'delta-good' : 'delta-bad';
    const sign = value > 0 ? '+' : '';
    return `<span class="${cls}">${sign}${value}% vs benchmark</span>`;
}

function relativeTime(value) {
    const sec = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
    if (sec < 60) return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
}

function getRankDisplay(idx) {
    const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
    return idx < 3 ? medals[idx] : (idx + 1);
}

function getTopCategory(categoryAverages) {
    const entries = Object.entries(categoryAverages).filter(([_, score]) => score > 0);
    if (entries.length === 0) return '-';
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
}

function getScoreClass(score, max) {
    const pct = (score / max) * 100;
    if (pct >= 80) return 'score-high';
    if (pct >= 60) return 'score-medium';
    return 'score-low';
}

function getScoreColor(score) {
    if (score >= 8) return '#22c55e';
    if (score >= 6) return '#3b82f6';
    if (score >= 4) return '#eab308';
    return '#ef4444';
}

function getCoverageColor(coverage) {
    if (coverage >= 90) return '#22c55e';
    if (coverage >= 75) return '#3b82f6';
    if (coverage >= 50) return '#eab308';
    return '#ef4444';
}

function getLevelColor(level) {
    const colors = {
        1: '#22c55e', 2: '#84cc16', 3: '#eab308', 4: '#f97316', 5: '#9333ea'
    };
    return colors[level] || '#64748b';
}

function formatCategory(cat) {
    if (!cat || cat === '-') return '-';
    return cat.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function extractHostName(hostUrl) {
    if (!hostUrl) return '';
    // Use server-provided host names first
    if (HOST_NAMES[hostUrl]) return HOST_NAMES[hostUrl];
    if (hostUrl.includes('localhost') || hostUrl.includes('127.0.0.1')) return 'Local';
    return hostUrl.replace('http://', '').replace('https://', '').replace(':11434', '');
}

function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function renderCategoryWeights() {
    const grid = document.getElementById('weightsGrid');
    if (!grid) return;
    const sorted = Object.entries(CATEGORY_WEIGHTS).sort((a, b) => b[1] - a[1]);
    grid.innerHTML = sorted.map(([category, weight]) => `
        <div class="weight-item">
            <span class="weight-category">${formatCategory(category)}</span>
            <div class="weight-bar-container">
                <div class="weight-bar" style="width: ${weight * 100 * 2}%;"></div>
            </div>
            <span class="weight-value">${(weight * 100).toFixed(0)}%</span>
        </div>
    `).join('');
}

// ============================================================================
// CATEGORY HEATMAP
// ============================================================================

async function loadCategoryHeatmap() {
    try {
        const result = await fetchBenchmarkJson('/api/benchmark/category-heatmap');
        if (result.status !== 'success') return;
        renderHeatmap(result.data);
    } catch (_) { /* non-critical */ }
}

function heatmapColor(score) {
    if (score === null || score === undefined) return 'rgba(255,255,255,0.03)';
    const pct = Math.max(0, Math.min(10, score)) / 10;
    if (pct >= 0.8) return `rgba(34, 197, 94, ${0.2 + pct * 0.5})`;
    if (pct >= 0.6) return `rgba(59, 130, 246, ${0.2 + pct * 0.4})`;
    if (pct >= 0.4) return `rgba(234, 179, 8, ${0.2 + pct * 0.3})`;
    return `rgba(239, 68, 68, ${0.15 + pct * 0.3})`;
}

function renderHeatmap(data) {
    const { models, categories, matrix } = data;
    if (!models || models.length === 0) return;

    const thead = document.getElementById('heatmapHead');
    const tbody = document.getElementById('heatmapBody');
    if (!thead || !tbody) return;

    thead.innerHTML = `<tr>
        <th style="min-width:160px;position:sticky;left:0;background:var(--bg-secondary);z-index:1">Model</th>
        ${categories.map(c => `<th style="font-size:0.7rem;text-align:center;min-width:65px;writing-mode:vertical-rl;transform:rotate(180deg);padding:6px 2px">${formatCategory(c)}</th>`).join('')}
    </tr>`;

    tbody.innerHTML = models.map((m, mi) => {
        const row = matrix[mi];
        const modelName = escapeHtml(m.model);
        const hostName = extractHostName(m.host);
        return `<tr>
            <td style="position:sticky;left:0;background:var(--bg-secondary);z-index:1;font-size:0.8rem">
                ${modelName}${hostName ? ` <span style="opacity:0.4;font-size:0.7rem">${escapeHtml(hostName)}</span>` : ''}
            </td>
            ${row.map(score => {
                const bg = heatmapColor(score);
                const display = score !== null ? score.toFixed(1) : '';
                return `<td style="text-align:center;font-size:0.75rem;background:${bg};color:#fff;padding:4px 2px">${display}</td>`;
            }).join('')}
        </tr>`;
    }).join('');
}
