// Results Explorer - Advanced Benchmark Results Analysis

// Global state
let allResults = [];
let filteredResults = [];
let selectedResults = new Set();
let visibleColumns = new Set([
    'select', 'expand', 'model', 'category', 'level', 'quality_score',
    'latency', 'tokens_per_sec', 'success', 'timestamp'
]);

let currentSort = { field: 'timestamp', direction: 'desc' };

// Available columns configuration
const AVAILABLE_COLUMNS = {
    select: { label: 'Select', sortable: false, width: '40px' },
    expand: { label: 'Expand', sortable: false, width: '40px' },
    model: { label: 'Model', sortable: true, width: 'auto' },
    host: { label: 'Host', sortable: true, width: 'auto' },
    category: { label: 'Category', sortable: true, width: '120px' },
    level: { label: 'Level', sortable: true, width: '80px' },
    quality_score: { label: 'Quality', sortable: true, width: '90px' },
    composite_score: { label: 'Composite', sortable: true, width: '100px' },
    latency: { label: 'Latency (ms)', sortable: true, width: '110px' },
    tokens: { label: 'Tokens', sortable: true, width: '80px' },
    tokens_per_sec: { label: 'Tokens/sec', sortable: true, width: '100px' },
    backend: { label: 'Backend', sortable: true, width: '90px' },
    quantization: { label: 'Quantization', sortable: true, width: '110px' },
    scoring_method: { label: 'Scoring', sortable: true, width: '100px' },
    success: { label: 'Status', sortable: true, width: '90px' },
    batch_id: { label: 'Batch ID', sortable: true, width: '100px' },
    timestamp: { label: 'Timestamp', sortable: true, width: '160px' }
};

// Chart instances
let charts = {
    qualityDist: null,
    latencyScatter: null,
    categoryRadar: null
};

// Categories for filters
const CATEGORIES = [
    'coding', 'reasoning', 'factual', 'math', 'creative', 'general',
    'instruction-following', 'summarization', 'translation',
    'multi-turn-reasoning', 'context-retention', 'edge-cases'
];

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
    await loadResults();
    initializeFilters();
    setupEventListeners();
    loadURLState();
    renderTable();
    updateCharts();
});

// Load all benchmark results
async function loadResults() {
    try {
        // Fetch with larger limit or implement pagination
        const response = await fetch('/api/benchmark/results?limit=1000');
        if (!response.ok) throw new Error('Failed to fetch results');

        const data = await response.json();
        allResults = data.data.results || [];
        filteredResults = [...allResults];

        console.log(`Loaded ${allResults.length} results`);
    } catch (error) {
        console.error('Error loading results:', error);
        showError('Failed to load results: ' + error.message);
    }
}

// Initialize filter options
function initializeFilters() {
    // Populate model multi-select
    const models = [...new Set(allResults.map(r => r.model))].sort();
    populateMultiSelect('modelSelectContainer', models, 'model');

    // Populate category multi-select
    populateMultiSelect('categorySelectContainer', CATEGORIES, 'category');

    // Populate host dropdown
    const hosts = [...new Set(allResults.map(r => r.host))].sort();
    populateDropdown('hostFilter', hosts);

    // Populate quantization dropdown
    const quantizations = [...new Set(allResults
        .filter(r => r.hardware_snapshot?.quantization)
        .map(r => r.hardware_snapshot.quantization))].sort();
    populateDropdown('quantizationFilter', quantizations);

    // Setup range slider displays
    updateRangeDisplay('levelMin', 'levelMax', 'levelRangeDisplay');
    updateRangeDisplay('qualityMin', 'qualityMax', 'qualityRangeDisplay');
}

// Populate multi-select checkbox list
function populateMultiSelect(containerId, items, name) {
    const container = document.getElementById(containerId);
    container.innerHTML = items.map(item => `
        <div class="multi-select-item">
            <input type="checkbox" id="${name}-${item}" value="${item}" data-filter="${name}">
            <label for="${name}-${item}">${item}</label>
        </div>
    `).join('');
}

// Populate dropdown
function populateDropdown(selectId, options) {
    const select = document.getElementById(selectId);
    const currentOptions = Array.from(select.querySelectorAll('option')).map(o => o.value);

    options.forEach(opt => {
        if (!currentOptions.includes(opt)) {
            const option = document.createElement('option');
            option.value = opt;
            option.textContent = opt;
            select.appendChild(option);
        }
    });
}

// Update range slider display
function updateRangeDisplay(minId, maxId, displayId) {
    const min = document.getElementById(minId);
    const max = document.getElementById(maxId);
    const display = document.getElementById(displayId);

    const update = () => {
        const minVal = parseInt(min.value);
        const maxVal = parseInt(max.value);

        // Ensure min <= max
        if (minVal > maxVal) {
            if (min === document.activeElement) {
                max.value = minVal;
            } else {
                min.value = maxVal;
            }
        }

        display.textContent = `${min.value} - ${max.value}`;
    };

    min.addEventListener('input', update);
    max.addEventListener('input', update);
    update();
}

// Setup event listeners
function setupEventListeners() {
    // Refresh button
    document.getElementById('refreshBtn').addEventListener('click', async () => {
        await loadResults();
        applyFilters();
    });

    // Clear filters button
    document.getElementById('clearFiltersBtn').addEventListener('click', clearAllFilters);

    // Export buttons
    document.getElementById('exportCsvBtn').addEventListener('click', () => exportData('csv'));
    document.getElementById('exportJsonBtn').addEventListener('click', () => exportData('json'));

    // Compare button
    document.getElementById('compareBtn').addEventListener('click', openComparisonModal);

    // Toggle columns button
    document.getElementById('toggleColumnsBtn').addEventListener('click', openColumnsModal);

    // Filter change listeners
    document.querySelectorAll('.filter-group input, .filter-group select').forEach(el => {
        el.addEventListener('change', handleFilterChange);
    });

    document.querySelectorAll('.multi-select-item input[type="checkbox"]').forEach(el => {
        el.addEventListener('change', handleFilterChange);
    });

    // Model search
    document.getElementById('modelSearch').addEventListener('input', (e) => {
        const search = e.target.value.toLowerCase();
        document.querySelectorAll('#modelSelectContainer .multi-select-item').forEach(item => {
            const label = item.querySelector('label').textContent.toLowerCase();
            item.style.display = label.includes(search) ? 'flex' : 'none';
        });
    });
}

// Handle filter changes
function handleFilterChange() {
    applyFilters();
    saveURLState();
}

// Apply all filters
function applyFilters() {
    filteredResults = allResults.filter(result => {
        // Date range
        const dateFrom = document.getElementById('dateFrom').value;
        const dateTo = document.getElementById('dateTo').value;

        if (dateFrom || dateTo) {
            const resultDate = new Date(result.timestamp);
            if (dateFrom && resultDate < new Date(dateFrom)) return false;
            if (dateTo && resultDate > new Date(dateTo + 'T23:59:59')) return false;
        }

        // Model filter
        const selectedModels = Array.from(document.querySelectorAll('#modelSelectContainer input:checked'))
            .map(cb => cb.value);
        if (selectedModels.length > 0 && !selectedModels.includes(result.model)) return false;

        // Category filter
        const selectedCategories = Array.from(document.querySelectorAll('#categorySelectContainer input:checked'))
            .map(cb => cb.value);
        if (selectedCategories.length > 0 && !selectedCategories.includes(result.prompt_category)) return false;

        // Level range
        const levelMin = parseInt(document.getElementById('levelMin').value);
        const levelMax = parseInt(document.getElementById('levelMax').value);
        if (result.prompt_level < levelMin || result.prompt_level > levelMax) return false;

        // Quality range
        const qualityMinInput = parseFloat(document.getElementById('qualityMin').value);
        const qualityMaxInput = parseFloat(document.getElementById('qualityMax').value);
        const qualityMin = Number.isNaN(qualityMinInput) ? 0 : qualityMinInput;
        const qualityMax = Number.isNaN(qualityMaxInput) ? 10 : qualityMaxInput;

        const isQualityFilterActive = qualityMin > 0 || qualityMax < 10;

        if (isQualityFilterActive) {
            if (result.quality_score === null || result.quality_score === undefined) return false;
            if (result.quality_score < qualityMin || result.quality_score > qualityMax) return false;
        }

        // Host filter
        const hostFilter = document.getElementById('hostFilter').value;
        if (hostFilter && result.host !== hostFilter) return false;

        // Backend filter
        const backendFilter = document.getElementById('backendFilter').value;
        if (backendFilter && result.hardware_snapshot?.backend !== backendFilter) return false;

        // Quantization filter
        const quantizationFilter = document.getElementById('quantizationFilter').value;
        if (quantizationFilter && result.hardware_snapshot?.quantization !== quantizationFilter) return false;

        // Success filter
        const successFilter = document.getElementById('successFilter').value;
        if (successFilter !== '') {
            if (successFilter === 'true' && !result.success) return false;
            if (successFilter === 'false' && result.success) return false;
        }

        // Batch ID filter
        const batchIdFilter = document.getElementById('batchIdFilter').value.trim();
        if (batchIdFilter && result.batch_id !== batchIdFilter) return false;

        // Scoring method filter
        const scoringMethodFilter = document.getElementById('scoringMethodFilter').value;
        if (scoringMethodFilter && result.scoring_method !== scoringMethodFilter) return false;

        return true;
    });

    renderTable();
    updateCharts();
    updateResultsCount();
}

// Clear all filters
function clearAllFilters() {
    // Reset date inputs
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value = '';

    // Uncheck all checkboxes
    document.querySelectorAll('.multi-select-item input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
    });

    // Reset ranges
    document.getElementById('levelMin').value = 1;
    document.getElementById('levelMax').value = 10;
    document.getElementById('qualityMin').value = 0;
    document.getElementById('qualityMax').value = 10;
    updateRangeDisplay('levelMin', 'levelMax', 'levelRangeDisplay');
    updateRangeDisplay('qualityMin', 'qualityMax', 'qualityRangeDisplay');

    // Reset dropdowns
    document.getElementById('hostFilter').value = '';
    document.getElementById('backendFilter').value = '';
    document.getElementById('quantizationFilter').value = '';
    document.getElementById('successFilter').value = '';
    document.getElementById('batchIdFilter').value = '';
    document.getElementById('scoringMethodFilter').value = '';

    // Clear model search
    document.getElementById('modelSearch').value = '';
    document.querySelectorAll('#modelSelectContainer .multi-select-item').forEach(item => {
        item.style.display = 'flex';
    });

    applyFilters();
    saveURLState();
}

// Render results table
function renderTable() {
    const container = document.getElementById('resultsTable');

    if (filteredResults.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-inbox"></i>
                <p>No results found matching your filters</p>
            </div>
        `;
        return;
    }

    // Apply sorting
    const sorted = sortResults([...filteredResults]);

    // Build table HTML
    const tableHtml = `
        <table class="results-table">
            <thead>
                <tr>
                    ${renderTableHeaders()}
                </tr>
            </thead>
            <tbody>
                ${sorted.map(result => renderTableRow(result)).join('')}
            </tbody>
        </table>
    `;

    container.innerHTML = tableHtml;

    // Add event listeners for checkboxes, expand buttons, and sorting
    setupTableEventListeners();
}

// Render table headers
function renderTableHeaders() {
    return Object.entries(AVAILABLE_COLUMNS)
        .filter(([key]) => visibleColumns.has(key))
        .map(([key, config]) => {
            if (!config.sortable) {
                return `<th style="width: ${config.width}">${config.label}</th>`;
            }

            const sortClass = currentSort.field === key
                ? (currentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc')
                : '';

            return `<th class="sortable ${sortClass}" data-sort="${key}" style="width: ${config.width}">
                ${config.label}
            </th>`;
        })
        .join('');
}

// Render single table row
function renderTableRow(result) {
    const isSelected = selectedResults.has(result._id);
    const rowId = `row-${result._id}`;

    let html = `<tr data-id="${result._id}">`;

    // Select checkbox
    if (visibleColumns.has('select')) {
        html += `<td class="checkbox-cell">
            <input type="checkbox" class="result-checkbox" data-id="${result._id}" ${isSelected ? 'checked' : ''}>
        </td>`;
    }

    // Expand button
    if (visibleColumns.has('expand')) {
        html += `<td class="expand-cell">
            <button class="expand-btn" data-id="${result._id}">
                <i class="fas fa-chevron-right"></i>
            </button>
        </td>`;
    }

    // Data columns
    if (visibleColumns.has('model')) {
        html += `<td>${escapeHtml(result.model)}</td>`;
    }
    if (visibleColumns.has('host')) {
        html += `<td>${escapeHtml(result.host)}</td>`;
    }
    if (visibleColumns.has('category')) {
        html += `<td><span class="badge badge-category">${result.prompt_category || 'N/A'}</span></td>`;
    }
    if (visibleColumns.has('level')) {
        html += `<td><span class="badge badge-level">L${result.prompt_level || '?'}</span></td>`;
    }
    if (visibleColumns.has('quality_score')) {
        html += `<td>${renderScore(result.quality_score)}</td>`;
    }
    if (visibleColumns.has('composite_score')) {
        html += `<td>${renderScore(result.composite_score)}</td>`;
    }
    if (visibleColumns.has('latency')) {
        html += `<td>${result.latency ? result.latency.toFixed(0) : 'N/A'}</td>`;
    }
    if (visibleColumns.has('tokens')) {
        html += `<td>${result.tokens || 'N/A'}</td>`;
    }
    if (visibleColumns.has('tokens_per_sec')) {
        html += `<td>${result.tokens_per_sec ? parseFloat(result.tokens_per_sec).toFixed(1) : 'N/A'}</td>`;
    }
    if (visibleColumns.has('backend')) {
        html += `<td>${result.hardware_snapshot?.backend || 'N/A'}</td>`;
    }
    if (visibleColumns.has('quantization')) {
        html += `<td>${result.hardware_snapshot?.quantization || 'N/A'}</td>`;
    }
    if (visibleColumns.has('scoring_method')) {
        html += `<td>${result.scoring_method || 'N/A'}</td>`;
    }
    if (visibleColumns.has('success')) {
        html += `<td><span class="badge badge-${result.success ? 'success' : 'failed'}">
            ${result.success ? 'Success' : 'Failed'}
        </span></td>`;
    }
    if (visibleColumns.has('batch_id')) {
        html += `<td>${result.batch_id || 'N/A'}</td>`;
    }
    if (visibleColumns.has('timestamp')) {
        html += `<td>${new Date(result.timestamp).toLocaleString()}</td>`;
    }

    html += '</tr>';

    // Add expandable row
    html += `<tr class="expanded-content" id="expanded-${result._id}" style="display: none;">
        <td colspan="${visibleColumns.size}">
            ${renderExpandedContent(result)}
        </td>
    </tr>`;

    return html;
}

// Render expanded row content
function renderExpandedContent(result) {
    return `
        <div class="expanded-grid">
            <div class="expanded-section">
                <h4>Test Details</h4>
                <div class="expanded-field">
                    <label>Prompt</label>
                    <div class="value">${escapeHtml(result.prompt?.substring(0, 200) || 'N/A')}${result.prompt?.length > 200 ? '...' : ''}</div>
                </div>
                <div class="expanded-field">
                    <label>Response</label>
                    <div class="response-box">${escapeHtml(result.response || 'No response')}</div>
                </div>
            </div>
            <div class="expanded-section">
                <h4>Scoring Details</h4>
                <div class="expanded-field">
                    <label>Quality Score</label>
                    <div class="value">${result.quality_score || 'N/A'}</div>
                </div>
                <div class="expanded-field">
                    <label>Composite Score</label>
                    <div class="value">${result.composite_score || 'N/A'}</div>
                </div>
                <div class="expanded-field">
                    <label>Scoring Method</label>
                    <div class="value">${result.scoring_method || 'N/A'}</div>
                </div>
                <div class="expanded-field">
                    <label>Judge Model</label>
                    <div class="value">${result.judge_model || 'N/A'}</div>
                </div>
                ${result.quality_explanation ? `
                <div class="expanded-field">
                    <label>Explanation</label>
                    <div class="response-box">${escapeHtml(result.quality_explanation)}</div>
                </div>
                ` : ''}
                <h4 style="margin-top: 1.5rem;">Hardware Profile</h4>
                <div class="expanded-field">
                    <label>Backend</label>
                    <div class="value">${result.hardware_snapshot?.backend || 'N/A'}</div>
                </div>
                <div class="expanded-field">
                    <label>VRAM Usage</label>
                    <div class="value">${result.hardware_snapshot?.vram_usage_mb ? result.hardware_snapshot.vram_usage_mb + ' MB' : 'N/A'}</div>
                </div>
                <div class="expanded-field">
                    <label>Quantization</label>
                    <div class="value">${result.hardware_snapshot?.quantization || 'N/A'}</div>
                </div>
            </div>
        </div>
    `;
}

// Render score with color coding
function renderScore(score) {
    if (score === null || score === undefined) return 'N/A';

    let className = 'score-low';
    // Adjusted thresholds based on actual 0-10 scale
    if (score >= 8) className = 'score-high';      // Top tier (80%+)
    else if (score >= 6) className = 'score-medium'; // Mid tier (60%+)

    return `<span class="score-display ${className}">${score.toFixed(1)}</span>`;
}

// Setup table event listeners
function setupTableEventListeners() {
    // Checkbox listeners
    document.querySelectorAll('.result-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const id = e.target.dataset.id;
            if (e.target.checked) {
                selectedResults.add(id);
            } else {
                selectedResults.delete(id);
            }
            updateSelectedCount();
        });
    });

    // Expand button listeners
    document.querySelectorAll('.expand-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.currentTarget.dataset.id;
            const expandedRow = document.getElementById(`expanded-${id}`);
            const button = e.currentTarget;

            if (expandedRow.style.display === 'none') {
                expandedRow.style.display = 'table-row';
                button.classList.add('expanded');
                button.closest('tr').classList.add('expanded');
            } else {
                expandedRow.style.display = 'none';
                button.classList.remove('expanded');
                button.closest('tr').classList.remove('expanded');
            }
        });
    });

    // Sort header listeners
    document.querySelectorAll('.sortable').forEach(th => {
        th.addEventListener('click', (e) => {
            const field = e.currentTarget.dataset.sort;

            if (currentSort.field === field) {
                currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.field = field;
                currentSort.direction = 'desc';
            }

            renderTable();
        });
    });
}

// Sort results
function sortResults(results) {
    const { field, direction } = currentSort;
    const multiplier = direction === 'asc' ? 1 : -1;

    return results.sort((a, b) => {
        let aVal = a[field];
        let bVal = b[field];

        // Handle nested fields
        if (field === 'backend') {
            aVal = a.hardware_snapshot?.backend;
            bVal = b.hardware_snapshot?.backend;
        } else if (field === 'quantization') {
            aVal = a.hardware_snapshot?.quantization;
            bVal = b.hardware_snapshot?.quantization;
        }

        // Handle null values
        if (aVal === null || aVal === undefined) return 1 * multiplier;
        if (bVal === null || bVal === undefined) return -1 * multiplier;

        // Compare
        if (typeof aVal === 'string') {
            return aVal.localeCompare(bVal) * multiplier;
        } else {
            return (aVal - bVal) * multiplier;
        }
    });
}

// Update results count
function updateResultsCount() {
    const countEl = document.getElementById('resultsCount');
    countEl.textContent = `${filteredResults.length} result${filteredResults.length !== 1 ? 's' : ''}`;
}

// Update selected count
function updateSelectedCount() {
    const countEl = document.getElementById('selectedCount');
    const count = selectedResults.size;

    if (count === 0) {
        countEl.style.display = 'none';
    } else {
        countEl.style.display = 'block';
        countEl.textContent = `${count} selected`;
    }

    // Enable/disable action buttons
    const hasSelection = count > 0;
    document.getElementById('exportCsvBtn').disabled = !hasSelection;
    document.getElementById('exportJsonBtn').disabled = !hasSelection;
    document.getElementById('compareBtn').disabled = count < 2 || count > 4;
}

// Export data
function exportData(format) {
    const selectedData = allResults.filter(r => selectedResults.has(r._id));

    if (selectedData.length === 0) {
        alert('No results selected');
        return;
    }

    if (format === 'csv') {
        exportCSV(selectedData);
    } else if (format === 'json') {
        exportJSON(selectedData);
    }
}

// Export to CSV
function exportCSV(data) {
    const headers = [
        'model', 'host', 'category', 'level', 'quality_score', 'composite_score',
        'latency', 'tokens', 'tokens_per_sec', 'backend', 'quantization',
        'scoring_method', 'success', 'batch_id', 'timestamp'
    ];

    const csvContent = [
        headers.join(','),
        ...data.map(row => headers.map(header => {
            let value;
            if (header === 'backend') value = row.hardware_snapshot?.backend || '';
            else if (header === 'quantization') value = row.hardware_snapshot?.quantization || '';
            else value = row[header] || '';

            // Escape commas and quotes
            if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
                value = `"${value.replace(/"/g, '""')}"`;
            }
            return value;
        }).join(','))
    ].join('\n');

    downloadFile(csvContent, 'benchmark-results.csv', 'text/csv');
}

// Export to JSON
function exportJSON(data) {
    const jsonContent = JSON.stringify(data, null, 2);
    downloadFile(jsonContent, 'benchmark-results.json', 'application/json');
}

// Download file
function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Open columns modal
function openColumnsModal() {
    const modal = document.getElementById('columnsModal');
    const grid = document.getElementById('columnsGrid');

    grid.innerHTML = Object.entries(AVAILABLE_COLUMNS)
        .filter(([key]) => key !== 'select' && key !== 'expand')
        .map(([key, config]) => `
            <div class="column-toggle">
                <input type="checkbox" id="col-${key}" value="${key}"
                    ${visibleColumns.has(key) ? 'checked' : ''}>
                <label for="col-${key}">${config.label}</label>
            </div>
        `).join('');

    // Add event listeners
    grid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const col = e.target.value;
            if (e.target.checked) {
                visibleColumns.add(col);
            } else {
                visibleColumns.delete(col);
            }
            renderTable();
        });
    });

    modal.style.display = 'block';
}

// Close columns modal
function closeColumnsModal() {
    document.getElementById('columnsModal').style.display = 'none';
}

// Open comparison modal
function openComparisonModal() {
    const selectedData = allResults.filter(r => selectedResults.has(r._id));

    if (selectedData.length < 2 || selectedData.length > 4) {
        alert('Please select 2-4 results to compare');
        return;
    }

    const modal = document.getElementById('comparisonModal');
    const content = document.getElementById('comparisonContent');

    content.innerHTML = `
        <div class="comparison-grid">
            ${selectedData.map(result => renderComparisonCard(result)).join('')}
        </div>
    `;

    modal.style.display = 'block';
}

// Render comparison card
function renderComparisonCard(result) {
    return `
        <div class="comparison-card">
            <h3>${escapeHtml(result.model)}</h3>
            <div class="comparison-field">
                <label>Category</label>
                <div class="value">${result.prompt_category}</div>
            </div>
            <div class="comparison-field">
                <label>Level</label>
                <div class="value">${result.prompt_level}</div>
            </div>
            <div class="comparison-field">
                <label>Quality Score</label>
                <div class="value">${renderScore(result.quality_score)}</div>
            </div>
            <div class="comparison-field">
                <label>Composite Score</label>
                <div class="value">${renderScore(result.composite_score)}</div>
            </div>
            <div class="comparison-field">
                <label>Latency</label>
                <div class="value">${result.latency ? result.latency.toFixed(0) + ' ms' : 'N/A'}</div>
            </div>
            <div class="comparison-field">
                <label>Tokens/sec</label>
                <div class="value">${result.tokens_per_sec ? parseFloat(result.tokens_per_sec).toFixed(1) : 'N/A'}</div>
            </div>
            <div class="comparison-field">
                <label>Backend</label>
                <div class="value">${result.hardware_snapshot?.backend || 'N/A'}</div>
            </div>
            <div class="comparison-field">
                <label>Quantization</label>
                <div class="value">${result.hardware_snapshot?.quantization || 'N/A'}</div>
            </div>
            <div class="comparison-field">
                <label>Status</label>
                <div class="value"><span class="badge badge-${result.success ? 'success' : 'failed'}">
                    ${result.success ? 'Success' : 'Failed'}
                </span></div>
            </div>
        </div>
    `;
}

// Close comparison modal
function closeComparisonModal() {
    document.getElementById('comparisonModal').style.display = 'none';
}

// Close detail modal
function closeDetailModal() {
    document.getElementById('detailModal').style.display = 'none';
}

// Toggle filters panel
function toggleFiltersPanel() {
    const body = document.getElementById('filtersPanelBody');
    const btn = document.getElementById('filtersCollapseBtn');

    body.classList.toggle('collapsed');
    btn.classList.toggle('collapsed');
}

// Update charts
function updateCharts() {
    updateQualityDistChart();
    updateLatencyScatterChart();
    updateCategoryRadarChart();
}

// Update quality distribution chart
function updateQualityDistChart() {
    const ctx = document.getElementById('qualityDistChart');
    if (!ctx) return;

    const scores = filteredResults
        .filter(r => r.quality_score !== null)
        .map(r => r.quality_score);

    // Create histogram buckets for 0-10 scale
    const buckets = Array(10).fill(0);
    scores.forEach(score => {
        const bucket = Math.min(Math.floor(score), 9);  // Direct floor for 0-10 scale
        buckets[bucket]++;
    });

    if (charts.qualityDist) {
        charts.qualityDist.destroy();
    }

    charts.qualityDist = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['0-1', '1-2', '2-3', '3-4', '4-5', '5-6', '6-7', '7-8', '8-9', '9-10'],
            datasets: [{
                label: 'Count',
                data: buckets,
                backgroundColor: 'rgba(99, 102, 241, 0.6)',
                borderColor: 'rgba(99, 102, 241, 1)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            animation: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: { beginAtZero: true, ticks: { color: 'rgba(255, 255, 255, 0.7)' } },
                x: { ticks: { color: 'rgba(255, 255, 255, 0.7)' } }
            }
        }
    });
}

// Update latency scatter chart
function updateLatencyScatterChart() {
    const ctx = document.getElementById('latencyScatterChart');
    if (!ctx) return;

    const data = filteredResults
        .filter(r => r.quality_score !== null && r.latency)
        .map(r => ({
            x: r.prompt_level,
            y: r.latency,
            quality: r.quality_score
        }));

    if (charts.latencyScatter) {
        charts.latencyScatter.destroy();
    }

    charts.latencyScatter = new Chart(ctx, {
        type: 'scatter',
        data: {
            datasets: [{
                label: 'Results',
                data: data,
                backgroundColor: data.map(d => {
                    if (d.quality >= 8) return 'rgba(34, 197, 94, 0.6)';  // Top tier (80%+)
                    if (d.quality >= 6) return 'rgba(234, 179, 8, 0.6)';  // Mid tier (60%+)
                    return 'rgba(239, 68, 68, 0.6)';  // Low tier
                }),
                borderColor: 'rgba(99, 102, 241, 1)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            animation: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Latency (ms)', color: 'rgba(255, 255, 255, 0.7)' },
                    ticks: { color: 'rgba(255, 255, 255, 0.7)' }
                },
                x: {
                    title: { display: true, text: 'Level', color: 'rgba(255, 255, 255, 0.7)' },
                    ticks: { color: 'rgba(255, 255, 255, 0.7)' }
                }
            }
        }
    });
}

// Update category radar chart
function updateCategoryRadarChart() {
    const ctx = document.getElementById('categoryRadarChart');
    if (!ctx) return;

    // Calculate average quality per category
    const categoryData = {};
    filteredResults.forEach(r => {
        if (r.quality_score !== null && r.prompt_category) {
            if (!categoryData[r.prompt_category]) {
                categoryData[r.prompt_category] = { total: 0, count: 0 };
            }
            categoryData[r.prompt_category].total += r.quality_score;
            categoryData[r.prompt_category].count++;
        }
    });

    const labels = Object.keys(categoryData).sort();
    const data = labels.map(cat => categoryData[cat].total / categoryData[cat].count);

    if (charts.categoryRadar) {
        charts.categoryRadar.destroy();
    }

    charts.categoryRadar = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Avg Quality',
                data: data,
                backgroundColor: 'rgba(99, 102, 241, 0.2)',
                borderColor: 'rgba(99, 102, 241, 1)',
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            animation: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                r: {
                    beginAtZero: true,
                    max: 10,  // Adjusted to 0-10 scale
                    ticks: { color: 'rgba(255, 255, 255, 0.7)' },
                    pointLabels: { color: 'rgba(255, 255, 255, 0.7)', font: { size: 10 } },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                }
            }
        }
    });
}

// URL state management
function saveURLState() {
    const params = new URLSearchParams();

    // Save active filters
    const dateFrom = document.getElementById('dateFrom').value;
    const dateTo = document.getElementById('dateTo').value;
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);

    const selectedModels = Array.from(document.querySelectorAll('#modelSelectContainer input:checked'))
        .map(cb => cb.value);
    if (selectedModels.length > 0) params.set('models', selectedModels.join(','));

    const selectedCategories = Array.from(document.querySelectorAll('#categorySelectContainer input:checked'))
        .map(cb => cb.value);
    if (selectedCategories.length > 0) params.set('categories', selectedCategories.join(','));

    // Update URL without reload
    const newUrl = `${window.location.pathname}${params.toString() ? '?' + params.toString() : ''}`;
    window.history.replaceState({}, '', newUrl);
}

function loadURLState() {
    const params = new URLSearchParams(window.location.search);

    // Restore filters from URL
    const dateFrom = params.get('dateFrom');
    const dateTo = params.get('dateTo');
    if (dateFrom) document.getElementById('dateFrom').value = dateFrom;
    if (dateTo) document.getElementById('dateTo').value = dateTo;

    const models = params.get('models');
    if (models) {
        models.split(',').forEach(model => {
            const cb = document.querySelector(`#modelSelectContainer input[value="${model}"]`);
            if (cb) cb.checked = true;
        });
    }

    const categories = params.get('categories');
    if (categories) {
        categories.split(',').forEach(cat => {
            const cb = document.querySelector(`#categorySelectContainer input[value="${cat}"]`);
            if (cb) cb.checked = true;
        });
    }

    // Apply filters if any were set
    if (params.toString()) {
        applyFilters();
    }
}

// Utility function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Show error
function showError(message) {
    const container = document.getElementById('resultsTable');
    container.innerHTML = `
        <div class="error-state">
            <i class="fas fa-exclamation-triangle"></i>
            <p>${escapeHtml(message)}</p>
            <button onclick="location.reload()" class="btn-primary">Reload</button>
        </div>
    `;
}

// Close modals when clicking outside
window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.style.display = 'none';
    }
});
