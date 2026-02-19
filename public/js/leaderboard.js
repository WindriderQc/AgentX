/**
 * Unified Leaderboard - Performance & Quality Boards
 * Combines composite scoring (speed+quality) with generalist scoring (quality-only)
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

// Category weights loaded from backend API (single source of truth)
let CATEGORY_WEIGHTS = {};

// Leaderboard tab groups - benchmark categories grouped into UI-friendly tabs
const LEADERBOARD_TAB_GROUPS = [
    { key: '',          label: 'All Models',  faIcon: 'fa-globe',       categories: [] },
    { key: 'coding',    label: 'Coding',      faIcon: 'fa-code',        categories: ['coding'] },
    { key: 'reasoning', label: 'Reasoning',   faIcon: 'fa-brain',       categories: ['reasoning', 'multi-turn-reasoning'] },
    { key: 'knowledge', label: 'Knowledge',   faIcon: 'fa-book',        categories: ['factual', 'general', 'context-retention'] },
    { key: 'creative',  label: 'Creative',    faIcon: 'fa-paint-brush', categories: ['creative', 'edge-cases'] },
    { key: 'language',  label: 'Language',     faIcon: 'fa-language',    categories: ['instruction-following', 'summarization', 'translation'] },
    { key: 'math',      label: 'Math',        faIcon: 'fa-calculator',  categories: ['math'] }
];

// Profile weight configurations for Performance Board
const PROFILE_WEIGHTS = {
    balanced: {
        title: 'Balanced Profile',
        quality: 40,
        speed: 40,
        reliability: 20,
        note: 'Best for general-purpose use cases'
    },
    interactive: {
        title: 'Interactive Profile',
        quality: 25,
        speed: 55,
        reliability: 20,
        note: 'Optimized for chatbots & real-time applications where response speed matters most'
    },
    reasoning: {
        title: 'Reasoning Profile',
        quality: 70,
        speed: 10,
        reliability: 20,
        note: 'Optimized for complex analysis & problem-solving where accuracy trumps speed'
    },
    coding: {
        title: 'Coding Profile',
        quality: 45,
        speed: 35,
        reliability: 20,
        note: 'Balanced for code generation with slight quality preference'
    }
};

// Chart.js defaults
if (typeof Chart !== 'undefined') {
    Chart.defaults.animation = false;
    Chart.defaults.color = '#94a3b8';
}

// ============================================================================
// STATE
// ============================================================================

let performanceData = [];  // From /api/benchmark/dashboard
let qualityData = [];      // From /api/benchmark/generalist-leaderboard (backend calculated)
let charts = {};

// Sorting and filtering state
let currentCategoryFilter = '';  // Tab group key
let currentCategoryMatchList = [];  // Benchmark categories to match for active tab
let currentPerfSort = 'composite';
let currentPerfSortDir = 'desc';
let currentQualSort = 'generalist';
let currentQualSortDir = 'desc';

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    buildCategoryTabs();
    updateProfileWeights();
    await refreshAllData();
    renderCategoryWeights();
});

/**
 * Build category filter tabs from LEADERBOARD_TAB_GROUPS config
 */
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
            loadQualityData()
        ]);
        updateStats();
        updateBestOverallBanner(currentCategoryFilter);
        initCharts();  // Create charts first
        renderPerformanceBoard();  // Then render (which updates charts)
        renderQualityBoard();
    } catch (err) {
        console.error('Failed to load data:', err);
        showError(err.message);
    }
}

// ============================================================================
// CATEGORY FILTERING & SORTING
// ============================================================================

/**
 * Switch category filter tab
 */
function switchCategoryTab(tabKey) {
    currentCategoryFilter = tabKey;

    // Find the tab group to get its category match list
    const group = LEADERBOARD_TAB_GROUPS.find(g => g.key === tabKey);
    currentCategoryMatchList = group ? group.categories : [];

    // Update tab styling
    document.querySelectorAll('.category-tab').forEach(tab => {
        const isActive = tab.dataset.category === tabKey;
        tab.classList.toggle('active', isActive);
    });

    // Update best overall banner
    updateBestOverallBanner(tabKey);

    // Re-render both boards with new filter
    renderPerformanceBoard();
    renderQualityBoard();
}

/**
 * Update the Best Overall banner based on current category filter
 */
function updateBestOverallBanner(category) {
    const profile = document.getElementById('perfProfile')?.value || 'balanced';

    // Get filtered data
    let data = performanceData.map(model => ({
        ...model,
        calculated_composite: calculateCompositeScore(model, profile)
    }));

    if (category) {
        data = filterByCategory(data, 'recommended_category');
    }

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

    // Find best model
    const best = data.reduce((a, b) => a.calculated_composite > b.calculated_composite ? a : b);

    if (modelEl) modelEl.textContent = best.model;
    if (scoreEl) scoreEl.textContent = `Score: ${best.calculated_composite.toFixed(1)}`;

    // Update subtitle based on category
    if (category) {
        const group = LEADERBOARD_TAB_GROUPS.find(g => g.key === category);
        if (subtitleEl) subtitleEl.textContent = `Top ${group?.label || category} model by composite score`;
    } else {
        if (subtitleEl) subtitleEl.textContent = 'All models ranked by composite score';
    }
}

/**
 * Sort Performance Board by column
 */
function sortPerformanceBy(column) {
    // Toggle direction if same column, otherwise default to desc
    if (currentPerfSort === column) {
        currentPerfSortDir = currentPerfSortDir === 'desc' ? 'asc' : 'desc';
    } else {
        currentPerfSort = column;
        currentPerfSortDir = (column === 'latency' || column === 'model') ? 'asc' : 'desc';
    }

    // Update header icons
    updateSortIcons('perfTable', currentPerfSort, currentPerfSortDir);

    renderPerformanceBoard();
}

/**
 * Sort Quality Board by column
 */
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

/**
 * Update sort icons in table header
 */
function updateSortIcons(tableId, sortColumn, sortDir) {
    const table = document.getElementById(tableId);
    if (!table) return;

    table.querySelectorAll('th.sortable').forEach(th => {
        const col = th.dataset.sort;
        // Use last <i> element — columns with info-circle have two <i> tags
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

/**
 * Filter data by model category using grouped tab matching.
 * When a tab is active, matches any benchmark category in the tab group's list.
 */
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

/**
 * Reset all benchmark tests
 */
async function resetAllTests() {
    const first = confirm('Reset ALL benchmark tests? This will clear the leaderboard and charts.');
    if (!first) return;
    const second = confirm('Are you ABSOLUTELY sure? This cannot be undone.');
    if (!second) return;

    const btn = document.getElementById('resetAllBtn');
    try {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Resetting...';
        }

        const res = await fetch('/api/benchmark/results', { method: 'DELETE' });
        if (!res.ok) {
            const json = await res.json().catch(() => null);
            const msg = json?.error || json?.message || `HTTP ${res.status}`;
            throw new Error(msg);
        }

        await refreshAllData();
    } catch (err) {
        console.error('Failed to reset benchmark results:', err);
        alert(`Failed to reset results: ${err.message}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-trash"></i> Reset All';
        }
    }
}

/**
 * Reset only failed benchmark tests
 */
async function resetFailedTests() {
    const first = confirm('Reset FAILED benchmark tests only? Successful results will be kept.');
    if (!first) return;

    const btn = document.getElementById('resetFailedBtn');
    try {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Resetting...';
        }

        const res = await fetch('/api/benchmark/results/failed', { method: 'DELETE' });
        if (!res.ok) {
            const json = await res.json().catch(() => null);
            const msg = json?.error || json?.message || `HTTP ${res.status}`;
            throw new Error(msg);
        }

        await refreshAllData();
    } catch (err) {
        console.error('Failed to reset failed results:', err);
        alert(`Failed to reset failed results: ${err.message}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-redo"></i> Reset Failed';
        }
    }
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadPerformanceData() {
    const response = await fetch('/api/benchmark/dashboard?sort=composite');
    if (!response.ok) throw new Error('Failed to load dashboard data');
    const data = await response.json();
    performanceData = data.data?.model_stats || [];
}

async function loadQualityData() {
    // Fetch generalist scores from backend API (single source of truth)
    const response = await fetch('/api/benchmark/generalist-leaderboard');
    if (!response.ok) throw new Error('Failed to load generalist leaderboard');
    const result = await response.json();
    if (result.status !== 'success') throw new Error(result.error || 'API error');

    const { leaderboard, categoryWeights } = result.data;
    CATEGORY_WEIGHTS = categoryWeights;

    // Transform API response to expected format
    qualityData = leaderboard.map(model => {
        const scores = Object.values(model.categoryAverages).filter(s => s > 0);
        const avgScore = scores.length > 0
            ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
            : 0;

        // Calculate consistency score from stddev (100 - stddev, capped at 0-100)
        const stdDev = model.avgWithinCategoryStdDev || 0;
        const consistencyScore = Math.max(0, Math.round(100 - stdDev));

        // Find matching performance data for testsByLevel and totalTests
        const perfModel = performanceData.find(p => p.model === model.model && p.host === model.host);

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
            avgScore,
            totalTests: perfModel?.tests || model.testedCategories || 0,
            testsByLevel: perfModel?.level_stats || {},
            stdDev: Math.round(stdDev * 10) / 10
        };
    });
}

// ============================================================================
// UTILITY FUNCTIONS (Quality Board)
// ============================================================================

function getTopCategory(categoryAverages) {
    const entries = Object.entries(categoryAverages).filter(([_, score]) => score > 0);
    if (entries.length === 0) return '-';
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
}

// ============================================================================
// PROFILE WEIGHTS UPDATE
// ============================================================================

function updateProfileWeights() {
    const profile = document.getElementById('perfProfile')?.value || 'balanced';
    const config = PROFILE_WEIGHTS[profile] || PROFILE_WEIGHTS.balanced;

    // Update title
    const titleEl = document.getElementById('profileTitle');
    if (titleEl) titleEl.textContent = config.title;

    // Update weight pills
    const qualityEl = document.querySelector('#weightQuality .weight-pct');
    const speedEl = document.querySelector('#weightSpeed .weight-pct');
    const reliabilityEl = document.querySelector('#weightReliability .weight-pct');

    if (qualityEl) qualityEl.textContent = config.quality + '%';
    if (speedEl) speedEl.textContent = config.speed + '%';
    if (reliabilityEl) reliabilityEl.textContent = config.reliability + '%';

    // Update note
    const noteEl = document.getElementById('profileNote');
    if (noteEl) noteEl.textContent = config.note;
}

// ============================================================================
// PERFORMANCE BOARD RENDERING
// ============================================================================

function calculateCompositeScore(model, profile) {
    const config = PROFILE_WEIGHTS[profile] || PROFILE_WEIGHTS.balanced;

    const quality = parseFloat(model.avg_quality) || 0;  // 0-10 scale

    // Normalize speed metrics to 0-10 scale
    // Latency: lower is better, assume 0-10000ms range, invert
    const latency = model.avg_latency || 5000;
    const latencyScore = Math.max(0, Math.min(10, 10 - (latency / 1000)));

    // Tokens/sec: higher is better, assume 0-100 range
    const tokensPerSec = parseFloat(model.avg_tokens_per_sec) || 0;
    const tokensScore = Math.min(10, tokensPerSec / 10);

    // Speed is average of latency and throughput scores
    const speedScore = (latencyScore + tokensScore) / 2;

    // Reliability: success rate (tests - failed) / tests
    const tests = model.tests || 1;
    const failed = model.failed_tests || 0;
    const reliabilityScore = ((tests - failed) / tests) * 10;

    // Calculate weighted composite
    const composite = (
        (quality * config.quality / 100) +
        (speedScore * config.speed / 100) +
        (reliabilityScore * config.reliability / 100)
    );

    return Math.round(composite * 10) / 10;
}

function renderPerformanceBoard() {
    const profile = document.getElementById('perfProfile')?.value || 'balanced';

    // Calculate composite scores based on selected profile
    let data = performanceData.map(model => ({
        ...model,
        calculated_composite: calculateCompositeScore(model, profile)
    }));

    // Apply category filter
    data = filterByCategory(data, 'recommended_category');

    // Calculate offenders and best overall (from filtered data)
    const offenders = calculateOffenders(data);
    const bestOverall = data.length > 0 ? data.reduce((a, b) => a.calculated_composite > b.calculated_composite ? a : b) : null;

    // Sort using state variables
    const sortMultiplier = currentPerfSortDir === 'desc' ? 1 : -1;
    data.sort((a, b) => {
        let comparison = 0;
        switch (currentPerfSort) {
            case 'composite':
                comparison = b.calculated_composite - a.calculated_composite;
                break;
            case 'quality':
                comparison = parseFloat(b.avg_quality || 0) - parseFloat(a.avg_quality || 0);
                break;
            case 'latency':
                // Latency: lower is better, so reverse default
                comparison = (a.avg_latency || 99999) - (b.avg_latency || 99999);
                break;
            case 'tokens':
                comparison = parseFloat(b.avg_tokens_per_sec || 0) - parseFloat(a.avg_tokens_per_sec || 0);
                break;
            case 'reliability':
                const relA = ((a.tests || 1) - (a.failed_tests || 0)) / (a.tests || 1);
                const relB = ((b.tests || 1) - (b.failed_tests || 0)) / (b.tests || 1);
                comparison = relB - relA;
                break;
            case 'model':
                comparison = (a.model || '').localeCompare(b.model || '');
                return currentPerfSortDir === 'asc' ? comparison : -comparison;
            default:
                return 0;
        }
        return comparison * sortMultiplier;
    });

    const tbody = document.getElementById('perfTableBody');

    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No data available. <a href="/benchmark.html">Run benchmarks</a></td></tr>';
        return;
    }

    tbody.innerHTML = data.map((model, idx) => {
        const composite = model.calculated_composite;
        const quality = Number.isFinite(parseFloat(model.avg_quality)) ? parseFloat(model.avg_quality) : 0;
        const latency = model.avg_latency ?? 0;
        const tokensPerSec = Number.isFinite(parseFloat(model.avg_tokens_per_sec)) ? parseFloat(model.avg_tokens_per_sec) : 0;
        const tests = model.tests || 1;
        const failed = model.failed_tests ?? 0;
        const reliabilityPct = Math.round(((tests - failed) / tests) * 100);

        const hostName = model.host ? extractHostName(model.host) : '';
        const levelStats = model.level_stats || {};
        const levelStarsHtml = buildLevelStars(levelStats);
        const isBestOverall = bestOverall && model.model === bestOverall.model && model.host === bestOverall.host;
        const badgesHtml = buildModelBadges(model, offenders, isBestOverall);

        return `
            <tr class="${idx < 3 ? 'top-rank rank-' + (idx + 1) : ''} ${isBestOverall ? 'best-overall' : ''}" onclick="showModelDetail('${escapeHtml(model.model).replace(/'/g, "\\'")}', 'performance', '${escapeHtml(model.host || '').replace(/'/g, "\\'")}')">
                <td class="rank-col">${getRankDisplay(idx)}</td>
                <td class="model-col">
                    <span class="model-name">${isBestOverall ? '👑 ' : ''}${escapeHtml(model.model)}</span>
                    ${hostName ? `<span class="model-host">${escapeHtml(hostName)}</span>` : ''}
                    <div class="model-badges">${badgesHtml}</div>
                    <div class="level-stars">${levelStarsHtml}</div>
                </td>
                <td class="score-col ${getScoreClass(quality, 10)}">${quality.toFixed(1)}</td>
                <td class="latency-col">${latency.toLocaleString()}ms</td>
                <td class="tokens-col">${tokensPerSec.toFixed(1)}</td>
                <td class="reliability-col ${reliabilityPct >= 95 ? 'high' : reliabilityPct >= 80 ? 'medium' : 'low'}">${reliabilityPct}%</td>
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

    // Apply category filter - look up category from performance data using grouped matching
    if (currentCategoryFilter && currentCategoryMatchList.length > 0) {
        data = data.filter(m => {
            const perfModel = performanceData.find(p => p.model === m.name && p.host === m.host);
            const category = (perfModel?.recommended_category || '').toLowerCase();
            return currentCategoryMatchList.some(c => c.toLowerCase() === category);
        });
    }

    // Filter by coverage
    data = data.filter(m => m.coverage >= minCoverage);

    // Sort using state variables
    const sortMultiplier = currentQualSortDir === 'desc' ? 1 : -1;
    data.sort((a, b) => {
        let comparison = 0;
        switch (currentQualSort) {
            case 'generalist':
                comparison = b.generalistScore - a.generalistScore;
                break;
            case 'coverage':
                comparison = b.coverage - a.coverage;
                break;
            case 'consistency':
                comparison = b.consistencyScore - a.consistencyScore;
                break;
            case 'avgScore':
                comparison = b.avgScore - a.avgScore;
                break;
            case 'model':
                comparison = (a.name || '').localeCompare(b.name || '');
                return currentQualSortDir === 'asc' ? comparison : -comparison;
            default:
                return 0;
        }
        return comparison * sortMultiplier;
    });

    const tbody = document.getElementById('qualTableBody');

    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No data matches filters. <a href="/benchmark.html">Run benchmarks</a></td></tr>';
        return;
    }

    tbody.innerHTML = data.map((model, idx) => {
        const escapedName = escapeHtml(model.name).replace(/'/g, "\\'");
        const hostName = model.host ? extractHostName(model.host) : '';
        // Build score breakdown string
        const penaltyStr = model.coveragePenalty > 0 ? `<span class="breakdown-penalty">-${model.coveragePenalty.toFixed(0)}</span>` : '';
        const bonusStr = model.consistencyBonus > 0 ? `<span class="breakdown-bonus">+${model.consistencyBonus}</span>` : '';

        return `
            <tr class="${idx < 3 ? 'top-rank rank-' + (idx + 1) : ''}">
                <td class="rank-col">${getRankDisplay(idx)}</td>
                <td class="model-col">
                    <span class="model-name">${escapeHtml(model.name)}</span>
                    ${hostName ? `<span class="model-host">${escapeHtml(hostName)}</span>` : ''}
                    ${model.consistencyBonus > 0 ? '<span class="badge badge-consistent" title="Low variance across categories">Consistent</span>' : ''}
                </td>
                <td class="score-col">
                    <div class="score-main">${model.generalistScore.toFixed(1)}</div>
                    <div class="score-breakdown">${model.weightedSum.toFixed(1)} ${penaltyStr} ${bonusStr}</div>
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
                    <span class="stddev-label">σ=${model.stdDev}</span>
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
// CHARTS
// ============================================================================

function initCharts() {
    const chartConfig = (label, color) => ({
        type: 'bar',
        data: {
            labels: [],
            datasets: [{
                label,
                data: [],
                backgroundColor: color.replace('1)', '0.7)'),
                borderColor: color,
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: { beginAtZero: false, grace: '15%' }
            }
        }
    });

    // Latency Chart
    const latencyCtx = document.getElementById('perfLatencyChart');
    if (latencyCtx) {
        if (charts.latency) charts.latency.destroy();
        charts.latency = new Chart(latencyCtx, chartConfig('Latency (ms)', 'rgba(231, 76, 60, 1)'));
    }

    // Tokens/sec Chart
    const tokensCtx = document.getElementById('perfTokensChart');
    if (tokensCtx) {
        if (charts.tokens) charts.tokens.destroy();
        charts.tokens = new Chart(tokensCtx, chartConfig('Tokens/sec', 'rgba(52, 152, 219, 1)'));
    }

    // Quality Chart
    const qualityCtx = document.getElementById('perfQualityChart');
    if (qualityCtx) {
        if (charts.quality) charts.quality.destroy();
        charts.quality = new Chart(qualityCtx, chartConfig('Quality Score', 'rgba(46, 204, 113, 1)'));
    }

    // Composite Chart
    const compositeCtx = document.getElementById('perfCompositeChart');
    if (compositeCtx) {
        if (charts.composite) charts.composite.destroy();
        charts.composite = new Chart(compositeCtx, chartConfig('Composite Score', 'rgba(241, 196, 15, 1)'));
    }
}

function updatePerformanceCharts(data) {
    const top10 = data.slice(0, 10);
    const labels = top10.map(m => truncateLabel(m.model));

    // Update each chart if it exists
    if (charts.latency) {
        charts.latency.data.labels = labels;
        charts.latency.data.datasets[0].data = top10.map(m => m.avg_latency || 0);
        charts.latency.update();
    }

    if (charts.tokens) {
        charts.tokens.data.labels = labels;
        charts.tokens.data.datasets[0].data = top10.map(m => parseFloat(m.avg_tokens_per_sec) || 0);
        charts.tokens.update();
    }

    if (charts.quality) {
        charts.quality.data.labels = labels;
        charts.quality.data.datasets[0].data = top10.map(m => parseFloat(m.avg_quality) || 0);
        charts.quality.update();
    }

    if (charts.composite) {
        charts.composite.data.labels = labels;
        charts.composite.data.datasets[0].data = top10.map(m => m.calculated_composite || 0);
        charts.composite.update();
    }
}

function truncateLabel(label) {
    return label.length > 20 ? label.substring(0, 18) + '...' : label;
}

// ============================================================================
// CATEGORY WEIGHTS DISPLAY
// ============================================================================

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
// MODEL DETAIL MODAL
// ============================================================================

function showModelDetail(modelName, board, host) {
    const modal = document.getElementById('modelDetailModal');
    const modalName = document.getElementById('modalModelName');
    const modalBody = document.getElementById('modalBody');

    modalName.textContent = modelName;

    if (board === 'performance') {
        const model = host
            ? performanceData.find(m => m.model === modelName && m.host === host)
            : performanceData.find(m => m.model === modelName);
        if (!model) return;
        const currentProfile = document.getElementById('perfProfile')?.value || 'balanced';
        const currentComposite = calculateCompositeScore(model, currentProfile);

        const tests = model.tests || 1;
        const failed = model.failed_tests || 0;
        const reliabilityPct = Math.round(((tests - failed) / tests) * 100);

        modalBody.innerHTML = `
            <div class="detail-grid">
                <div class="detail-item" title="Weighted combination of Quality, Speed, and Reliability based on selected profile">
                    <span class="detail-label">Composite Score <i class="fas fa-info-circle tip-icon"></i></span>
                    <span class="detail-value highlight">${parseFloat(currentComposite || 0).toFixed(1)}</span>
                </div>
                <div class="detail-item" title="Average quality score from judge evaluations (0-10 scale)">
                    <span class="detail-label">Quality Score <i class="fas fa-info-circle tip-icon"></i></span>
                    <span class="detail-value">${parseFloat(model.avg_quality || 0).toFixed(1)}</span>
                </div>
                <div class="detail-item" title="Average time from request to first response. Lower is better for interactive use.">
                    <span class="detail-label">Avg Latency <i class="fas fa-info-circle tip-icon"></i></span>
                    <span class="detail-value">${(model.avg_latency || 0).toLocaleString()}ms</span>
                </div>
                <div class="detail-item" title="Output generation speed. Higher is better for long responses.">
                    <span class="detail-label">Tokens/sec <i class="fas fa-info-circle tip-icon"></i></span>
                    <span class="detail-value">${parseFloat(model.avg_tokens_per_sec || 0).toFixed(1)}</span>
                </div>
                <div class="detail-item" title="Success rate: ${tests - failed} successful out of ${tests} total tests">
                    <span class="detail-label">Reliability <i class="fas fa-info-circle tip-icon"></i></span>
                    <span class="detail-value">${reliabilityPct}%</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Tests (Pass/Fail)</span>
                    <span class="detail-value">${tests - failed} / ${failed}</span>
                </div>
            </div>

            <h4>Profile Scores <span class="tip-text" title="Pre-calculated composite scores for different use case profiles">ⓘ</span></h4>
            <div class="info-box">
                <span class="info-note">Each profile weights Quality, Speed, and Reliability differently for specific use cases.</span>
            </div>
            <div class="detail-grid">
                <div class="detail-item" title="Optimized for chatbots & real-time apps: Quality 25%, Speed 55%, Reliability 20%">
                    <span class="detail-label">Interactive <i class="fas fa-info-circle tip-icon"></i></span>
                    <span class="detail-value">${parseFloat(model.interactive_score || 0).toFixed(1)}</span>
                </div>
                <div class="detail-item" title="Optimized for analysis & problem-solving: Quality 60%, Speed 20%, Reliability 20%">
                    <span class="detail-label">Reasoning <i class="fas fa-info-circle tip-icon"></i></span>
                    <span class="detail-value">${parseFloat(model.reasoning_score || 0).toFixed(1)}</span>
                </div>
                <div class="detail-item" title="Balanced for code generation: Quality 45%, Speed 35%, Reliability 20%">
                    <span class="detail-label">Coding <i class="fas fa-info-circle tip-icon"></i></span>
                    <span class="detail-value">${parseFloat(model.coding_score || 0).toFixed(1)}</span>
                </div>
            </div>

            ${model.host ? `
            <h4>Host Information</h4>
            <div class="info-box">
                <div class="info-row">
                    <span class="info-label">Host:</span>
                    <span class="info-value">${extractHostName(model.host)}</span>
                </div>
            </div>
            ` : ''}
        `;
    } else {
        const model = host
            ? qualityData.find(m => m.name === modelName && m.host === host)
            : qualityData.find(m => m.name === modelName);
        if (!model) return;

        const categoryRows = Object.entries(model.categoryAverages)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, score]) => {
                const weight = CATEGORY_WEIGHTS[cat] || 0;
                const isUntested = !(Number.isFinite(score) && score > 0);
                const contribution = isUntested ? 0 : (score * weight);
                const barBg = isUntested ? 'rgba(255,255,255,0.18)' : getScoreColor(score);
                const rowStyle = isUntested ? 'opacity: 0.65;' : '';
                const scoreText = isUntested ? '—' : score.toFixed(1);
                const contribText = isUntested ? '—' : contribution.toFixed(1);

                return `
                    <div class="category-row" style="${rowStyle}">
                        <span class="cat-name">${formatCategory(cat)}${isUntested ? ' <span style="color: var(--text-muted); font-size: 0.85em;">(not covered)</span>' : ''}</span>
                        <div class="cat-bar-container">
                            <div class="cat-bar" style="width: ${isUntested ? 2 : score}%; background: ${barBg};"></div>
                        </div>
                        <span class="cat-score">${scoreText}</span>
                        <span class="cat-weight">${(weight * 100).toFixed(0)}%</span>
                        <span class="cat-contrib">${contribText}</span>
                    </div>
                `;
            }).join('');

        const testedCats = Object.values(model.categoryAverages).filter(s => s > 0).length;

        // Build level distribution display
        const levels = Object.keys(model.testsByLevel || {}).map(Number).sort((a, b) => a - b);
        const levelBars = levels.map(level => {
            const count = model.testsByLevel[level];
            const maxCount = Math.max(...Object.values(model.testsByLevel));
            const pct = (count / maxCount) * 100;
            const levelColor = getLevelColor(level);
            return `<div class="level-bar-row">
                <span class="level-num">L${level}</span>
                <div class="level-bar-bg"><div class="level-bar-fill" style="width: ${pct}%; background: ${levelColor};"></div></div>
                <span class="level-count">${count}</span>
            </div>`;
        }).join('');

        modalBody.innerHTML = `
            <div class="detail-grid">
                <div class="detail-item">
                    <span class="detail-label">Generalist Score <i class="fas fa-info-circle tip-icon" data-tip="Final calculated score combining weighted performance, coverage penalty, and consistency bonus"></i></span>
                    <span class="detail-value highlight">${model.generalistScore.toFixed(1)}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Coverage <i class="fas fa-info-circle tip-icon" data-tip="Percentage of the 11 task categories this model has been tested on. Higher coverage = more reliable ranking."></i></span>
                    <span class="detail-value">${model.coverage}%</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Consistency <i class="fas fa-info-circle tip-icon" data-tip="How consistent the model performs across categories. Lower standard deviation (σ) = more predictable performance."></i></span>
                    <span class="detail-value">${model.consistencyScore}%</span>
                    <span class="detail-sub">σ = ${model.stdDev}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Total Tests</span>
                    <span class="detail-value">${model.totalTests}</span>
                </div>
            </div>

            <h4>Tests by Difficulty Level <span class="tip-text" data-tip="Distribution of tests across difficulty levels 1-10. Green=easy, Yellow=medium, Red=hard, Purple=extreme">ⓘ</span></h4>
            <div class="level-distribution">
                ${levelBars || '<span class="no-data">No level data</span>'}
            </div>

            <div class="info-box">
                <div class="info-row">
                    <span class="info-label">Unweighted Avg (${testedCats} categories): <i class="fas fa-info-circle tip-icon" data-tip="Simple arithmetic mean of scores, treating all categories equally regardless of their assigned weights"></i></span>
                    <span class="info-value">${model.avgScore.toFixed(1)}</span>
                </div>
                <span class="info-note">Simple mean across tested categories, ignoring weights</span>
            </div>

                <div class="info-box consistency-info">
                <div class="info-row">
                    <span class="info-label">Standard Deviation (σ): <i class="fas fa-info-circle tip-icon" data-tip="Statistical measure of how much scores vary between categories. Lower = more consistent performance."></i></span>
                    <span class="info-value">${model.stdDev}</span>
                </div>
                <span class="info-note">
                    Measures score variance across categories.
                    <strong>σ &lt; 15</strong> = Consistent performer (+5 bonus).
                    Lower σ = more reliable across different task types.
                </span>
            </div>

            <h4>Score Breakdown <span class="tip-text" data-tip="How the final Generalist Score is calculated from components">ⓘ</span></h4>
            <div class="formula-breakdown">
                <div class="formula-line">
                    <span>Weighted Sum: <i class="fas fa-info-circle tip-icon" data-tip="Sum of (category_score × category_weight) for all tested categories. Core component of the generalist score."></i></span>
                    <span class="formula-value">+${model.weightedSum.toFixed(1)}</span>
                </div>
                ${model.coveragePenalty > 0 ? `
                    <div class="formula-line penalty">
                        <span>Coverage Penalty: <i class="fas fa-info-circle tip-icon" data-tip="Penalty for missing category coverage. Max penalty is -20 points. Formula: (1 - coverage%) × 20. Test more categories to reduce this!"></i></span>
                        <span class="formula-value">-${model.coveragePenalty.toFixed(1)}</span>
                    </div>
                ` : ''}
                ${model.consistencyBonus > 0 ? `
                    <div class="formula-line bonus">
                        <span>Consistency Bonus: <i class="fas fa-info-circle tip-icon" data-tip="Bonus awarded for consistent performance across categories. Earned when standard deviation (σ) is less than 15."></i></span>
                        <span class="formula-value">+${model.consistencyBonus}</span>
                    </div>
                ` : ''}
                <div class="formula-line total">
                    <span><strong>Final Score:</strong></span>
                    <span class="formula-value"><strong>${model.generalistScore.toFixed(1)}</strong></span>
                </div>
            </div>

            <h4>Category Performance <span class="tip-text" data-tip="Breakdown by task category showing score, assigned weight, and contribution to final score">ⓘ</span></h4>
            <div class="category-breakdown">
                <div class="category-header">
                    <span data-tip="Task category type">Category</span>
                    <span data-tip="Average quality score (0-10) in this category">Score</span>
                    <span data-tip="How much this category contributes to the total (weights sum to 100%)">Weight</span>
                    <span data-tip="Actual points contributed: score × weight">Contrib</span>
                </div>
                ${categoryRows}
            </div>
        `;
    }

    modal.style.display = 'flex';
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

function showMethodology() {
    document.getElementById('methodologyModal').style.display = 'flex';
}

// Close modals on outside click
window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
    }
};

// ============================================================================
// STATS & UTILITIES
// ============================================================================

function updateStats() {
    document.getElementById('statModels').textContent = performanceData.length;

    // Sum total tests from performance data
    const totalTests = performanceData.reduce((sum, m) => sum + (m.tests || 0) + (m.failed_tests || 0), 0);
    document.getElementById('statTests').textContent = totalTests.toLocaleString();

    // Count categories from category weights (backend source of truth)
    const categoryCount = Object.keys(CATEGORY_WEIGHTS).length || 11;
    document.getElementById('statCategories').textContent = categoryCount;

    document.getElementById('statUpdated').textContent = new Date().toLocaleTimeString();
}

function showLoading() {
    document.getElementById('perfTableBody').innerHTML = '<tr><td colspan="8" class="loading-cell"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>';
    document.getElementById('qualTableBody').innerHTML = '<tr><td colspan="8" class="loading-cell"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>';
}

function showError(message) {
    const errorHtml = `<tr><td colspan="8" class="error-cell"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(message)}</td></tr>`;
    document.getElementById('perfTableBody').innerHTML = errorHtml;
    document.getElementById('qualTableBody').innerHTML = errorHtml;
}

function getRankDisplay(idx) {
    const medals = ['🥇', '🥈', '🥉'];
    return idx < 3 ? medals[idx] : (idx + 1);
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
    // Color gradient from easy (green) to hard (red/purple)
    const colors = {
        1: '#22c55e',  // Green - easy
        2: '#4ade80',
        3: '#84cc16',
        4: '#a3e635',
        5: '#eab308',  // Yellow - medium
        6: '#f59e0b',
        7: '#f97316',  // Orange
        8: '#ef4444',  // Red - hard
        9: '#dc2626',
        10: '#9333ea'  // Purple - extreme
    };
    return colors[level] || '#64748b';
}

function formatCategory(cat) {
    if (!cat || cat === '-') return '-';
    return cat.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function extractHostName(hostUrl) {
    if (!hostUrl) return '';
    // Map known hosts to friendly names
    if (hostUrl.includes('192.168.2.99')) return 'UGFrank';
    if (hostUrl.includes('192.168.2.12')) return 'UGBrutal';
    if (hostUrl.includes('192.168.2.66')) return 'UGClawdX';
    if (hostUrl.includes('localhost') || hostUrl.includes('127.0.0.1')) return 'Local';
    // Fallback: strip protocol and port
    return hostUrl.replace('http://', '').replace('https://', '').replace(':11434', '');
}

// ============================================================================
// BADGES (Offenders, Best Overall, Categories)
// ============================================================================

function calculateOffenders(data) {
    if (!data || data.length === 0) return {};

    // Find worst performers
    const withLatency = data.filter(m => m.avg_latency > 0);
    const withTps = data.filter(m => parseFloat(m.avg_tokens_per_sec) > 0);
    const withQuality = data.filter(m => parseFloat(m.avg_quality) > 0);
    const withFailures = data.filter(m => (m.failed_tests || 0) > 0);

    return {
        slowest: withLatency.length ? withLatency.reduce((a, b) => a.avg_latency > b.avg_latency ? a : b) : null,
        lowestTps: withTps.length ? withTps.reduce((a, b) => parseFloat(a.avg_tokens_per_sec) < parseFloat(b.avg_tokens_per_sec) ? a : b) : null,
        lowestQuality: withQuality.length ? withQuality.reduce((a, b) => parseFloat(a.avg_quality) < parseFloat(b.avg_quality) ? a : b) : null,
        mostFailures: withFailures.length ? withFailures.reduce((a, b) => (a.failed_tests || 0) > (b.failed_tests || 0) ? a : b) : null
    };
}

function buildModelBadges(model, offenders, isBestOverall) {
    let badges = '';

    // Best Overall Crown
    if (isBestOverall) {
        badges += `<span class="badge badge-best" title="👑 Best Overall Composite Score">👑 BEST</span>`;
    }

    // Category badge from recommended_category
    if (model.recommended_category) {
        const cat = model.recommended_category;
        const catConfig = getCategoryConfig(cat);
        badges += `<span class="badge badge-category ${catConfig.cssClass}" style="--cat-color: ${catConfig.color}; --cat-bg: ${catConfig.bg};" title="Best at: ${catConfig.label}">
            <i class="fas ${catConfig.icon}"></i> ${catConfig.label}
        </span>`;
    }

    // Offender badges
    if (offenders) {
        if (offenders.slowest && offenders.slowest.model === model.model && offenders.slowest.host === model.host) {
            badges += `<span class="badge badge-offender badge-slow" title="⚠️ Worst Latency">🐌 SLOW</span>`;
        }
        if (offenders.lowestTps && offenders.lowestTps.model === model.model && offenders.lowestTps.host === model.host) {
            badges += `<span class="badge badge-offender badge-slug" title="⚠️ Worst Throughput">🐢 SLUG</span>`;
        }
        if (offenders.lowestQuality && offenders.lowestQuality.model === model.model && offenders.lowestQuality.host === model.host) {
            badges += `<span class="badge badge-offender badge-poor" title="⚠️ Lowest Quality">⭐ POOR</span>`;
        }
        if (offenders.mostFailures && offenders.mostFailures.model === model.model && offenders.mostFailures.host === model.host) {
            badges += `<span class="badge badge-offender badge-unstable" title="⚠️ Most Failures">⚠️ UNSTABLE</span>`;
        }
    }

    return badges;
}

const CATEGORY_CONFIG_MAP = {
    // Manual assignment categories
    coding:    { icon: 'fa-code',          color: '#7c9fff', bg: 'rgba(124, 159, 255, 0.15)', cssClass: 'badge-coding',     label: 'Coding' },
    reasoning: { icon: 'fa-brain',         color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.15)', cssClass: 'badge-reasoning',  label: 'Reasoning' },
    ops:       { icon: 'fa-bolt',          color: '#10b981', bg: 'rgba(16, 185, 129, 0.15)',  cssClass: 'badge-ops',        label: 'Ops/Glue' },
    specialist:{ icon: 'fa-star',          color: '#ec4899', bg: 'rgba(236, 72, 153, 0.15)',  cssClass: 'badge-specialist', label: 'Specialist' },
    generalist:{ icon: 'fa-cubes',         color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.15)', cssClass: 'badge-generalist', label: 'Generalist' },
    embedding: { icon: 'fa-vector-square', color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.15)',  cssClass: 'badge-embedding',  label: 'Embedding' },
    judge:     { icon: 'fa-gavel',         color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)',  cssClass: 'badge-judge',      label: 'Judge' },
    // AI benchmark categories
    factual:   { icon: 'fa-book',          color: '#34d399', bg: 'rgba(52, 211, 153, 0.15)',  cssClass: 'badge-factual',    label: 'Factual' },
    math:      { icon: 'fa-calculator',    color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.15)',  cssClass: 'badge-math',       label: 'Math' },
    creative:  { icon: 'fa-paint-brush',   color: '#f87171', bg: 'rgba(248, 113, 113, 0.15)', cssClass: 'badge-creative',   label: 'Creative' },
    general:   { icon: 'fa-tag',           color: '#64748b', bg: 'rgba(100, 116, 139, 0.15)', cssClass: 'badge-general',    label: 'General' },
    'instruction-following': { icon: 'fa-list-check',   color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.15)',   cssClass: 'badge-instruction-following', label: 'Instruction Following' },
    'summarization':         { icon: 'fa-compress-alt', color: '#14b8a6', bg: 'rgba(20, 184, 166, 0.15)',  cssClass: 'badge-summarization',         label: 'Summarization' },
    'translation':           { icon: 'fa-language',     color: '#f472b6', bg: 'rgba(244, 114, 182, 0.15)', cssClass: 'badge-translation',           label: 'Translation' },
    'multi-turn-reasoning':  { icon: 'fa-comments',     color: '#c084fc', bg: 'rgba(192, 132, 252, 0.15)', cssClass: 'badge-multi-turn-reasoning',  label: 'Multi-Turn' },
    'context-retention':     { icon: 'fa-memory',       color: '#fb923c', bg: 'rgba(251, 146, 60, 0.15)',  cssClass: 'badge-context-retention',     label: 'Context Retention' },
    'edge-cases':            { icon: 'fa-exclamation-triangle', color: '#a3e635', bg: 'rgba(163, 230, 53, 0.15)', cssClass: 'badge-edge-cases', label: 'Edge Cases' }
};

function getCategoryConfig(category) {
    const key = (category || '').toLowerCase();
    return CATEGORY_CONFIG_MAP[key] || {
        icon: 'fa-tag',
        color: '#95a5a6',
        bg: 'rgba(149, 165, 166, 0.15)',
        cssClass: '',
        label: category || 'Unknown'
    };
}

function buildLevelStars(levelStats) {
    if (!levelStats || typeof levelStats !== 'object') return '';

    // Show all 10 levels
    return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(level => {
        const count = Number(levelStats[level] || levelStats[String(level)] || 0);
        if (count <= 0) {
            return `<span class="level-star-slot empty" title="Level ${level}: 0 tests"><span class="level-num">${level}</span></span>`;
        }
        const displayCount = count >= 100 ? '99+' : count;
        return `
            <span class="level-star-slot" title="Level ${level}: ${count} tests">
                <span class="level-star level-${level}"><i class="fas fa-star"></i></span>
                <span class="level-star-count">${displayCount}</span>
            </span>
        `;
    }).join('');
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

// ============================================================================
// EXPORT
// ============================================================================

function exportAllToCSV() {
    // Combine both boards' data
    const headers = [
        'Rank (Perf)', 'Model', 'Composite', 'Quality', 'Latency (ms)', 'Tok/s', 'Tests',
        'Rank (Qual)', 'Generalist', 'Coverage %', 'Consistency %', 'Top Category'
    ];

    const profile = document.getElementById('perfProfile')?.value || 'balanced';
    const perfSorted = [...performanceData]
        .map(m => ({ ...m, calculated_composite: calculateCompositeScore(m, profile) }))
        .sort((a, b) => b.calculated_composite - a.calculated_composite);

    const qualSorted = [...qualityData].sort((a, b) => b.generalistScore - a.generalistScore);

    const toKey = (name, host) => `${name || ''}@@${host || ''}`;
    const perfKey = (m) => toKey(m?.model, m?.host);
    const qualKey = (m) => toKey(m?.name, m?.host);

    const perfRankByKey = new Map(perfSorted.map((m, idx) => [perfKey(m), idx + 1]));
    const qualRankByKey = new Map(qualSorted.map((m, idx) => [qualKey(m), idx + 1]));
    const perfByKey = new Map(perfSorted.map(m => [perfKey(m), m]));
    const qualByKey = new Map(qualSorted.map(m => [qualKey(m), m]));

    // Stable output order: performance board order, then quality-only entries.
    const orderedKeys = [];
    const seen = new Set();
    perfSorted.forEach(m => {
        const key = perfKey(m);
        if (!seen.has(key)) {
            seen.add(key);
            orderedKeys.push(key);
        }
    });
    qualSorted.forEach(m => {
        const key = qualKey(m);
        if (!seen.has(key)) {
            seen.add(key);
            orderedKeys.push(key);
        }
    });

    const rows = orderedKeys.map((key) => {
        const perf = perfByKey.get(key);
        const qual = qualByKey.get(key);
        const modelName = perf?.model || qual?.name || '';
        const host = perf?.host || qual?.host || '';
        const hostLabel = host ? ` (${extractHostName(host)})` : '';

        return [
            perf ? perfRankByKey.get(key) : '',
            `${modelName}${hostLabel}`,
            perf ? perf.calculated_composite.toFixed(1) : '',
            perf ? parseFloat(perf.avg_quality || 0).toFixed(1) : '',
            perf ? perf.avg_latency || '' : '',
            perf ? parseFloat(perf.avg_tokens_per_sec || 0).toFixed(1) : '',
            perf ? perf.tests || '' : '',
            qual ? qualRankByKey.get(key) : '',
            qual ? qual.generalistScore.toFixed(1) : '',
            qual ? qual.coverage : '',
            qual ? qual.consistencyScore : '',
            qual ? qual.topCategory : ''
        ];
    });

    const csv = [headers, ...rows]
        .map(row => row.map(cell => `"${cell}"`).join(','))
        .join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leaderboard-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}
