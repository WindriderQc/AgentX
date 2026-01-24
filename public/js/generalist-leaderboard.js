// Generalist Leaderboard - ALL-CATEGORY Champion Rankings

// SECURITY: Escape HTML to prevent XSS
function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Category weights for "Generalist Champion" scoring (from plan lines 88-107)
const GENERALIST_CATEGORY_WEIGHTS = {
    // Core capabilities (60% total weight)
    'coding': 0.15,                    // 15% - Essential for developers
    'reasoning': 0.15,                 // 15% - Core cognitive ability
    'factual': 0.10,                   // 10% - Knowledge accuracy
    'creative': 0.10,                  // 10% - Content generation
    'instruction-following': 0.10,     // 10% - User intent adherence

    // Specialized capabilities (30% total weight)
    'math': 0.08,                      // 8% - Quantitative reasoning
    'summarization': 0.07,             // 7% - Information distillation
    'multi-turn-reasoning': 0.07,      // 7% - Context retention
    'context-retention': 0.05,         // 5% - Long-form understanding
    'translation': 0.03,               // 3% - Multilingual (bonus)

    // Quality assurance (10% total weight)
    'edge-cases': 0.05,                // 5% - Robustness
    'general': 0.05                    // 5% - General capability
};

let allModelData = [];

function normalizeQualityTo100(rawQuality) {
    const value = Number(rawQuality);
    if (!Number.isFinite(value)) return 0;
    // `quality_score` is generally 0–10; the Generalist leaderboard uses a 0–100 scale.
    // If it already looks like 0–100, keep it as-is.
    return value <= 10 ? value * 10 : value;
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    await loadAndCalculateRankings();
    setupEventListeners();
    displayCategoryWeights();
});

// Load benchmark data and calculate generalist rankings
async function loadAndCalculateRankings() {
    try {
        // Fetch ALL results (up to 10000) - default limit is only 20!
        const response = await fetch('/api/benchmark/results?limit=10000');
        if (!response.ok) throw new Error('Failed to fetch benchmark results');

        const data = await response.json();
        const results = data.data.results;

        // Aggregate results by model
        const modelMap = {};

        results.forEach(result => {
            const modelName = result.model;
            if (!modelMap[modelName]) {
                modelMap[modelName] = {
                    name: modelName,
                    categoryScores: {},
                    totalTests: 0
                };
            }

            modelMap[modelName].totalTests++;

            // Aggregate category scores
            const category = result.prompt_category;
            if (!modelMap[modelName].categoryScores[category]) {
                modelMap[modelName].categoryScores[category] = {
                    total: 0,
                    count: 0,
                    scores: []
                };
            }

            const qualityScore = result.quality_score || 0;
            modelMap[modelName].categoryScores[category].total += qualityScore;
            modelMap[modelName].categoryScores[category].count++;
            modelMap[modelName].categoryScores[category].scores.push(qualityScore);
        });

        // Calculate generalist scores for each model
        allModelData = Object.values(modelMap).map(model => {
            return calculateGeneralistScore(model);
        });

        // Sort by generalist score (default)
        allModelData.sort((a, b) => b.generalistScore - a.generalistScore);

        renderLeaderboard();

    } catch (error) {
        console.error('Error loading rankings:', error);
        document.getElementById('leaderboardTable').innerHTML = `
            <div class="error-state">
                <i class="fas fa-exclamation-triangle"></i>
                <p>Error loading rankings: ${escapeHtml(error.message)}</p>
                <button onclick="loadAndCalculateRankings()" class="btn-primary">Retry</button>
            </div>
        `;
    }
}

// Calculate Generalist Score (from plan lines 110-139)
function calculateGeneralistScore(model) {
    let weightedSum = 0;
    let coveragePenalty = 0;
    let consistencyBonus = 0;

    // Calculate average scores per category
    const categoryAverages = {};
    const scores = [];
    let testedCategories = 0;

    // Max penalty if a model has 0 coverage weight. Keeps penalty comparable to 0–100 scores.
    const COVERAGE_PENALTY_MAX = 20;

    for (const [category, weight] of Object.entries(GENERALIST_CATEGORY_WEIGHTS)) {
        const categoryData = model.categoryScores[category];

        if (categoryData && categoryData.count > 0) {
            testedCategories++;
            const avgScore = normalizeQualityTo100(categoryData.total / categoryData.count);
            categoryAverages[category] = avgScore;
            scores.push(avgScore);
            weightedSum += avgScore * weight;
        } else {
            categoryAverages[category] = 0;
            // Penalize missing coverage proportionally (scaled by category weights)
            coveragePenalty += weight * COVERAGE_PENALTY_MAX;
        }
    }

    // Calculate coverage percentage
    const totalCategories = Object.keys(GENERALIST_CATEGORY_WEIGHTS).length;
    const coveragePercent = (testedCategories / totalCategories) * 100;

    // Consistency bonus: Models with low variance across categories
    if (scores.length > 3) {
        const stdDev = calculateStdDev(scores);
        if (stdDev < 10) {
            consistencyBonus = 5; // +5 for consistent performance
        }
        const consistencyScore = Math.max(0, 100 - stdDev);

        // Return comprehensive model data
        return {
            name: model.name,
            generalistScore: Math.round(Math.max(0, weightedSum - coveragePenalty + consistencyBonus) * 10) / 10,
            weightedSum: Math.round(weightedSum * 10) / 10,
            coveragePenalty: Math.round(coveragePenalty * 10) / 10,
            consistencyBonus,
            coverage: Math.round(coveragePercent),
            consistencyScore: Math.round(consistencyScore),
            categoryAverages,
            topCategory: getTopCategory(categoryAverages),
            avgScore: scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : 0,
            totalTests: model.totalTests,
            stdDev: Math.round(stdDev * 10) / 10
        };
    } else {
        // Not enough data for consistency calculation
        return {
            name: model.name,
            generalistScore: Math.round(Math.max(0, weightedSum - coveragePenalty) * 10) / 10,
            weightedSum: Math.round(weightedSum * 10) / 10,
            coveragePenalty: Math.round(coveragePenalty * 10) / 10,
            consistencyBonus: 0,
            coverage: Math.round(coveragePercent),
            consistencyScore: 0,
            categoryAverages,
            topCategory: getTopCategory(categoryAverages),
            avgScore: scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : 0,
            totalTests: model.totalTests,
            stdDev: 0
        };
    }
}

// Calculate standard deviation
function calculateStdDev(arr) {
    if (arr.length === 0) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const squaredDiffs = arr.map(x => Math.pow(x - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(variance);
}

// Get top category
function getTopCategory(categoryAverages) {
    const entries = Object.entries(categoryAverages).filter(([_, score]) => score > 0);
    if (entries.length === 0) return '-';

    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
}

// Render leaderboard table
function renderLeaderboard() {
    const table = document.getElementById('leaderboardTable');

    if (allModelData.length === 0) {
        table.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-inbox"></i>
                <p>No benchmark data found</p>
                <a href="/benchmark.html" class="btn-primary">Run Benchmarks</a>
            </div>
        `;
        return;
    }

    // Apply filters
    const filteredData = applyFilters();

    if (filteredData.length === 0) {
        table.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-filter"></i>
                <p>No models match your filters</p>
                <button onclick="resetFilters()" class="btn-primary">Reset Filters</button>
            </div>
        `;
        return;
    }

    // Build table
    table.innerHTML = `
        <table class="leaderboard-table">
            <thead>
                <tr>
                    <th>Rank</th>
                    <th>Model</th>
                    <th>Generalist Score</th>
                    <th>Coverage</th>
                    <th>Consistency</th>
                    <th>Top Category</th>
                    <th>Avg Score</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${filteredData.map((model, index) => `
                    <tr class="leaderboard-row ${index === 0 ? 'rank-1' : index === 1 ? 'rank-2' : index === 2 ? 'rank-3' : ''}">
                        <td class="rank-cell">
                            ${index < 3 ? getRankMedal(index) : `<span class="rank-number">${index + 1}</span>`}
                        </td>
                        <td class="model-cell">
                            <strong>${escapeHtml(model.name)}</strong>
                            ${model.consistencyBonus > 0 ? '<span class="badge-consistent">⭐ Consistent</span>' : ''}
                        </td>
                        <td class="score-cell">
                            <div class="score-value">${model.generalistScore}</div>
                            <div class="score-breakdown">
                                ${model.weightedSum}
                                ${model.coveragePenalty > 0 ? `<span class="penalty">-${model.coveragePenalty}</span>` : ''}
                                ${model.consistencyBonus > 0 ? `<span class="bonus">+${model.consistencyBonus}</span>` : ''}
                            </div>
                        </td>
                        <td class="coverage-cell">
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: ${model.coverage}%; background: ${getCoverageColor(model.coverage)};"></div>
                            </div>
                            <span class="coverage-text">${model.coverage}%</span>
                        </td>
                        <td class="consistency-cell">
                            <div class="consistency-indicator ${model.consistencyScore >= 90 ? 'high' : model.consistencyScore >= 70 ? 'medium' : 'low'}">
                                ${model.consistencyScore}%
                            </div>
                            <span class="stddev-text">σ=${model.stdDev}</span>
                        </td>
                        <td class="category-cell">${formatCategoryName(model.topCategory)}</td>
                        <td class="avg-cell">${model.avgScore}</td>
                        <td class="actions-cell">
                            <button class="btn-view-details" onclick="viewModelDetails('${escapeHtml(model.name).replace(/'/g, "\\'")}')">
                                <i class="fas fa-chart-bar"></i> Details
                            </button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

// Get rank medal
function getRankMedal(rank) {
    const medals = ['🥇', '🥈', '🥉'];
    return `<span class="rank-medal">${medals[rank]}</span>`;
}

// Get coverage color
function getCoverageColor(coverage) {
    if (coverage >= 90) return '#22c55e'; // Green
    if (coverage >= 75) return '#3b82f6'; // Blue
    if (coverage >= 50) return '#eab308'; // Yellow
    return '#ef4444'; // Red
}

// Apply filters
function applyFilters() {
    const minCoverage = parseInt(document.getElementById('coverageFilter').value) || 0;
    const sortBy = document.getElementById('sortFilter').value;
    const minScore = parseInt(document.getElementById('minScoreFilter').value) || 0;

    let filtered = [...allModelData];

    // Filter by coverage
    filtered = filtered.filter(m => m.coverage >= minCoverage);

    // Filter by min score
    filtered = filtered.filter(m => m.generalistScore >= minScore);

    // Sort
    switch (sortBy) {
        case 'generalist':
            filtered.sort((a, b) => b.generalistScore - a.generalistScore);
            break;
        case 'coverage':
            filtered.sort((a, b) => b.coverage - a.coverage);
            break;
        case 'consistency':
            filtered.sort((a, b) => b.consistencyScore - a.consistencyScore);
            break;
        case 'overall':
            filtered.sort((a, b) => b.avgScore - a.avgScore);
            break;
    }

    return filtered;
}

// Reset filters
function resetFilters() {
    document.getElementById('coverageFilter').value = '0';
    document.getElementById('sortFilter').value = 'generalist';
    document.getElementById('minScoreFilter').value = '0';
    renderLeaderboard();
}

// View model details
function viewModelDetails(modelName) {
    const model = allModelData.find(m => m.name === modelName);
    if (!model) return;

    const modal = document.getElementById('detailModal');
    document.getElementById('modalModelName').textContent = escapeHtml(model.name);

    const content = document.getElementById('modalContent');
    content.innerHTML = `
        <div class="detail-stats">
            <div class="detail-stat">
                <div class="detail-label">Generalist Score</div>
                <div class="detail-value">${model.generalistScore}</div>
            </div>
            <div class="detail-stat">
                <div class="detail-label">Coverage</div>
                <div class="detail-value">${model.coverage}%</div>
            </div>
            <div class="detail-stat">
                <div class="detail-label">Consistency</div>
                <div class="detail-value">${model.consistencyScore}%</div>
            </div>
            <div class="detail-stat">
                <div class="detail-label">Total Tests</div>
                <div class="detail-value">${model.totalTests}</div>
            </div>
        </div>

        <div class="detail-breakdown">
            <h3>Category Breakdown</h3>
            <div class="category-breakdown-grid">
                ${Object.entries(model.categoryAverages)
                    .sort((a, b) => b[1] - a[1])
                    .map(([category, score]) => {
                        const weight = GENERALIST_CATEGORY_WEIGHTS[category] || 0;
                        const contribution = score * weight;
                        return `
                            <div class="category-breakdown-item">
                                <div class="category-name">${formatCategoryName(category)}</div>
                                <div class="category-bar-container">
                                    <div class="category-bar" style="width: ${score}%; background: ${getCategoryColor(score)};"></div>
                                </div>
                                <div class="category-stats">
                                    <span class="category-score">${score.toFixed(1)}</span>
                                    <span class="category-weight">×${(weight * 100).toFixed(0)}% = ${contribution.toFixed(1)}</span>
                                </div>
                            </div>
                        `;
                    }).join('')}
            </div>
        </div>

        <div class="detail-formula">
            <h3>Score Calculation</h3>
            <div class="formula-breakdown">
                <div class="formula-line">
                    <span>Weighted Sum:</span>
                    <span class="formula-value">+${model.weightedSum}</span>
                </div>
                ${model.coveragePenalty > 0 ? `
                    <div class="formula-line penalty">
                        <span>Coverage Penalty:</span>
                        <span class="formula-value">-${model.coveragePenalty}</span>
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
                    <span class="formula-value"><strong>${model.generalistScore}</strong></span>
                </div>
            </div>
        </div>
    `;

    modal.style.display = 'block';
}

// Close detail modal
function closeDetailModal() {
    document.getElementById('detailModal').style.display = 'none';
}

// Close methodology modal
function closeMethodologyModal() {
    document.getElementById('methodologyModal').style.display = 'none';
}

// Get category color
function getCategoryColor(score) {
    if (score >= 80) return '#22c55e';
    if (score >= 60) return '#3b82f6';
    if (score >= 40) return '#eab308';
    return '#ef4444';
}

// Display category weights
function displayCategoryWeights() {
    const grid = document.getElementById('weightsGrid');

    const sortedWeights = Object.entries(GENERALIST_CATEGORY_WEIGHTS)
        .sort((a, b) => b[1] - a[1]);

    grid.innerHTML = sortedWeights.map(([category, weight]) => `
        <div class="weight-item">
            <span class="weight-category">${formatCategoryName(category)}</span>
            <span class="weight-bar-container">
                <span class="weight-bar" style="width: ${weight * 100}%;"></span>
            </span>
            <span class="weight-value">${(weight * 100).toFixed(0)}%</span>
        </div>
    `).join('');
}

// Setup event listeners
function setupEventListeners() {
    document.getElementById('coverageFilter').addEventListener('change', renderLeaderboard);
    document.getElementById('sortFilter').addEventListener('change', renderLeaderboard);
    document.getElementById('minScoreFilter').addEventListener('input', renderLeaderboard);

    document.getElementById('methodologyBtn').addEventListener('click', () => {
        document.getElementById('methodologyModal').style.display = 'block';
    });

    document.getElementById('exportBtn').addEventListener('click', exportToCSV);
}

// Export to CSV
function exportToCSV() {
    const headers = [
        'Rank', 'Model', 'Generalist Score', 'Coverage %', 'Consistency %',
        'Top Category', 'Avg Score', 'Std Dev', 'Total Tests',
        ...Object.keys(GENERALIST_CATEGORY_WEIGHTS)
    ];

    const filteredData = applyFilters();

    const rows = filteredData.map((model, index) => [
        index + 1,
        model.name,
        model.generalistScore,
        model.coverage,
        model.consistencyScore,
        model.topCategory,
        model.avgScore,
        model.stdDev,
        model.totalTests,
        ...Object.keys(GENERALIST_CATEGORY_WEIGHTS).map(cat => model.categoryAverages[cat] || 0)
    ]);

    const csv = [headers, ...rows]
        .map(row => row.map(cell => `"${cell}"`).join(','))
        .join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `generalist-leaderboard-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// Utility functions
function formatCategoryName(cat) {
    return cat.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Close modals when clicking outside
window.onclick = function(event) {
    const detailModal = document.getElementById('detailModal');
    const methodologyModal = document.getElementById('methodologyModal');

    if (event.target === detailModal) {
        closeDetailModal();
    }
    if (event.target === methodologyModal) {
        closeMethodologyModal();
    }
}
