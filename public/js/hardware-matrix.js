/**
 * Hardware Matrix Dashboard
 * Phase 3 Week 12: Visual comparison of hardware performance
 */

let backendStatsData = null;
let allModels = [];
let selectedModel = null;
let comparisonData = null;

// Chart instances
let vramChart, qualityChart, speedChart, efficiencyChart;

// Initialize dashboard
document.addEventListener('DOMContentLoaded', async () => {
    await loadBackendStats();
    await loadAvailableModels();
    setupEventListeners();
});

function setupEventListeners() {
    // Refresh button
    document.getElementById('refreshBtn').addEventListener('click', async () => {
        await loadBackendStats();
        await loadAvailableModels();
        if (selectedModel) {
            await loadHostComparison(selectedModel);
        }
    });

    // Model search
    document.getElementById('modelSearch').addEventListener('input', (e) => {
        filterModelList(e.target.value);
    });

    // Backend filter
    document.getElementById('backendFilter').addEventListener('change', async (e) => {
        if (selectedModel) {
            await loadQuantizationAnalysis(selectedModel, e.target.value);
        }
    });
}

// Load backend statistics
async function loadBackendStats() {
    try {
        const response = await fetch('/api/benchmark/hardware/backend-stats');
        const result = await response.json();

        if (result.status === 'success') {
            backendStatsData = result.data;
            renderBackendStats(result.data.backends);
        }
    } catch (err) {
        console.error('Failed to load backend stats:', err);
        showError('backendStats', 'Failed to load backend statistics');
    }
}

function renderBackendStats(backends) {
    const container = document.getElementById('backendStats');

    if (!backends || backends.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-info-circle"></i>
                <p>No hardware profiles available yet. Run benchmarks to collect data.</p>
            </div>
        `;
        return;
    }

    const statsHTML = backends.map(backend => {
        const iconMap = {
            'CUDA': 'fa-bolt',
            'Metal': 'fa-apple',
            'CPU': 'fa-microchip',
            'ROCm': 'fa-amd',
            'Unknown': 'fa-question-circle'
        };

        const icon = iconMap[backend.backend] || 'fa-microchip';
        const colorMap = {
            'CUDA': '#76b900',
            'Metal': '#007aff',
            'CPU': '#ff9500',
            'ROCm': '#ed1c24',
            'Unknown': '#8e8e93'
        };
        const color = colorMap[backend.backend] || '#8e8e93';

        return `
            <div class="stat-card" style="border-left: 4px solid ${color};">
                <div class="stat-icon" style="color: ${color};">
                    <i class="fas ${icon}"></i>
                </div>
                <div class="stat-content">
                    <div class="stat-value">${backend.backend}</div>
                    <div class="stat-label">${backend.model_count} Models</div>
                    <div class="stat-details">
                        <div><i class="fas fa-gauge-high"></i> ${backend.avg_speed} tok/s</div>
                        <div><i class="fas fa-star"></i> ${backend.avg_quality} quality</div>
                        <div><i class="fas fa-memory"></i> ${backend.avg_vram_mb}MB avg VRAM</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = statsHTML;
}

// Load available models
async function loadAvailableModels() {
    try {
        const response = await fetch('/api/benchmark/hardware/profiles');
        const result = await response.json();

        if (result.status === 'success') {
            // Extract unique models
            const uniqueModels = [...new Set(result.data.profiles.map(p => p.model))];
            allModels = uniqueModels.sort();
            renderModelList(allModels);
        }
    } catch (err) {
        console.error('Failed to load models:', err);
        showError('modelList', 'Failed to load models');
    }
}

function renderModelList(models) {
    const container = document.getElementById('modelList');

    if (!models || models.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-info-circle"></i>
                <p>No models found. Run benchmarks to see hardware profiles.</p>
            </div>
        `;
        return;
    }

    const modelsHTML = models.map(model => `
        <div class="model-item" data-model="${model}">
            <i class="fas fa-cube"></i>
            <span>${model}</span>
            <i class="fas fa-chevron-right"></i>
        </div>
    `).join('');

    container.innerHTML = modelsHTML;

    // Add click handlers
    container.querySelectorAll('.model-item').forEach(item => {
        item.addEventListener('click', () => {
            const model = item.dataset.model;
            selectModel(model);
        });
    });
}

function filterModelList(searchTerm) {
    const filtered = allModels.filter(m =>
        m.toLowerCase().includes(searchTerm.toLowerCase())
    );
    renderModelList(filtered);
}

// Select model and load comparison
async function selectModel(model) {
    selectedModel = model;
    document.getElementById('selectedModelName').textContent = model;
    document.getElementById('comparisonPanel').style.display = 'block';
    document.getElementById('quantizationPanel').style.display = 'block';

    await loadHostComparison(model);
    await loadQuantizationAnalysis(model);
}

// Load host comparison data
async function loadHostComparison(model) {
    try {
        const response = await fetch(`/api/benchmark/hardware/compare/${encodeURIComponent(model)}`);
        const result = await response.json();

        if (result.status === 'success') {
            comparisonData = result.data;
            renderHostComparison(result.data);
            renderComparisonCharts(result.data);
        }
    } catch (err) {
        console.error('Failed to load host comparison:', err);
        showError('comparisonTable', 'Failed to load comparison data');
    }
}

function renderHostComparison(data) {
    const container = document.getElementById('comparisonTable');

    if (!data.profiles || data.profiles.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-info-circle"></i>
                <p>No comparison data available for this model.</p>
            </div>
        `;
        return;
    }

    const tableHTML = `
        <table class="comparison-table">
            <thead>
                <tr>
                    <th><i class="fas fa-server"></i> Host</th>
                    <th><i class="fas fa-microchip"></i> Backend</th>
                    <th><i class="fas fa-code"></i> Quantization</th>
                    <th><i class="fas fa-memory"></i> VRAM (MB)</th>
                    <th><i class="fas fa-star"></i> Quality</th>
                    <th><i class="fas fa-gauge-high"></i> Speed (tok/s)</th>
                    <th><i class="fas fa-chart-line"></i> Efficiency</th>
                    <th><i class="fas fa-vial"></i> Tests</th>
                </tr>
            </thead>
            <tbody>
                ${data.profiles.map((p, index) => {
                    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
                    return `
                        <tr class="${index < 3 ? 'top-rank' : ''}">
                            <td>${medal} ${p.host_label || p.host}</td>
                            <td><span class="badge badge-${p.backend.toLowerCase()}">${p.backend}</span></td>
                            <td><span class="badge-quant">${p.quantization || 'N/A'}</span></td>
                            <td>${p.avg_vram_mb}</td>
                            <td><span class="quality-score">${p.avg_quality}</span></td>
                            <td>${p.avg_speed}</td>
                            <td><strong>${p.vram_efficiency}</strong></td>
                            <td>${p.samples}</td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;

    container.innerHTML = tableHTML;
}

function renderComparisonCharts(data) {
    if (!data.profiles || data.profiles.length === 0) return;

    const labels = data.profiles.map(p => p.host_label || p.host);
    const vramData = data.profiles.map(p => p.avg_vram_mb);
    const qualityData = data.profiles.map(p => p.avg_quality);
    const speedData = data.profiles.map(p => p.avg_speed);
    const efficiencyData = data.profiles.map(p => p.vram_efficiency);

    // Destroy existing charts
    if (vramChart) vramChart.destroy();
    if (qualityChart) qualityChart.destroy();
    if (speedChart) speedChart.destroy();
    if (efficiencyChart) efficiencyChart.destroy();

    // VRAM Chart
    const vramCtx = document.getElementById('vramChart').getContext('2d');
    vramChart = new Chart(vramCtx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'VRAM (MB)',
                data: vramData,
                backgroundColor: 'rgba(99, 102, 241, 0.5)',
                borderColor: 'rgba(99, 102, 241, 1)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: '#fff' } },
                x: { grid: { display: false }, ticks: { color: '#fff' } }
            }
        }
    });

    const maxQuality = Math.max(...qualityData, 10);
    const yAxisMax = maxQuality > 10 ? 100 : 10;

    // Quality Chart
    const qualityCtx = document.getElementById('qualityChart').getContext('2d');
    qualityChart = new Chart(qualityCtx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Quality Score',
                data: qualityData,
                backgroundColor: 'rgba(34, 197, 94, 0.5)',
                borderColor: 'rgba(34, 197, 94, 1)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { min: 0, max: yAxisMax, grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: '#fff' } },
                x: { grid: { display: false }, ticks: { color: '#fff' } }
            }
        }
    });

    // Speed Chart
    const speedCtx = document.getElementById('speedChart').getContext('2d');
    speedChart = new Chart(speedCtx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Speed (tok/s)',
                data: speedData,
                backgroundColor: 'rgba(234, 179, 8, 0.5)',
                borderColor: 'rgba(234, 179, 8, 1)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: '#fff' } },
                x: { grid: { display: false }, ticks: { color: '#fff' } }
            }
        }
    });

    // Efficiency Chart
    const efficiencyCtx = document.getElementById('efficiencyChart').getContext('2d');
    efficiencyChart = new Chart(efficiencyCtx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'VRAM Efficiency',
                data: efficiencyData,
                backgroundColor: 'rgba(168, 85, 247, 0.5)',
                borderColor: 'rgba(168, 85, 247, 1)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: '#fff' } },
                x: { grid: { display: false }, ticks: { color: '#fff' } }
            }
        }
    });
}

// Load quantization analysis
async function loadQuantizationAnalysis(model, backend = '') {
    try {
        const url = backend
            ? `/api/benchmark/hardware/optimal-quantization/${encodeURIComponent(model)}?backend=${backend}`
            : `/api/benchmark/hardware/optimal-quantization/${encodeURIComponent(model)}`;

        const response = await fetch(url);
        const result = await response.json();

        if (result.status === 'success') {
            renderQuantizationAnalysis(result.data);
        }
    } catch (err) {
        console.error('Failed to load quantization analysis:', err);
        showError('quantizationTable', 'Failed to load quantization data');
    }
}

function renderQuantizationAnalysis(data) {
    const container = document.getElementById('quantizationTable');

    if (!data.quantizations || data.quantizations.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-info-circle"></i>
                <p>No quantization data available for this model.</p>
            </div>
        `;
        return;
    }

    const tableHTML = `
        <div class="optimal-badge">
            <i class="fas fa-trophy"></i> Optimal: <strong>${data.optimal}</strong>
        </div>
        <table class="quantization-table">
            <thead>
                <tr>
                    <th><i class="fas fa-code"></i> Quantization</th>
                    <th><i class="fas fa-memory"></i> VRAM (MB)</th>
                    <th><i class="fas fa-star"></i> Quality</th>
                    <th><i class="fas fa-gauge-high"></i> Speed (tok/s)</th>
                    <th><i class="fas fa-chart-line"></i> Efficiency</th>
                    <th><i class="fas fa-vial"></i> Samples</th>
                </tr>
            </thead>
            <tbody>
                ${data.quantizations.map((q, index) => {
                    const isOptimal = q.quantization === data.optimal;
                    return `
                        <tr class="${isOptimal ? 'optimal-row' : ''}">
                            <td>${isOptimal ? '🏆 ' : ''}${q.quantization}</td>
                            <td>${q.avg_vram_mb}</td>
                            <td><span class="quality-score">${q.avg_quality}</span></td>
                            <td>${q.avg_speed}</td>
                            <td><strong>${q.vram_efficiency}</strong></td>
                            <td>${q.samples}</td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;

    container.innerHTML = tableHTML;
}

function showError(containerId, message) {
    const container = document.getElementById(containerId);
    container.innerHTML = `
        <div class="error-state">
            <i class="fas fa-exclamation-triangle"></i>
            <p>${message}</p>
        </div>
    `;
}
