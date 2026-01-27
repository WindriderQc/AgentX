// Generalist Leaderboard - ALL-CATEGORY Champion Rankings
// Uses backend API as single source of truth

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

let allModelData = [];
let categoryWeights = {};

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    await loadLeaderboard();
    setupEventListeners();
});

// Load leaderboard data from backend API (single source of truth)
async function loadLeaderboard() {
    try {
        const response = await fetch('/api/benchmark/generalist-leaderboard');
        if (!response.ok) throw new Error('Failed to fetch generalist leaderboard');

        const result = await response.json();
        if (result.status !== 'success') throw new Error(result.error || 'API error');

        const { leaderboard, categoryWeights: weights } = result.data;
        categoryWeights = weights;

        // Transform API data for UI
        allModelData = leaderboard.map(model => {
            const scores = Object.values(model.categoryAverages).filter(s => s > 0);
            const avgScore = scores.length > 0
                ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
                : 0;

            return {
                name: model.model,
                host: model.host,
                generalistScore: model.generalistScore,
                weightedSum: model.weightedSum,
                coveragePenalty: model.coveragePenalty,
                consistencyBonus: model.consistencyBonus,
                avgWithinCategoryStdDev: model.avgWithinCategoryStdDev,
                coverage: model.coverage,
                testedCategories: model.testedCategories,
                categoryAverages: model.categoryAverages,
                topCategory: getTopCategory(model.categoryAverages),
                avgScore
            };
        });

        displayCategoryWeights();
        renderLeaderboard();

    } catch (error) {
        console.error('Error loading leaderboard:', error);
        document.getElementById('leaderboardTable').innerHTML = `
            <div class="error-state">
                <i class="fas fa-exclamation-triangle"></i>
                <p>Error loading rankings: ${escapeHtml(error.message)}</p>
                <button onclick="loadLeaderboard()" class="btn-primary">Retry</button>
            </div>
        `;
    }
}

// Get top category from averages
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
                            ${model.consistencyBonus > 0 ? '<span class="badge-consistent">⭐ Reliable</span>' : ''}
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
                            <div class="consistency-indicator ${model.avgWithinCategoryStdDev <= 15 ? 'high' : model.avgWithinCategoryStdDev <= 25 ? 'medium' : 'low'}">
                                ${model.consistencyBonus > 0 ? 'High' : 'Normal'}
                            </div>
                            <span class="stddev-text">σ=${model.avgWithinCategoryStdDev}</span>
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
    if (coverage >= 90) return '#22c55e';
    if (coverage >= 75) return '#3b82f6';
    if (coverage >= 50) return '#eab308';
    return '#ef4444';
}

// Apply filters
function applyFilters() {
    const minCoverage = parseInt(document.getElementById('coverageFilter').value) || 0;
    const sortBy = document.getElementById('sortFilter').value;
    const minScore = parseInt(document.getElementById('minScoreFilter').value) || 0;

    let filtered = [...allModelData];

    filtered = filtered.filter(m => m.coverage >= minCoverage);
    filtered = filtered.filter(m => m.generalistScore >= minScore);

    switch (sortBy) {
        case 'generalist':
            filtered.sort((a, b) => b.generalistScore - a.generalistScore);
            break;
        case 'coverage':
            filtered.sort((a, b) => b.coverage - a.coverage);
            break;
        case 'consistency':
            // Lower stddev = more consistent = better
            filtered.sort((a, b) => a.avgWithinCategoryStdDev - b.avgWithinCategoryStdDev);
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
                <div class="detail-label">Avg Within-Category σ</div>
                <div class="detail-value">${model.avgWithinCategoryStdDev}</div>
            </div>
            <div class="detail-stat">
                <div class="detail-label">Categories Tested</div>
                <div class="detail-value">${model.testedCategories}</div>
            </div>
        </div>

        <div class="detail-breakdown">
            <h3>Category Breakdown</h3>
            <div class="category-breakdown-grid">
                ${Object.entries(model.categoryAverages)
                    .sort((a, b) => b[1] - a[1])
                    .map(([category, score]) => {
                        const weight = categoryWeights[category] || 0;
                        const contribution = (score / 100) * weight * 100; // score is 0-100, weight is 0-1
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
                    <span>Weighted Quality:</span>
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
                        <span>Reliability Bonus (low σ):</span>
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
    if (!grid) return;

    const sortedWeights = Object.entries(categoryWeights)
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
        'Rank', 'Model', 'Generalist Score', 'Coverage %', 'Avg StdDev',
        'Top Category', 'Avg Score', 'Consistency Bonus',
        ...Object.keys(categoryWeights)
    ];

    const filteredData = applyFilters();

    const rows = filteredData.map((model, index) => [
        index + 1,
        model.name,
        model.generalistScore,
        model.coverage,
        model.avgWithinCategoryStdDev,
        model.topCategory,
        model.avgScore,
        model.consistencyBonus,
        ...Object.keys(categoryWeights).map(cat => model.categoryAverages[cat] || 0)
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
    if (!cat || cat === '-') return '-';
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
