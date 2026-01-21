// Model Explorer - Comprehensive model performance analysis

const CATEGORIES = [
    'coding', 'reasoning', 'factual', 'math', 'creative', 'general',
    'instruction-following', 'summarization', 'translation',
    'multi-turn-reasoning', 'context-retention', 'edge-cases'
];

let allModelData = [];
let selectedModelsForComparison = [];
let radarCharts = {};

/**
 * Normalize quality score from 0-10 to 0-100 scale for consistent UI display
 * quality_score is stored as 0-10 in database, but Model Explorer displays as 0-100
 */
function normalizeQualityTo100(rawQuality) {
    const value = Number(rawQuality);
    if (!Number.isFinite(value)) return 0;
    // If value is 0-10, scale to 0-100; if already 0-100, keep as-is
    return value <= 10 ? value * 10 : value;
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    await loadModelData();
    setupEventListeners();
});

// Load and aggregate model data
async function loadModelData() {
    try {
        const response = await fetch('/api/benchmark/results');
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
                    results: [],
                    categoryScores: {},
                    totalTests: 0,
                    totalLatency: 0,
                    totalSpeed: 0
                };
            }

            modelMap[modelName].results.push(result);
            modelMap[modelName].totalTests++;
            modelMap[modelName].totalLatency += result.latency || 0;

            // Calculate tokens per second if available
            if (result.tokens && result.latency) {
                const tokensPerSec = result.tokens / (result.latency / 1000);
                modelMap[modelName].totalSpeed += tokensPerSec;
            }

            // Aggregate category scores
            const category = result.prompt_category;
            if (!modelMap[modelName].categoryScores[category]) {
                modelMap[modelName].categoryScores[category] = {
                    total: 0,
                    count: 0,
                    scores: []
                };
            }

            const qualityScore = normalizeQualityTo100(result.quality_score || 0);
            modelMap[modelName].categoryScores[category].total += qualityScore;
            modelMap[modelName].categoryScores[category].count++;
            modelMap[modelName].categoryScores[category].scores.push(qualityScore);
        });

        // Calculate averages and tag models
        allModelData = Object.values(modelMap).map(model => {
            const avgLatency = model.totalLatency / model.totalTests;
            const avgSpeed = model.totalSpeed / model.totalTests;

            // Calculate category averages
            const categoryAverages = {};
            let totalCategoryScore = 0;
            let categoriesWithData = 0;

            CATEGORIES.forEach(cat => {
                if (model.categoryScores[cat] && model.categoryScores[cat].count > 0) {
                    const avg = model.categoryScores[cat].total / model.categoryScores[cat].count;
                    categoryAverages[cat] = Math.round(avg * 10) / 10;
                    totalCategoryScore += avg;
                    categoriesWithData++;
                } else {
                    categoryAverages[cat] = 0;
                }
            });

            const overallScore = categoriesWithData > 0
                ? Math.round((totalCategoryScore / categoriesWithData) * 10) / 10
                : 0;

            // Auto-tag models
            const tags = autoTagModel(model.name, categoryAverages, avgLatency, avgSpeed, overallScore);

            // Find strengths and weaknesses
            const categoryScoresArray = Object.entries(categoryAverages)
                .filter(([_, score]) => score > 0)
                .map(([cat, score]) => ({ category: cat, score }))
                .sort((a, b) => b.score - a.score);

            const strengths = categoryScoresArray.slice(0, 3);
            const weaknesses = categoryScoresArray.slice(-3).reverse();

            return {
                name: model.name,
                overallScore,
                categoryScores: categoryAverages,
                avgLatency: Math.round(avgLatency),
                avgSpeed: Math.round(avgSpeed * 10) / 10,
                totalTests: model.totalTests,
                tags,
                strengths,
                weaknesses,
                categoriesWithData
            };
        });

        // Sort by overall score by default
        allModelData.sort((a, b) => b.overallScore - a.overallScore);

        updateStatsSummary();
        renderModelGrid();

    } catch (error) {
        console.error('Error loading model data:', error);
        document.getElementById('modelGrid').innerHTML = `
            <div class="error-state">
                <i class="fas fa-exclamation-triangle"></i>
                <p>Error loading model data: ${error.message}</p>
                <button onclick="loadModelData()" class="btn-primary">Retry</button>
            </div>
        `;
    }
}

// Auto-tag models based on performance
function autoTagModel(modelName, categoryScores, avgLatency, avgSpeed, overallScore) {
    const tags = [];

    // Calculate average across all categories
    const scores = Object.values(categoryScores).filter(s => s > 0);
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

    // Specialist tags
    if (categoryScores.coding > 80 && categoryScores.coding > avgScore + 10) {
        tags.push('coding-specialist');
    }
    if (categoryScores.reasoning > 80 && categoryScores.reasoning > avgScore + 10) {
        tags.push('reasoning-expert');
    }

    // Generalist tag - all categories > 70 with low variance
    const allAbove70 = scores.every(s => s >= 70);
    const variance = scores.length > 1 ? calculateVariance(scores) : 0;
    if (allAbove70 && variance < 100 && scores.length >= 8) {
        tags.push('generalist');
    }

    // Performance tags
    if (avgSpeed > 60) tags.push('fast');
    if (avgLatency < 3000) tags.push('efficient');

    // Model size tags
    const nameLower = modelName.toLowerCase();
    if (nameLower.includes('2b') || nameLower.includes('3b')) {
        tags.push('small-model');
    } else if (nameLower.includes('70b') || nameLower.includes('405b')) {
        tags.push('large-model');
    }

    return tags;
}

// Calculate variance
function calculateVariance(arr) {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const squaredDiffs = arr.map(x => Math.pow(x - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / arr.length;
}

// Update stats summary
function updateStatsSummary() {
    const totalModels = allModelData.length;
    const avgScore = totalModels > 0
        ? Math.round((allModelData.reduce((sum, m) => sum + m.overallScore, 0) / totalModels) * 10) / 10
        : 0;
    const totalTests = allModelData.reduce((sum, m) => sum + m.totalTests, 0);

    // Find top category (most models with high scores)
    const categoryCounts = {};
    allModelData.forEach(model => {
        Object.entries(model.categoryScores).forEach(([cat, score]) => {
            if (score >= 75) {
                categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
            }
        });
    });

    const topCategory = Object.entries(categoryCounts)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || '-';

    document.getElementById('totalModels').textContent = totalModels;
    document.getElementById('avgOverallScore').textContent = avgScore;
    document.getElementById('totalTests').textContent = totalTests.toLocaleString();
    document.getElementById('topCategory').textContent = formatCategoryName(topCategory);
}

// Render model grid
function renderModelGrid() {
    const grid = document.getElementById('modelGrid');

    if (allModelData.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-inbox"></i>
                <p>No model benchmark data found</p>
                <a href="/benchmark.html" class="btn-primary">Run Benchmarks</a>
            </div>
        `;
        return;
    }

    // Apply filters
    const filteredData = applyFilters();

    grid.innerHTML = filteredData.map(model => `
        <div class="model-card" data-model="${model.name}">
            <div class="model-card-header">
                <h3>${model.name}</h3>
                <div class="model-score">${model.overallScore}</div>
            </div>

            <div class="model-tags">
                ${model.tags.map(tag => `<span class="tag tag-${tag}">${formatTag(tag)}</span>`).join('')}
            </div>

            <div class="model-chart">
                <canvas id="chart-${sanitizeId(model.name)}" width="200" height="200"></canvas>
            </div>

            <div class="model-strengths">
                <div class="strength-label">Strengths:</div>
                ${model.strengths.map(s => `
                    <div class="strength-item">
                        <span class="strength-badge">🟢</span>
                        <span>${formatCategoryName(s.category)}</span>
                        <span class="strength-score">${s.score}</span>
                    </div>
                `).join('')}
            </div>

            <div class="model-stats">
                <div class="stat-row">
                    <span class="stat-icon"><i class="fas fa-clock"></i></span>
                    <span>${model.avgLatency}ms</span>
                </div>
                <div class="stat-row">
                    <span class="stat-icon"><i class="fas fa-gauge-high"></i></span>
                    <span>${model.avgSpeed} tok/s</span>
                </div>
                <div class="stat-row">
                    <span class="stat-icon"><i class="fas fa-vial"></i></span>
                    <span>${model.totalTests} tests</span>
                </div>
            </div>

            <div class="model-actions">
                <button class="btn-select-compare" onclick="toggleCompareSelection('${model.name}')">
                    <i class="fas fa-check-square"></i> Select for Compare
                </button>
            </div>
        </div>
    `).join('');

    // Render radar charts after DOM update
    setTimeout(() => {
        filteredData.forEach(model => {
            renderRadarChart(model);
        });
    }, 100);
}

// Render radar chart for a model
function renderRadarChart(model) {
    const canvasId = `chart-${sanitizeId(model.name)}`;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    // Destroy existing chart if any
    if (radarCharts[model.name]) {
        radarCharts[model.name].destroy();
    }

    const data = CATEGORIES.map(cat => model.categoryScores[cat] || 0);

    radarCharts[model.name] = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: CATEGORIES.map(formatCategoryName),
            datasets: [{
                label: model.name,
                data: data,
                backgroundColor: 'rgba(99, 102, 241, 0.2)',
                borderColor: 'rgba(99, 102, 241, 1)',
                borderWidth: 2,
                pointBackgroundColor: 'rgba(99, 102, 241, 1)',
                pointBorderColor: '#fff',
                pointHoverBackgroundColor: '#fff',
                pointHoverBorderColor: 'rgba(99, 102, 241, 1)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            scales: {
                r: {
                    min: 0,
                    max: 100,
                    ticks: {
                        stepSize: 20,
                        font: { size: 8 }
                    },
                    pointLabels: {
                        font: { size: 9 }
                    }
                }
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return context.parsed.r.toFixed(1);
                        }
                    }
                }
            }
        }
    });
}

// Apply filters
function applyFilters() {
    const categoryFilter = document.getElementById('categoryFilter').value;
    const sortFilter = document.getElementById('sortFilter').value;
    const tagFilter = document.getElementById('tagFilter').value;
    const minScore = parseInt(document.getElementById('minScoreFilter').value) || 0;

    let filtered = [...allModelData];

    // Filter by min score
    filtered = filtered.filter(m => m.overallScore >= minScore);

    // Filter by tag
    if (tagFilter !== 'all') {
        filtered = filtered.filter(m => m.tags.includes(tagFilter));
    }

    // Sort
    switch (sortFilter) {
        case 'overall':
            filtered.sort((a, b) => b.overallScore - a.overallScore);
            break;
        case 'category':
            if (categoryFilter !== 'all') {
                filtered.sort((a, b) =>
                    (b.categoryScores[categoryFilter] || 0) - (a.categoryScores[categoryFilter] || 0)
                );
            }
            break;
        case 'speed':
            filtered.sort((a, b) => b.avgSpeed - a.avgSpeed);
            break;
        case 'latency':
            filtered.sort((a, b) => a.avgLatency - b.avgLatency);
            break;
        case 'tests':
            filtered.sort((a, b) => b.totalTests - a.totalTests);
            break;
    }

    return filtered;
}

// Setup event listeners
function setupEventListeners() {
    document.getElementById('categoryFilter').addEventListener('change', renderModelGrid);
    document.getElementById('sortFilter').addEventListener('change', renderModelGrid);
    document.getElementById('tagFilter').addEventListener('change', renderModelGrid);
    document.getElementById('minScoreFilter').addEventListener('input', renderModelGrid);

    document.getElementById('compareBtn').addEventListener('click', openComparisonModal);
    document.getElementById('exportBtn').addEventListener('click', exportToCSV);
}

// Toggle model selection for comparison
function toggleCompareSelection(modelName) {
    const index = selectedModelsForComparison.indexOf(modelName);

    if (index > -1) {
        selectedModelsForComparison.splice(index, 1);
    } else {
        if (selectedModelsForComparison.length >= 4) {
            alert('Maximum 4 models can be compared at once');
            return;
        }
        selectedModelsForComparison.push(modelName);
    }

    updateCompareButtons();
}

// Update compare button states
function updateCompareButtons() {
    document.querySelectorAll('.btn-select-compare').forEach(btn => {
        const modelName = btn.closest('.model-card').dataset.model;
        if (selectedModelsForComparison.includes(modelName)) {
            btn.classList.add('selected');
            btn.innerHTML = '<i class="fas fa-check-square"></i> Selected';
        } else {
            btn.classList.remove('selected');
            btn.innerHTML = '<i class="fas fa-square"></i> Select for Compare';
        }
    });
}

// Open comparison modal
function openComparisonModal() {
    if (selectedModelsForComparison.length < 2) {
        alert('Please select at least 2 models to compare');
        return;
    }

    const modal = document.getElementById('comparisonModal');
    const content = document.getElementById('comparisonContent');

    const models = selectedModelsForComparison.map(name =>
        allModelData.find(m => m.name === name)
    ).filter(Boolean);

    content.innerHTML = `
        <div class="comparison-grid">
            ${models.map(model => `
                <div class="comparison-card">
                    <h3>${model.name}</h3>
                    <div class="comparison-score">${model.overallScore}</div>
                    <canvas id="compare-chart-${sanitizeId(model.name)}" width="300" height="300"></canvas>
                </div>
            `).join('')}
        </div>
    `;

    modal.style.display = 'block';

    // Render comparison charts
    setTimeout(() => {
        models.forEach(model => {
            renderComparisonChart(model);
        });
    }, 100);
}

// Render comparison chart
function renderComparisonChart(model) {
    const canvasId = `compare-chart-${sanitizeId(model.name)}`;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const data = CATEGORIES.map(cat => model.categoryScores[cat] || 0);

    new Chart(ctx, {
        type: 'radar',
        data: {
            labels: CATEGORIES.map(formatCategoryName),
            datasets: [{
                label: model.name,
                data: data,
                backgroundColor: 'rgba(99, 102, 241, 0.3)',
                borderColor: 'rgba(99, 102, 241, 1)',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            scales: {
                r: {
                    min: 0,
                    max: 100,
                    ticks: { stepSize: 20 }
                }
            }
        }
    });
}

// Close comparison modal
function closeComparisonModal() {
    document.getElementById('comparisonModal').style.display = 'none';
}

// Export to CSV
function exportToCSV() {
    const headers = ['Model', 'Overall Score', 'Avg Latency (ms)', 'Avg Speed (tok/s)', 'Total Tests', 'Tags', ...CATEGORIES];

    const rows = allModelData.map(model => [
        model.name,
        model.overallScore,
        model.avgLatency,
        model.avgSpeed,
        model.totalTests,
        model.tags.join('; '),
        ...CATEGORIES.map(cat => model.categoryScores[cat] || 0)
    ]);

    const csv = [headers, ...rows]
        .map(row => row.map(cell => `"${cell}"`).join(','))
        .join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `model-explorer-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// Utility functions
function formatCategoryName(cat) {
    return cat.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function formatTag(tag) {
    return tag.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function sanitizeId(str) {
    return str.replace(/[^a-zA-Z0-9]/g, '-');
}

// Close modal when clicking outside
window.onclick = function(event) {
    const modal = document.getElementById('comparisonModal');
    if (event.target === modal) {
        closeComparisonModal();
    }
}
