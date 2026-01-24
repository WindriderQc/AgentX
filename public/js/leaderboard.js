/**
 * Unified Leaderboard - Performance & Quality Boards
 * Combines composite scoring (speed+quality) with generalist scoring (quality-only)
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

// Generalist category weights (Quality Board)
const CATEGORY_WEIGHTS = {
    'coding': 0.15,
    'reasoning': 0.15,
    'factual': 0.10,
    'creative': 0.10,
    'instruction-following': 0.10,
    'math': 0.08,
    'summarization': 0.07,
    'multi-turn-reasoning': 0.07,
    'context-retention': 0.05,
    'translation': 0.03,
    'edge-cases': 0.05,
    'general': 0.05
};

const COVERAGE_PENALTY_MAX = 20;
const CONSISTENCY_BONUS = 5;

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
        quality: 60,
        speed: 20,
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
let qualityData = [];      // Calculated from /api/benchmark/results
let rawResults = [];       // Raw results for quality calculations
let charts = {};

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    updateProfileWeights();
    await refreshAllData();
    renderCategoryWeights();
});

async function refreshAllData() {
    showLoading();
    try {
        await Promise.all([
            loadPerformanceData(),
            loadQualityData()
        ]);
        updateStats();
        initCharts();  // Create charts first
        renderPerformanceBoard();  // Then render (which updates charts)
        renderQualityBoard();
    } catch (err) {
        console.error('Failed to load data:', err);
        showError(err.message);
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
    // Fetch ALL results for accurate category coverage
    const response = await fetch('/api/benchmark/results?limit=10000');
    if (!response.ok) throw new Error('Failed to load results data');
    const data = await response.json();
    rawResults = data.data?.results || [];

    // Calculate generalist scores
    qualityData = calculateGeneralistScores(rawResults);
}

// ============================================================================
// GENERALIST SCORE CALCULATION (Quality Board)
// ============================================================================

function calculateGeneralistScores(results) {
    // Group by model+host combination
    const modelMap = {};

    results.forEach(result => {
        const model = result.model;
        const host = result.host || '';
        const key = `${model}||${host}`;  // Composite key

        if (!modelMap[key]) {
            modelMap[key] = {
                name: model,
                host: host,
                categoryScores: {},
                totalTests: 0,
                testsByLevel: {}
            };
        }

        modelMap[key].totalTests++;

        // Track tests by level
        const level = result.prompt_level || result.level || 1;
        modelMap[key].testsByLevel[level] = (modelMap[key].testsByLevel[level] || 0) + 1;

        const category = result.prompt_category;
        if (category) {
            if (!modelMap[key].categoryScores[category]) {
                modelMap[key].categoryScores[category] = { total: 0, count: 0, scores: [] };
            }
            const score = result.quality_score || 0;
            modelMap[key].categoryScores[category].total += score;
            modelMap[key].categoryScores[category].count++;
            modelMap[key].categoryScores[category].scores.push(score);
        }
    });

    // Calculate generalist score for each model
    return Object.values(modelMap).map(model => {
        let weightedSum = 0;
        let coveragePenalty = 0;
        const categoryAverages = {};
        const scores = [];
        let testedCategories = 0;

        for (const [category, weight] of Object.entries(CATEGORY_WEIGHTS)) {
            const catData = model.categoryScores[category];

            if (catData && catData.count > 0) {
                testedCategories++;
                const avgScore = normalizeScore(catData.total / catData.count);
                categoryAverages[category] = avgScore;
                scores.push(avgScore);
                weightedSum += avgScore * weight;
            } else {
                categoryAverages[category] = 0;
                coveragePenalty += weight * COVERAGE_PENALTY_MAX;
            }
        }

        const totalCategories = Object.keys(CATEGORY_WEIGHTS).length;
        const coveragePercent = (testedCategories / totalCategories) * 100;

        let consistencyBonus = 0;
        let stdDev = 0;
        let consistencyScore = 0;

        if (scores.length > 3) {
            stdDev = calculateStdDev(scores);
            consistencyScore = Math.max(0, 100 - stdDev);
            if (stdDev < 10) {
                consistencyBonus = CONSISTENCY_BONUS;
            }
        }

        const generalistScore = Math.max(0, weightedSum - coveragePenalty + consistencyBonus);

        return {
            name: model.name,
            host: model.host,
            generalistScore: round(generalistScore),
            weightedSum: round(weightedSum),
            coveragePenalty: round(coveragePenalty),
            consistencyBonus,
            coverage: Math.round(coveragePercent),
            consistencyScore: Math.round(consistencyScore),
            categoryAverages,
            topCategory: getTopCategory(categoryAverages),
            avgScore: scores.length > 0 ? round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
            totalTests: model.totalTests,
            testsByLevel: model.testsByLevel,
            stdDev: round(stdDev)
        };
    });
}

function normalizeScore(rawScore) {
    const value = Number(rawScore);
    if (!Number.isFinite(value)) return 0;
    // quality_score is 0-10, normalize to 0-100 for display
    return value <= 10 ? value * 10 : value;
}

function calculateStdDev(arr) {
    if (arr.length === 0) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const squaredDiffs = arr.map(x => Math.pow(x - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(variance);
}

function getTopCategory(categoryAverages) {
    const entries = Object.entries(categoryAverages).filter(([_, score]) => score > 0);
    if (entries.length === 0) return '-';
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
}

function round(num) {
    return Math.round(num * 10) / 10;
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
    const sortBy = document.getElementById('perfSortBy').value;
    const profile = document.getElementById('perfProfile')?.value || 'balanced';

    // Calculate composite scores based on selected profile
    let data = performanceData.map(model => ({
        ...model,
        calculated_composite: calculateCompositeScore(model, profile)
    }));

    // Sort
    data.sort((a, b) => {
        switch (sortBy) {
            case 'composite':
                return b.calculated_composite - a.calculated_composite;
            case 'quality':
                return parseFloat(b.avg_quality || 0) - parseFloat(a.avg_quality || 0);
            case 'latency':
                return (a.avg_latency || 99999) - (b.avg_latency || 99999);
            case 'tokens':
                return parseFloat(b.avg_tokens_per_sec || 0) - parseFloat(a.avg_tokens_per_sec || 0);
            default:
                return 0;
        }
    });

    const tbody = document.getElementById('perfTableBody');

    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No data available. <a href="/benchmark.html">Run benchmarks</a></td></tr>';
        return;
    }

    tbody.innerHTML = data.map((model, idx) => {
        const composite = model.calculated_composite;
        const quality = parseFloat(model.avg_quality) || 0;
        const latency = model.avg_latency || 0;
        const tokensPerSec = parseFloat(model.avg_tokens_per_sec) || 0;
        const tests = model.tests || 1;
        const failed = model.failed_tests || 0;
        const reliabilityPct = Math.round(((tests - failed) / tests) * 100);

        const hostName = model.host ? extractHostName(model.host) : '';

        return `
            <tr class="${idx < 3 ? 'top-rank rank-' + (idx + 1) : ''}" onclick="showModelDetail('${escapeHtml(model.model)}', 'performance')">
                <td class="rank-col">${getRankDisplay(idx)}</td>
                <td class="model-col">
                    <span class="model-name">${escapeHtml(model.model)}</span>
                    ${hostName ? `<span class="model-host">${escapeHtml(hostName)}</span>` : ''}
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
    const sortBy = document.getElementById('qualSortBy').value;
    const minCoverage = parseInt(document.getElementById('qualMinCoverage').value) || 0;

    let data = [...qualityData];

    // Filter by coverage
    data = data.filter(m => m.coverage >= minCoverage);

    // Sort
    data.sort((a, b) => {
        switch (sortBy) {
            case 'generalist':
                return b.generalistScore - a.generalistScore;
            case 'coverage':
                return b.coverage - a.coverage;
            case 'consistency':
                return b.consistencyScore - a.consistencyScore;
            case 'avgScore':
                return b.avgScore - a.avgScore;
            default:
                return 0;
        }
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
                    <button class="btn-details" onclick="showModelDetail('${escapedName}', 'quality')">
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
    // Performance Composite Chart
    const compositeCtx = document.getElementById('perfCompositeChart');
    if (compositeCtx) {
        if (charts.composite) charts.composite.destroy();
        charts.composite = new Chart(compositeCtx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [{
                    label: 'Composite Score',
                    data: [],
                    backgroundColor: 'rgba(241, 196, 15, 0.7)',
                    borderColor: 'rgba(241, 196, 15, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    title: { display: true, text: 'Composite Score (Higher = Better)' }
                },
                scales: {
                    y: { beginAtZero: false, grace: '15%' }
                }
            }
        });
    }

    // Performance Quality Chart
    const qualityCtx = document.getElementById('perfQualityChart');
    if (qualityCtx) {
        if (charts.quality) charts.quality.destroy();
        charts.quality = new Chart(qualityCtx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [{
                    label: 'Quality Score',
                    data: [],
                    backgroundColor: 'rgba(46, 204, 113, 0.7)',
                    borderColor: 'rgba(46, 204, 113, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    title: { display: true, text: 'Quality Score (Higher = Better)' }
                },
                scales: {
                    y: { beginAtZero: false, grace: '15%' }
                }
            }
        });
    }

    // Don't call updatePerformanceCharts here - renderPerformanceBoard() will call it with calculated data
}

function updatePerformanceCharts(data) {
    if (!charts.composite || !charts.quality) return;

    const labels = data.slice(0, 10).map(m => truncateLabel(m.model));
    const compositeScores = data.slice(0, 10).map(m => m.calculated_composite || 0);
    const qualityScores = data.slice(0, 10).map(m => parseFloat(m.avg_quality) || 0);

    charts.composite.data.labels = labels;
    charts.composite.data.datasets[0].data = compositeScores;
    charts.composite.update();

    charts.quality.data.labels = labels;
    charts.quality.data.datasets[0].data = qualityScores;
    charts.quality.update();
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

function showModelDetail(modelName, board) {
    const modal = document.getElementById('modelDetailModal');
    const modalName = document.getElementById('modalModelName');
    const modalBody = document.getElementById('modalBody');

    modalName.textContent = modelName;

    if (board === 'performance') {
        const model = performanceData.find(m => m.model === modelName);
        if (!model) return;

        modalBody.innerHTML = `
            <div class="detail-grid">
                <div class="detail-item">
                    <span class="detail-label">Composite Score</span>
                    <span class="detail-value">${parseFloat(model.avg_composite || 0).toFixed(1)}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Quality Score</span>
                    <span class="detail-value">${parseFloat(model.avg_quality || 0).toFixed(1)}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Avg Latency</span>
                    <span class="detail-value">${(model.avg_latency || 0).toLocaleString()}ms</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Tokens/sec</span>
                    <span class="detail-value">${parseFloat(model.avg_tokens_per_sec || 0).toFixed(1)}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Total Tests</span>
                    <span class="detail-value">${model.tests || 0}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Failed Tests</span>
                    <span class="detail-value">${model.failed_tests || 0}</span>
                </div>
            </div>
            <h4>Profile Scores</h4>
            <div class="detail-grid">
                <div class="detail-item">
                    <span class="detail-label">Interactive</span>
                    <span class="detail-value">${parseFloat(model.interactive_score || 0).toFixed(1)}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Reasoning</span>
                    <span class="detail-value">${parseFloat(model.reasoning_score || 0).toFixed(1)}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Coding</span>
                    <span class="detail-value">${parseFloat(model.coding_score || 0).toFixed(1)}</span>
                </div>
            </div>
        `;
    } else {
        const model = qualityData.find(m => m.name === modelName);
        if (!model) return;

        const categoryRows = Object.entries(model.categoryAverages)
            .filter(([_, score]) => score > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, score]) => {
                const weight = CATEGORY_WEIGHTS[cat] || 0;
                const contribution = score * weight;
                return `
                    <div class="category-row">
                        <span class="cat-name">${formatCategory(cat)}</span>
                        <div class="cat-bar-container">
                            <div class="cat-bar" style="width: ${score}%; background: ${getScoreColor(score / 10)};"></div>
                        </div>
                        <span class="cat-score">${score.toFixed(1)}</span>
                        <span class="cat-weight">${(weight * 100).toFixed(0)}%</span>
                        <span class="cat-contrib">${contribution.toFixed(1)}</span>
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
                    <span class="detail-label">Generalist Score</span>
                    <span class="detail-value highlight">${model.generalistScore.toFixed(1)}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Coverage</span>
                    <span class="detail-value">${model.coverage}%</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Consistency</span>
                    <span class="detail-value">${model.consistencyScore}%</span>
                    <span class="detail-sub">σ = ${model.stdDev}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">Total Tests</span>
                    <span class="detail-value">${model.totalTests}</span>
                </div>
            </div>

            <h4>Tests by Difficulty Level</h4>
            <div class="level-distribution">
                ${levelBars || '<span class="no-data">No level data</span>'}
            </div>

            <div class="info-box">
                <div class="info-row">
                    <span class="info-label">Unweighted Avg (${testedCats} categories):</span>
                    <span class="info-value">${model.avgScore.toFixed(1)}</span>
                </div>
                <span class="info-note">Simple mean across tested categories, ignoring weights</span>
            </div>

            <div class="info-box consistency-info">
                <div class="info-row">
                    <span class="info-label">Standard Deviation (σ):</span>
                    <span class="info-value">${model.stdDev}</span>
                </div>
                <span class="info-note">
                    Measures score variance across categories.
                    <strong>σ &lt; 10</strong> = Consistent performer (+5 bonus).
                    Lower σ = more reliable across different task types.
                </span>
            </div>

            <h4>Score Breakdown</h4>
            <div class="formula-breakdown">
                <div class="formula-line">
                    <span>Weighted Sum:</span>
                    <span class="formula-value">+${model.weightedSum.toFixed(1)}</span>
                </div>
                ${model.coveragePenalty > 0 ? `
                    <div class="formula-line penalty">
                        <span>Coverage Penalty:</span>
                        <span class="formula-value">-${model.coveragePenalty.toFixed(1)}</span>
                    </div>
                ` : ''}
                ${model.consistencyBonus > 0 ? `
                    <div class="formula-line bonus">
                        <span>Consistency Bonus:</span>
                        <span class="formula-value">+${model.consistencyBonus}</span>
                    </div>
                ` : ''}
                <div class="formula-line total">
                    <span><strong>Final Score:</strong></span>
                    <span class="formula-value"><strong>${model.generalistScore.toFixed(1)}</strong></span>
                </div>
            </div>

            <h4>Category Performance</h4>
            <div class="category-breakdown">
                <div class="category-header">
                    <span>Category</span>
                    <span>Score</span>
                    <span>Weight</span>
                    <span>Contrib</span>
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
    document.getElementById('statTests').textContent = rawResults.length.toLocaleString();

    const categories = new Set(rawResults.map(r => r.prompt_category).filter(Boolean));
    document.getElementById('statCategories').textContent = categories.size;

    document.getElementById('statUpdated').textContent = new Date().toLocaleTimeString();
}

function showLoading() {
    document.getElementById('perfTableBody').innerHTML = '<tr><td colspan="7" class="loading-cell"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>';
    document.getElementById('qualTableBody').innerHTML = '<tr><td colspan="7" class="loading-cell"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>';
}

function showError(message) {
    const errorHtml = `<tr><td colspan="7" class="error-cell"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(message)}</td></tr>`;
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
    if (hostUrl.includes('localhost') || hostUrl.includes('127.0.0.1')) return 'Local';
    // Fallback: strip protocol and port
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

// ============================================================================
// EXPORT
// ============================================================================

function exportAllToCSV() {
    // Combine both boards' data
    const headers = [
        'Rank (Perf)', 'Model', 'Composite', 'Quality', 'Latency (ms)', 'Tok/s', 'Tests',
        'Rank (Qual)', 'Generalist', 'Coverage %', 'Consistency %', 'Top Category'
    ];

    const perfSorted = [...performanceData].sort((a, b) =>
        parseFloat(b.avg_composite || 0) - parseFloat(a.avg_composite || 0)
    );

    const qualSorted = [...qualityData].sort((a, b) => b.generalistScore - a.generalistScore);

    const maxRows = Math.max(perfSorted.length, qualSorted.length);
    const rows = [];

    for (let i = 0; i < maxRows; i++) {
        const perf = perfSorted[i];
        const qual = qualSorted[i];

        rows.push([
            perf ? i + 1 : '',
            perf ? perf.model : '',
            perf ? parseFloat(perf.avg_composite || 0).toFixed(1) : '',
            perf ? parseFloat(perf.avg_quality || 0).toFixed(1) : '',
            perf ? perf.avg_latency || '' : '',
            perf ? parseFloat(perf.avg_tokens_per_sec || 0).toFixed(1) : '',
            perf ? perf.tests || '' : '',
            qual ? i + 1 : '',
            qual ? qual.generalistScore.toFixed(1) : '',
            qual ? qual.coverage : '',
            qual ? qual.consistencyScore : '',
            qual ? qual.topCategory : ''
        ]);
    }

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
