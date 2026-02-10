// Results Explorer - Advanced Benchmark Results Analysis

// Global state
let allResults = [];
let filteredResults = [];
let selectedResults = new Set();
let visibleColumns = new Set([
    'select', 'expand', 'inspect', 'model', 'category', 'level', 'quality_score',
    'latency', 'tokens_per_sec', 'success', 'timestamp'
]);

let currentSort = { field: 'timestamp', direction: 'desc' };

// Available columns configuration
const AVAILABLE_COLUMNS = {
    select: { label: 'Select', sortable: false, width: '40px' },
    expand: { label: 'Expand', sortable: false, width: '40px' },
    inspect: { label: 'Inspect', sortable: false, width: '70px' },
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
    categoryRadar: null,
    modelBar: null
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

    // Inspect button
    if (visibleColumns.has('inspect')) {
        html += `<td>
            <button class="inspect-btn" onclick="openTestInspector('${result._id}')">
                <i class="fas fa-microscope"></i> View
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
        html += `<td>${renderScore(result.composite_score, '0-100')}</td>`;
    }
    if (visibleColumns.has('latency')) {
        html += `<td>${result.latency ? result.latency.toFixed(0) : 'N/A'}</td>`;
    }
    if (visibleColumns.has('tokens')) {
        html += `<td>${result.tokens != null ? result.tokens : 'N/A'}</td>`;
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
                    <label>Prompt (${result.prompt?.length || 0} chars)</label>
                    <div class="response-box">${escapeHtml(result.prompt || 'N/A')}</div>
                </div>
                <div class="expanded-field">
                    <label>Response</label>
                    <div class="response-box">${escapeHtml(result.response || result.error || 'No response')}</div>
                </div>
            </div>
            <div class="expanded-section">
                <h4>Scoring Details</h4>
                <div class="expanded-field">
                    <label>Quality Score</label>
                    <div class="value">${result.quality_score != null ? result.quality_score.toFixed(1) : 'N/A'}</div>
                </div>
                <div class="expanded-field">
                    <label>Composite Score</label>
                    <div class="value">${result.composite_score != null ? result.composite_score.toFixed(1) : 'N/A'}</div>
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
// scale: '0-10' (quality_score) or '0-100' (composite_score)
function renderScore(score, scale = '0-10') {
    if (score === null || score === undefined) return 'N/A';

    let className = 'score-low';
    if (scale === '0-100') {
        if (score >= 80) className = 'score-high';
        else if (score >= 60) className = 'score-medium';
    } else {
        if (score >= 8) className = 'score-high';
        else if (score >= 6) className = 'score-medium';
    }

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

        // Handle null values - always sort to bottom regardless of direction
        if (aVal === null || aVal === undefined) return 1;
        if (bVal === null || bVal === undefined) return -1;

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
            if (header === 'backend') value = row.hardware_snapshot?.backend ?? '';
            else if (header === 'quantization') value = row.hardware_snapshot?.quantization ?? '';
            else value = row[header] ?? '';

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
        .filter(([key]) => key !== 'select' && key !== 'expand' && key !== 'inspect')
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
                <div class="value">${renderScore(result.composite_score, '0-100')}</div>
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
    updateModelBarChart();
    renderCategoryStats();
}

// Update quality distribution chart - ENHANCED
function updateQualityDistChart() {
    const ctx = document.getElementById('qualityDistChart');
    if (!ctx) return;

    const scores = filteredResults
        .filter(r => r.quality_score !== null)
        .map(r => r.quality_score);

    // Create histogram buckets for 0-10 scale
    const buckets = Array(10).fill(0);
    scores.forEach(score => {
        const bucket = Math.min(Math.floor(score), 9);
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
                backgroundColor: [
                    'rgba(239, 68, 68, 0.7)',    // 0-1: red
                    'rgba(245, 126, 32, 0.7)',   // 1-2: orange-red
                    'rgba(249, 115, 22, 0.7)',   // 2-3: orange
                    'rgba(251, 146, 60, 0.7)',   // 3-4: orange-light
                    'rgba(248, 113, 113, 0.7)',  // 4-5: red-light
                    'rgba(234, 179, 8, 0.7)',    // 5-6: yellow
                    'rgba(132, 204, 22, 0.7)',   // 6-7: lime
                    'rgba(74, 222, 128, 0.7)',   // 7-8: green-light
                    'rgba(34, 197, 94, 0.7)',    // 8-9: green
                    'rgba(20, 184, 166, 0.7)'    // 9-10: teal
                ],
                borderColor: [
                    'rgba(239, 68, 68, 1)',
                    'rgba(245, 126, 32, 1)',
                    'rgba(249, 115, 22, 1)',
                    'rgba(251, 146, 60, 1)',
                    'rgba(248, 113, 113, 1)',
                    'rgba(234, 179, 8, 1)',
                    'rgba(132, 204, 22, 1)',
                    'rgba(74, 222, 128, 1)',
                    'rgba(34, 197, 94, 1)',
                    'rgba(20, 184, 166, 1)'
                ],
                borderWidth: 2,
                borderRadius: 4
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
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.8)',
                        font: { size: 11, weight: '600' }
                    },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                },
                x: {
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.8)',
                        font: { size: 11, weight: '600' }
                    },
                    grid: { display: false }
                }
            }
        }
    });
}

// Update latency scatter chart - ENHANCED
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

    // Group data by quality tier
    const topTier = data.filter(d => d.quality >= 8);
    const midTier = data.filter(d => d.quality >= 6 && d.quality < 8);
    const lowTier = data.filter(d => d.quality < 6);

    charts.latencyScatter = new Chart(ctx, {
        type: 'scatter',
        data: {
            datasets: [
                {
                    label: `Excellent (8+) - ${topTier.length}`,
                    data: topTier,
                    backgroundColor: 'rgba(34, 197, 94, 0.7)',
                    borderColor: 'rgba(22, 163, 74, 1)',
                    borderWidth: 2,
                    pointRadius: 6,
                    pointHoverRadius: 8
                },
                {
                    label: `Good (6-8) - ${midTier.length}`,
                    data: midTier,
                    backgroundColor: 'rgba(234, 179, 8, 0.7)',
                    borderColor: 'rgba(202, 138, 4, 1)',
                    borderWidth: 2,
                    pointRadius: 6,
                    pointHoverRadius: 8
                },
                {
                    label: `Needs Work (<6) - ${lowTier.length}`,
                    data: lowTier,
                    backgroundColor: 'rgba(239, 68, 68, 0.7)',
                    borderColor: 'rgba(220, 38, 38, 1)',
                    borderWidth: 2,
                    pointRadius: 6,
                    pointHoverRadius: 8
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            animation: false,
            layout: {
                padding: {
                    bottom: 35
                }
            },
            interaction: {
                intersect: false,
                mode: 'nearest'
            },
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: '#fff',
                        font: { size: 12, weight: 'bold' },
                        padding: 12,
                        usePointStyle: true,
                        pointStyle: 'circle'
                    }
                },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(0, 0, 0, 0.9)',
                    borderColor: 'rgba(99, 102, 241, 1)',
                    borderWidth: 2,
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    padding: 10,
                    displayColors: false,
                    callbacks: {
                        label: (ctx) => [
                            `Level: ${ctx.raw.x}`,
                            `Latency: ${ctx.raw.y.toFixed(0)}ms`,
                            `Quality: ${ctx.raw.quality.toFixed(1)}/10`
                        ]
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Latency (ms)', color: 'rgba(255, 255, 255, 0.8)' },
                    ticks: { color: 'rgba(255, 255, 255, 0.8)', font: { size: 11, weight: '600' } },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                },
                x: {
                    title: { display: true, text: 'Complexity Level', color: 'rgba(255, 255, 255, 0.8)' },
                    ticks: { color: 'rgba(255, 255, 255, 0.8)', font: { size: 11, weight: '600' } },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                }
            }
        }
    });
}

// Update category radar chart - SIMPLE & EFFECTIVE - Numbers visible in legend
function updateCategoryRadarChart() {
    const ctx = document.getElementById('categoryRadarChart');
    if (!ctx) return;

    // Calculate statistics per category
    const categoryData = {};
    filteredResults.forEach(r => {
        if (r.quality_score !== null && r.prompt_category) {
            if (!categoryData[r.prompt_category]) {
                categoryData[r.prompt_category] = { total: 0, count: 0, min: 10, max: 0 };
            }
            categoryData[r.prompt_category].total += r.quality_score;
            categoryData[r.prompt_category].count++;
            categoryData[r.prompt_category].min = Math.min(categoryData[r.prompt_category].min, r.quality_score);
            categoryData[r.prompt_category].max = Math.max(categoryData[r.prompt_category].max, r.quality_score);
        }
    });

    const labels = Object.keys(categoryData).sort();
    const avgData = labels.map(cat => (categoryData[cat].total / categoryData[cat].count).toFixed(2));
    const countData = labels.map(cat => categoryData[cat].count);
    const minData = labels.map(cat => categoryData[cat].min);
    const maxData = labels.map(cat => categoryData[cat].max);

    if (charts.categoryRadar) {
        charts.categoryRadar.destroy();
    }

    // Create enhanced labels that show the actual scores
    const enhancedLabels = labels.map((label, i) => `${label} (${avgData[i]})`);

    charts.categoryRadar = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: enhancedLabels,
            datasets: [
                {
                    label: 'Average Quality Score',
                    data: avgData,
                    backgroundColor: 'rgba(99, 102, 241, 0.35)',
                    borderColor: 'rgba(99, 102, 241, 1)',
                    borderWidth: 3,
                    pointRadius: 8,
                    pointBorderWidth: 3,
                    pointBorderColor: '#fff',
                    pointBackgroundColor: 'rgba(99, 102, 241, 1)',
                    pointHoverRadius: 10,
                    fill: true,
                    tension: 0.3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            animation: false,
            interaction: {
                intersect: false,
                mode: 'nearest'
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(0, 0, 0, 0.95)',
                    borderColor: 'rgba(99, 102, 241, 1)',
                    borderWidth: 2,
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    padding: 12,
                    titleFont: { size: 13, weight: 'bold' },
                    bodyFont: { size: 12, weight: '600' },
                    displayColors: false,
                    usePointStyle: false,
                    callbacks: {
                        title: (ctx) => {
                            // Extract category name from label (remove the score part)
                            const labelText = ctx[0].label;
                            const categoryName = labelText.substring(0, labelText.lastIndexOf(' ('));
                            return categoryName;
                        },
                        label: (ctx) => {
                            const idx = ctx.dataIndex;
                            return `Quality: ${avgData[idx]}/10`;
                        },
                        afterLabel: (ctx) => {
                            const idx = ctx.dataIndex;
                            return [
                                `Samples: ${countData[idx]}`,
                                `Range: ${minData[idx].toFixed(1)} - ${maxData[idx].toFixed(1)}`
                            ];
                        }
                    }
                }
            },
            scales: {
                r: {
                    beginAtZero: true,
                    max: 10,
                    ticks: {
                        color: 'rgba(255, 255, 255, 0.95)',
                        font: { size: 12, weight: 'bold' },
                        stepSize: 2,
                        backdropColor: 'transparent'
                    },
                    pointLabels: {
                        color: 'rgba(255, 255, 255, 0.95)',
                        font: { size: 10, weight: 'bold' },
                        padding: 5
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.2)',
                        circular: true,
                        drawBorder: true
                    }
                }
            }
        }
    });
}

// Update model comparison bar chart
function updateModelBarChart() {
    const ctx = document.getElementById('modelBarChart');
    if (!ctx) return;

    // Calculate stats per model
    const modelData = {};
    filteredResults.forEach(r => {
        if (r.quality_score !== null && r.model) {
            if (!modelData[r.model]) {
                modelData[r.model] = { total: 0, count: 0, latency: 0 };
            }
            modelData[r.model].total += r.quality_score;
            modelData[r.model].count++;
            if (r.latency) modelData[r.model].latency += r.latency;
        }
    });

    // If no model data, show empty state
    if (Object.keys(modelData).length === 0) {
        const canvas = document.getElementById('modelBarChart');
        const parent = canvas.parentElement;
        parent.innerHTML = '<div style="padding: 2rem; text-align: center; color: rgba(255,255,255,0.5);">No model data available</div>';
        if (charts.modelBar) charts.modelBar.destroy();
        return;
    }

    const models = Object.keys(modelData)
        .sort((a, b) => (modelData[b].total / modelData[b].count) - (modelData[a].total / modelData[a].count))
        .slice(0, 12); // Top 12 models

    const avgScores = models.map(m => parseFloat((modelData[m].total / modelData[m].count).toFixed(2)));
    const counts = models.map(m => modelData[m].count);

    if (charts.modelBar) {
        charts.modelBar.destroy();
    }

    try {
        charts.modelBar = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: models,
                datasets: [{
                    label: 'Average Quality Score',
                    data: avgScores,
                    backgroundColor: avgScores.map(score => {
                        if (score >= 8) return 'rgba(34, 197, 94, 0.7)';
                        if (score >= 6) return 'rgba(234, 179, 8, 0.7)';
                        return 'rgba(239, 68, 68, 0.7)';
                    }),
                    borderColor: avgScores.map(score => {
                        if (score >= 8) return 'rgba(22, 163, 74, 1)';
                        if (score >= 6) return 'rgba(202, 138, 4, 1)';
                        return 'rgba(220, 38, 38, 1)';
                    }),
                    borderWidth: 2,
                    borderRadius: 6
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: true,
                animation: false,
                plugins: {
                    legend: {
                        display: true,
                        labels: {
                            color: '#fff',
                            font: { size: 11, weight: 'bold' },
                            padding: 10
                        }
                    },
                    tooltip: {
                        enabled: true,
                        backgroundColor: 'rgba(0, 0, 0, 0.9)',
                        borderColor: 'rgba(99, 102, 241, 1)',
                        borderWidth: 2,
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        padding: 10,
                        displayColors: false,
                        callbacks: {
                            label: (ctx) => {
                                const idx = ctx.dataIndex;
                                return [
                                    `Quality: ${avgScores[idx].toFixed(1)}/10`,
                                    `Samples: ${counts[idx]}`
                                ];
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        max: 10,
                        ticks: { color: 'rgba(255, 255, 255, 0.8)', font: { size: 10, weight: '600' } },
                        grid: { color: 'rgba(255, 255, 255, 0.1)' }
                    },
                    y: {
                        ticks: { color: 'rgba(255, 255, 255, 0.8)', font: { size: 10, weight: '600' } },
                        grid: { display: false }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error rendering model bar chart:', error);
    }
}

// Render category statistics table
function renderCategoryStats() {
    const container = document.getElementById('categoryStatsContainer');
    if (!container) return;

    // Calculate comprehensive stats per category
    const categoryData = {};
    filteredResults.forEach(r => {
        if (r.quality_score !== null && r.prompt_category) {
            if (!categoryData[r.prompt_category]) {
                categoryData[r.prompt_category] = {
                    total: 0,
                    count: 0,
                    min: 10,
                    max: 0,
                    latencyTotal: 0,
                    latencyCount: 0,
                    successCount: 0
                };
            }
            const stats = categoryData[r.prompt_category];
            stats.total += r.quality_score;
            stats.count++;
            stats.min = Math.min(stats.min, r.quality_score);
            stats.max = Math.max(stats.max, r.quality_score);
            if (r.latency) {
                stats.latencyTotal += r.latency;
                stats.latencyCount++;
            }
            if (r.success) stats.successCount++;
        }
    });

    // Sort by average quality descending
    const sorted = Object.entries(categoryData)
        .sort((a, b) => (b[1].total / b[1].count) - (a[1].total / a[1].count));

    // Build HTML table
    let html = `
        <table class="stats-table">
            <thead>
                <tr>
                    <th>Category</th>
                    <th>Samples</th>
                    <th>Avg Quality</th>
                    <th>Range</th>
                    <th>Avg Latency</th>
                    <th>Success Rate</th>
                    <th>Trend</th>
                </tr>
            </thead>
            <tbody>
    `;

    sorted.forEach(([category, stats]) => {
        const avg = (stats.total / stats.count).toFixed(2);
        const avgLatency = stats.latencyCount > 0 ? (stats.latencyTotal / stats.latencyCount).toFixed(0) : 'N/A';
        const successRate = ((stats.successCount / stats.count) * 100).toFixed(1);
        const range = `${stats.min.toFixed(1)} - ${stats.max.toFixed(1)}`;
        
        // Determine quality color
        const qualityClass = avg >= 8 ? 'excellent' : (avg >= 6 ? 'good' : 'needs-work');
        
        // Simple trend indicator
        const trend = avg >= 7 ? '↑' : (avg >= 5 ? '→' : '↓');

        html += `
            <tr>
                <td><strong>${escapeHtml(category)}</strong></td>
                <td class="stat-center">${stats.count}</td>
                <td class="stat-quality stat-${qualityClass}">${avg}</td>
                <td class="stat-center">${range}</td>
                <td class="stat-center">${avgLatency}ms</td>
                <td class="stat-center"><span class="badge badge-success">${successRate}%</span></td>
                <td class="stat-center trend-${qualityClass}">${trend}</td>
            </tr>
        `;
    });

    html += `
            </tbody>
        </table>
    `;

    container.innerHTML = html;
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

// ==========================================
// Test Inspector Functionality
// ==========================================

let currentInspectorResult = null;
let currentInspectorTab = 'warmup';

// Open Test Inspector modal
async function openTestInspector(resultId) {
    const modal = document.getElementById('testInspectorModal');
    const content = document.getElementById('inspectorContent');

    // Show loading state
    content.innerHTML = `
        <div class="inspector-loading">
            <i class="fas fa-spinner fa-spin"></i>
            <p>Loading test details...</p>
        </div>
    `;
    modal.style.display = 'block';

    try {
        // Fetch full result details
        const response = await fetch(`/api/benchmark/results/${resultId}`);
        if (!response.ok) throw new Error('Failed to fetch result details');

        const data = await response.json();
        currentInspectorResult = data.data;

        // Set default tab
        currentInspectorTab = 'warmup';

        // Render content
        renderInspectorContent();
        setupInspectorTabs();

    } catch (error) {
        console.error('Error loading result details:', error);
        content.innerHTML = `
            <div class="error-state">
                <i class="fas fa-exclamation-triangle"></i>
                <p>Failed to load test details: ${escapeHtml(error.message)}</p>
            </div>
        `;
    }
}

// Setup tab click handlers
function setupInspectorTabs() {
    document.querySelectorAll('.inspector-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            currentInspectorTab = tabName;

            // Update active tab
            document.querySelectorAll('.inspector-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Re-render content
            renderInspectorContent();
        });
    });
}

// Render inspector content based on current tab
function renderInspectorContent() {
    const content = document.getElementById('inspectorContent');
    const r = currentInspectorResult;

    if (!r) {
        content.innerHTML = '<div class="no-data"><i class="fas fa-database"></i><p>No data available</p></div>';
        return;
    }

    let html = '';

    switch (currentInspectorTab) {
        case 'warmup':
            html = renderWarmupTab(r);
            break;
        case 'execution':
            html = renderExecutionTab(r);
            break;
        case 'judging':
            html = renderJudgingTab(r);
            break;
        case 'hardware':
            html = renderHardwareTab(r);
            break;
    }

    content.innerHTML = html;

    // Setup copy buttons
    content.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.target;
            const textEl = document.getElementById(targetId);
            if (textEl) {
                navigator.clipboard.writeText(textEl.textContent);
                btn.innerHTML = '<i class="fas fa-check"></i> Copied';
                setTimeout(() => btn.innerHTML = '<i class="fas fa-copy"></i> Copy', 2000);
            }
        });
    });
}

// Render Warmup tab
function renderWarmupTab(r) {
    const warmup = r.warmup;
    const judgeWarmup = r.judge_warmup;

    return `
        <!-- Model Warmup Phase -->
        <div class="phase-card">
            <div class="phase-header">
                <h3><i class="fas fa-fire"></i> Model Warmup</h3>
                <span class="phase-status ${warmup?.response ? 'success' : 'pending'}">
                    <i class="fas fa-${warmup?.response ? 'check-circle' : 'clock'}"></i>
                    ${warmup?.response ? 'Completed' : 'No data captured'}
                </span>
            </div>
            <div class="phase-body">
                ${warmup ? `
                    <div class="prompt-response-pair">
                        <div class="prompt-block">
                            <div class="block-header">
                                <h4><i class="fas fa-arrow-right"></i> Warmup Prompt</h4>
                                <button class="copy-btn" data-target="warmup-prompt"><i class="fas fa-copy"></i> Copy</button>
                            </div>
                            <div class="block-content" id="warmup-prompt">${escapeHtml(warmup.prompt || 'N/A')}</div>
                        </div>
                        <div class="response-block">
                            <div class="block-header">
                                <h4><i class="fas fa-arrow-left"></i> Warmup Response</h4>
                                <button class="copy-btn" data-target="warmup-response"><i class="fas fa-copy"></i> Copy</button>
                            </div>
                            <div class="block-content" id="warmup-response">${escapeHtml(warmup.response || 'N/A')}</div>
                        </div>
                    </div>
                    <div class="metrics-grid">
                        <div class="metric-card">
                            <div class="metric-label">Warmup Latency</div>
                            <div class="metric-value">${warmup.latency_ms ? warmup.latency_ms.toFixed(0) + ' ms' : 'N/A'}</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-label">Already Loaded</div>
                            <div class="metric-value ${warmup.already_loaded ? 'positive' : 'warning'}">
                                ${warmup.already_loaded === null ? 'Unknown' : (warmup.already_loaded ? 'Yes' : 'No')}
                            </div>
                        </div>
                    </div>
                ` : `
                    <div class="no-data">
                        <i class="fas fa-info-circle"></i>
                        <p>Model warmup data was not captured for this test.</p>
                        <p style="font-size: 0.875rem; opacity: 0.7; margin-top: 0.5rem;">
                            This may be from a batch run before warmup capture was enabled.
                        </p>
                    </div>
                `}
            </div>
        </div>

        <!-- Judge Warmup Phase -->
        ${r.judge_model ? `
        <div class="phase-card">
            <div class="phase-header">
                <h3><i class="fas fa-gavel"></i> Judge Warmup</h3>
                <span class="phase-status ${judgeWarmup?.response ? 'success' : 'pending'}">
                    <i class="fas fa-${judgeWarmup?.response ? 'check-circle' : 'clock'}"></i>
                    ${judgeWarmup?.response ? 'Completed' : 'No data captured'}
                </span>
            </div>
            <div class="phase-body">
                ${judgeWarmup ? `
                    <div class="prompt-response-pair">
                        <div class="prompt-block">
                            <div class="block-header">
                                <h4><i class="fas fa-arrow-right"></i> Warmup Prompt</h4>
                            </div>
                            <div class="block-content">${escapeHtml(judgeWarmup.prompt || 'N/A')}</div>
                        </div>
                        <div class="response-block">
                            <div class="block-header">
                                <h4><i class="fas fa-arrow-left"></i> Warmup Response</h4>
                            </div>
                            <div class="block-content">${escapeHtml(judgeWarmup.response || 'N/A')}</div>
                        </div>
                    </div>
                    <div class="metrics-grid">
                        <div class="metric-card">
                            <div class="metric-label">Warmup Latency</div>
                            <div class="metric-value">${judgeWarmup.latency_ms ? judgeWarmup.latency_ms.toFixed(0) + ' ms' : 'N/A'}</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-label">Already Loaded</div>
                            <div class="metric-value ${judgeWarmup.already_loaded ? 'positive' : 'warning'}">
                                ${judgeWarmup.already_loaded === null ? 'Unknown' : (judgeWarmup.already_loaded ? 'Yes' : 'No')}
                            </div>
                        </div>
                    </div>
                ` : `
                    <div class="no-data">
                        <i class="fas fa-info-circle"></i>
                        <p>Judge warmup data was not captured for this test.</p>
                    </div>
                `}
            </div>
        </div>
        ` : ''}
    `;
}

// Render Execution tab
function renderExecutionTab(r) {
    return `
        <div class="phase-card">
            <div class="phase-header">
                <h3><i class="fas fa-play"></i> Test Execution</h3>
                <span class="phase-status ${r.success ? 'success' : 'failed'}">
                    <i class="fas fa-${r.success ? 'check-circle' : 'times-circle'}"></i>
                    ${r.success ? 'Success' : 'Failed'}
                </span>
            </div>
            <div class="phase-body">
                <!-- Test Metadata -->
                <div class="metrics-grid" style="margin-bottom: 1.5rem;">
                    <div class="metric-card">
                        <div class="metric-label">Model</div>
                        <div class="metric-value" style="font-size: 1rem;">${escapeHtml(r.model)}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Category</div>
                        <div class="metric-value" style="font-size: 1rem;">${r.prompt_category || 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Level</div>
                        <div class="metric-value">${r.prompt_level || 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Prompt Name</div>
                        <div class="metric-value" style="font-size: 0.875rem;">${escapeHtml(r.prompt_name || 'N/A')}</div>
                    </div>
                </div>

                <!-- Prompt Hint (if applied) -->
                ${r.execution_settings?.hint_text ? `
                <div class="hint-banner" style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; margin-bottom: 12px; background: linear-gradient(90deg, rgba(34, 197, 94, 0.15), rgba(34, 197, 94, 0.05)); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 6px; font-size: 0.85rem;">
                    <i class="fas fa-magic" style="color: #22c55e;"></i>
                    <span style="color: var(--muted);">Hint appended:</span>
                    <code style="background: rgba(0,0,0,0.2); padding: 2px 8px; border-radius: 4px; color: #22c55e; font-size: 0.8rem;">${escapeHtml(r.execution_settings.hint_text)}</code>
                </div>
                ` : ''}

                <!-- Prompt and Response -->
                <div class="prompt-response-pair">
                    <div class="prompt-block">
                        <div class="block-header">
                            <h4><i class="fas fa-comment"></i> Test Prompt</h4>
                            <button class="copy-btn" data-target="test-prompt"><i class="fas fa-copy"></i> Copy</button>
                        </div>
                        <div class="block-content" id="test-prompt">${escapeHtml(r.prompt || 'N/A')}</div>
                    </div>
                    <div class="response-block">
                        <div class="block-header">
                            <h4><i class="fas fa-reply"></i> Model Response</h4>
                            <button class="copy-btn" data-target="test-response"><i class="fas fa-copy"></i> Copy</button>
                        </div>
                        <div class="block-content" id="test-response">${escapeHtml(r.response || r.error || 'No response')}</div>
                    </div>
                </div>

                ${r.expected_answer ? `
                <div style="margin-top: 1rem;">
                    <div class="prompt-block" style="width: 100%;">
                        <div class="block-header">
                            <h4><i class="fas fa-bullseye"></i> Expected Answer</h4>
                        </div>
                        <div class="block-content">${escapeHtml(r.expected_answer)}</div>
                    </div>
                </div>
                ` : ''}

                <!-- Performance Metrics -->
                <div class="metrics-grid" style="margin-top: 1.5rem;">
                    <div class="metric-card">
                        <div class="metric-label">Latency</div>
                        <div class="metric-value">${r.latency ? r.latency.toFixed(0) + ' ms' : 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Tokens Generated</div>
                        <div class="metric-value">${r.tokens || 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Token Limit</div>
                        <div class="metric-value ${r.truncation?.response_truncated ? 'negative' : ''}">${r.truncation?.response_limit || 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Tokens/sec</div>
                        <div class="metric-value">${r.tokens_per_sec ? parseFloat(r.tokens_per_sec).toFixed(1) : 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Host</div>
                        <div class="metric-value" style="font-size: 0.875rem;">${escapeHtml(r.host || 'N/A')}</div>
                    </div>
                </div>

                ${r.truncation?.response_truncated ? `
                <div class="truncation-warning">
                    <i class="fas fa-exclamation-triangle"></i>
                    <span>Response was truncated at ${r.truncation.response_tokens} tokens (limit: ${r.truncation.response_limit})</span>
                </div>
                ` : ''}

            </div>
        </div>
    `;
}

// Render Judging tab
function renderJudgingTab(r) {
    const hasJudging = r.scoring_method && r.scoring_method !== 'disabled' && r.scoring_method !== 'pending';

    if (!hasJudging) {
        const canRejudge = r.scoring_method === 'pending' && r.success && r.response;
        return `
            <div class="phase-card">
                <div class="phase-header">
                    <h3><i class="fas fa-gavel"></i> Quality Judging</h3>
                    <span class="phase-status pending">
                        <i class="fas fa-minus-circle"></i>
                        ${r.scoring_method === 'disabled' ? 'Disabled' : 'Pending'}
                    </span>
                </div>
                <div class="phase-body">
                    <div class="no-data">
                        <i class="fas fa-gavel"></i>
                        <p>Quality scoring was ${r.scoring_method === 'disabled' ? 'not enabled' : 'not completed'} for this test.</p>
                        ${canRejudge ? `
                        <button class="rejudge-btn" onclick="rejudgeResult('${r._id}')" style="margin-top: 1rem; padding: 0.75rem 1.5rem; background: var(--primary, #6366f1); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500;">
                            <i class="fas fa-redo"></i> Run Judging Now
                        </button>
                        <p style="font-size: 0.75rem; color: var(--muted); margin-top: 0.5rem;">This will evaluate the response with the judge model.</p>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    const testDuration = r.latency || 0;
    const judgeDuration = r.scoring_time_ms || 0;
    const totalDuration = testDuration + judgeDuration;

    return `
        <div class="phase-card">
            <div class="phase-header">
                <h3><i class="fas fa-gavel"></i> Quality Judging</h3>
                <span class="phase-status ${r.scoring_method === 'llm_failed' ? 'failed' : 'success'}">
                    <i class="fas fa-${r.scoring_method === 'llm_failed' ? 'times-circle' : 'check-circle'}"></i>
                    ${r.scoring_method === 'llm_failed' ? 'Failed' : 'Completed'}
                </span>
            </div>
            <div class="phase-body">
                <!-- Session Timing Comparison -->
                <h4 style="margin: 0 0 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-clock"></i> Session Timing
                </h4>
                <div class="timing-comparison" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem; padding: 1rem; background: rgba(0,0,0,0.2); border-radius: 8px;">
                    <div style="text-align: center; padding: 1rem; background: rgba(99, 102, 241, 0.1); border-radius: 6px; border: 1px solid rgba(99, 102, 241, 0.2);">
                        <div style="font-size: 0.75rem; color: var(--muted); margin-bottom: 0.5rem;"><i class="fas fa-robot"></i> TEST EXECUTION</div>
                        <div style="font-size: 1.5rem; font-weight: 600; color: var(--text);">${testDuration ? (testDuration / 1000).toFixed(2) + 's' : 'N/A'}</div>
                        <div style="font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem;">${r.tokens || 0} tokens @ ${r.tokens_per_sec ? parseFloat(r.tokens_per_sec).toFixed(1) : '?'} tok/s</div>
                    </div>
                    <div style="text-align: center; padding: 1rem; background: rgba(168, 85, 247, 0.1); border-radius: 6px; border: 1px solid rgba(168, 85, 247, 0.2);">
                        <div style="font-size: 0.75rem; color: var(--muted); margin-bottom: 0.5rem;"><i class="fas fa-gavel"></i> JUDGE EVALUATION</div>
                        <div style="font-size: 1.5rem; font-weight: 600; color: var(--text);">${judgeDuration ? (judgeDuration / 1000).toFixed(2) + 's' : 'N/A'}</div>
                        <div style="font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem;">Total: ${(totalDuration / 1000).toFixed(2)}s</div>
                    </div>
                </div>

                <!-- Session Parameters -->
                <h4 style="margin: 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-cog"></i> Session Parameters
                </h4>
                <div class="metrics-grid" style="margin-bottom: 1.5rem;">
                    <div class="metric-card">
                        <div class="metric-label">Test Model</div>
                        <div class="metric-value" style="font-size: 0.8rem;">${escapeHtml(r.model || 'N/A')}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Test Host</div>
                        <div class="metric-value" style="font-size: 0.8rem;">${escapeHtml(r.host || 'N/A')}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Token Limit (num_predict)</div>
                        <div class="metric-value">${r.execution_settings?.num_predict || r.truncation?.response_limit || 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Tokens Generated</div>
                        <div class="metric-value">${r.tokens || 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Judge Model</div>
                        <div class="metric-value" style="font-size: 0.8rem;">${escapeHtml(r.judge_model || 'N/A')}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Judge Host</div>
                        <div class="metric-value" style="font-size: 0.8rem;">${escapeHtml(r.judge_host || 'Same as test')}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Scoring Method</div>
                        <div class="metric-value" style="font-size: 0.875rem;">${r.scoring_method || 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Scoring Type</div>
                        <div class="metric-value" style="font-size: 0.875rem;">${r.scoring_type || 'N/A'}</div>
                    </div>
                </div>

                <!-- Scoring Results -->
                <h4 style="margin: 1.5rem 0 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-star"></i> Scoring Results
                </h4>
                <div class="metrics-grid" style="margin-bottom: 1rem;">
                    <div class="metric-card">
                        <div class="metric-label">
                            Quality Score
                            <i class="fas fa-info-circle" style="margin-left: 4px; cursor: help; opacity: 0.6;" title="0-10 scale. Evaluated by the judge LLM based on category-specific dimensions (e.g., accuracy, clarity, completeness). Higher is better."></i>
                        </div>
                        <div class="metric-value ${getScoreClass(r.quality_score)}">${r.quality_score !== null ? r.quality_score.toFixed(1) : 'N/A'}<span style="font-size: 0.6rem; color: var(--muted);"> / 10</span></div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">
                            Composite Score
                            <i class="fas fa-info-circle" style="margin-left: 4px; cursor: help; opacity: 0.6;" title="0-100 scale. Weighted combination of Quality (×10), Latency (faster=higher), and Speed (tok/s). Weights vary by prompt category."></i>
                        </div>
                        <div class="metric-value">${r.composite_score !== null ? r.composite_score.toFixed(1) : 'N/A'}<span style="font-size: 0.6rem; color: var(--muted);"> / 100</span></div>
                    </div>
                </div>

                <!-- Score Explanation -->
                <div style="padding: 0.75rem 1rem; background: rgba(99, 102, 241, 0.1); border-radius: 6px; border-left: 3px solid var(--primary, #6366f1); margin-bottom: 1.5rem; font-size: 0.75rem; color: var(--muted);">
                    <strong style="color: var(--text);">How scores are calculated:</strong><br>
                    <strong>Quality Score (0-10):</strong> LLM judge evaluates response against category-specific criteria (accuracy, logic, clarity, etc.).<br>
                    <strong>Composite Score (0-100):</strong> = Quality×${r.composite_profile_used?.includes('reasoning') || r.prompt_category === 'reasoning' ? '80%' : r.composite_profile_used?.includes('coding') || r.prompt_category === 'coding' ? '60%' : '40-80%'} + Latency×${r.composite_profile_used?.includes('reasoning') ? '10%' : '10-40%'} + Speed×${r.composite_profile_used?.includes('reasoning') ? '10%' : '10-20%'} (weights depend on <em>${r.prompt_category || 'category'}</em>)
                </div>

                ${r.judge_warmup ? `
                <!-- Judge Warmup Info -->
                <h4 style="margin: 1.5rem 0 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-fire"></i> Judge Warmup
                </h4>
                <div class="metrics-grid" style="margin-bottom: 1rem;">
                    <div class="metric-card">
                        <div class="metric-label">Warmup Latency</div>
                        <div class="metric-value">${r.judge_warmup.latency_ms ? (r.judge_warmup.latency_ms / 1000).toFixed(2) + 's' : 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Already Loaded</div>
                        <div class="metric-value" style="color: ${r.judge_warmup.already_loaded ? '#22c55e' : '#f59e0b'};">
                            ${r.judge_warmup.already_loaded === null ? 'Unknown' : (r.judge_warmup.already_loaded ? 'Yes' : 'No')}
                        </div>
                    </div>
                </div>
                ${r.judge_warmup.prompt ? `
                <details style="margin-bottom: 1rem;">
                    <summary style="cursor: pointer; color: var(--muted); font-size: 0.875rem;"><i class="fas fa-code"></i> Judge Warmup Prompt/Response</summary>
                    <div class="prompt-block" style="margin-top: 0.5rem;">
                        <div class="block-content" style="max-height: 150px;">${escapeHtml(r.judge_warmup.prompt)}</div>
                    </div>
                    ${r.judge_warmup.response ? `
                    <div class="response-block" style="margin-top: 0.5rem;">
                        <div class="block-content" style="max-height: 150px;">${escapeHtml(r.judge_warmup.response)}</div>
                    </div>
                    ` : ''}
                </details>
                ` : ''}
                ` : ''}

                ${r.quality_breakdown ? `
                <!-- Score Breakdown by Dimension -->
                <h4 style="margin: 1.5rem 0 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-chart-bar"></i> Score Breakdown
                </h4>
                <div class="score-breakdown">
                    ${Object.entries(r.quality_breakdown)
                        .filter(([key]) => key !== 'explanation' && key !== 'overall')
                        .map(([dimension, score]) => `
                            <div class="dimension-score">
                                <div class="dimension-header">
                                    <span class="dimension-name">${dimension.replace(/_/g, ' ')}</span>
                                    <span class="dimension-value ${getScoreClass(score)}">${typeof score === 'number' ? score.toFixed(1) : score}</span>
                                </div>
                                <div class="dimension-bar">
                                    <div class="dimension-fill" style="width: ${(score / 10) * 100}%; background: ${getScoreColor(score)};"></div>
                                </div>
                            </div>
                        `).join('')}
                </div>
                ` : ''}

                ${r.quality_explanation ? `
                <h4 style="margin: 1.5rem 0 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-lightbulb"></i> Judge Explanation
                </h4>
                <div class="prompt-block" style="width: 100%;">
                    <div class="block-content">${escapeHtml(r.quality_explanation)}</div>
                </div>
                ` : ''}

                ${r.judge_prompt ? `
                <h4 style="margin: 1.5rem 0 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-paper-plane"></i> Judge Prompt (sent to evaluator)
                </h4>
                <div class="prompt-block" style="width: 100%;">
                    <div class="block-header">
                        <h4><i class="fas fa-code"></i> Full Prompt</h4>
                        <button class="copy-btn" data-target="judge-prompt"><i class="fas fa-copy"></i> Copy</button>
                    </div>
                    <div class="block-content" id="judge-prompt" style="max-height: 400px;">${escapeHtml(r.judge_prompt)}</div>
                </div>
                ` : ''}

                ${r.judge_raw_response ? `
                <h4 style="margin: 1.5rem 0 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-file-alt"></i> Raw Judge Response
                </h4>
                <div class="response-block" style="width: 100%;">
                    <div class="block-header">
                        <h4><i class="fas fa-robot"></i> Raw Output</h4>
                        <button class="copy-btn" data-target="judge-raw"><i class="fas fa-copy"></i> Copy</button>
                    </div>
                    <div class="block-content" id="judge-raw" style="max-height: 300px;">${escapeHtml(r.judge_raw_response)}</div>
                </div>
                ` : ''}

                ${r.truncation?.judge_truncated ? `
                <div class="truncation-warning">
                    <i class="fas fa-exclamation-triangle"></i>
                    <span>Judge output was truncated (${r.truncation.judge_tokens} tokens).</span>
                </div>
                ` : ''}
            </div>
        </div>
    `;
}

// Render Hardware tab
function renderHardwareTab(r) {
    const hw = r.hardware_snapshot || {};
    const judgeHw = r.judge_hardware_snapshot || {};
    const trunc = r.truncation || {};
    const meta = hw.detection_metadata || {};
    const judgeMeta = judgeHw.detection_metadata || {};

    // Determine backend display with helpful context for test host
    let backendDisplay = hw.backend || 'Not detected';
    let backendNote = '';
    if (hw.backend === 'Unknown' || !hw.backend) {
        backendNote = meta.source ? `(Detection via ${meta.source})` : '(Hardware detection unavailable)';
    }

    // Determine backend display for judge host
    let judgeBackendDisplay = judgeHw.backend || 'Not detected';
    let judgeBackendNote = '';
    if (judgeHw.backend === 'Unknown' || !judgeHw.backend) {
        judgeBackendNote = judgeMeta.source ? `(Detection via ${judgeMeta.source})` : '(Hardware detection unavailable)';
    }

    // Check if judge runs on same host
    const sameHost = !r.judge_host || r.judge_host === r.host;

    return `
        <div class="hardware-grid">
            <!-- Test Execution Host -->
            <div class="hardware-card">
                <h4><i class="fas fa-microchip"></i> Test Host (Model Under Test)</h4>
                <div class="hardware-item">
                    <span class="hardware-label">Host</span>
                    <span class="hardware-value">${escapeHtml(r.host || 'N/A')}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Model</span>
                    <span class="hardware-value">${escapeHtml(r.model || 'N/A')}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Backend</span>
                    <span class="hardware-value">${backendDisplay} <span style="font-size: 0.7rem; color: var(--muted);">${backendNote}</span></span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">VRAM Usage</span>
                    <span class="hardware-value">${hw.vram_usage_mb ? hw.vram_usage_mb + ' MB' : 'N/A'}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Quantization</span>
                    <span class="hardware-value">${hw.quantization || 'N/A'}</span>
                </div>
                ${meta.timestamp ? `
                <div class="hardware-item">
                    <span class="hardware-label">Detected At</span>
                    <span class="hardware-value" style="font-size: 0.75rem;">${new Date(meta.timestamp).toLocaleString()}</span>
                </div>
                ` : ''}
            </div>

            <!-- Judge Host -->
            <div class="hardware-card">
                <h4><i class="fas fa-gavel"></i> Judge Host${sameHost ? ' <span style="font-size: 0.7rem; color: var(--muted);">(Same as test)</span>' : ''}</h4>
                <div class="hardware-item">
                    <span class="hardware-label">Host</span>
                    <span class="hardware-value">${escapeHtml(r.judge_host || r.host || 'N/A')}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Judge Model</span>
                    <span class="hardware-value">${escapeHtml(r.judge_model || 'N/A')}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Backend</span>
                    <span class="hardware-value">${judgeBackendDisplay} <span style="font-size: 0.7rem; color: var(--muted);">${judgeBackendNote}</span></span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">VRAM Usage</span>
                    <span class="hardware-value">${judgeHw.vram_usage_mb ? judgeHw.vram_usage_mb + ' MB' : 'N/A'}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Quantization</span>
                    <span class="hardware-value">${judgeHw.quantization || 'N/A'}</span>
                </div>
                ${judgeMeta.timestamp ? `
                <div class="hardware-item">
                    <span class="hardware-label">Detected At</span>
                    <span class="hardware-value" style="font-size: 0.75rem;">${new Date(judgeMeta.timestamp).toLocaleString()}</span>
                </div>
                ` : ''}
            </div>

            <!-- Batch Information -->
            <div class="hardware-card">
                <h4><i class="fas fa-layer-group"></i> Batch Information</h4>
                <div class="hardware-item">
                    <span class="hardware-label">Batch ID</span>
                    <span class="hardware-value" style="font-family: monospace; font-size: 0.75rem;">${r.batch_id || 'Standalone'}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Timestamp</span>
                    <span class="hardware-value">${r.timestamp ? new Date(r.timestamp).toLocaleString() : 'N/A'}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Result ID</span>
                    <span class="hardware-value" style="font-family: monospace; font-size: 0.75rem;">${r._id || 'N/A'}</span>
                </div>
            </div>

            <!-- Truncation Analysis -->
            <div class="hardware-card">
                <h4><i class="fas fa-cut"></i> Truncation Analysis</h4>
                <div class="hardware-item">
                    <span class="hardware-label">Response Truncated</span>
                    <span class="hardware-value" style="color: ${trunc.response_truncated ? '#ef4444' : '#22c55e'};">
                        ${trunc.response_truncated ? 'Yes' : 'No'}
                    </span>
                </div>
                ${trunc.response_truncated ? `
                <div class="hardware-item">
                    <span class="hardware-label">Response Tokens</span>
                    <span class="hardware-value">${trunc.response_tokens || 'N/A'} / ${trunc.response_limit || 'N/A'}</span>
                </div>
                ` : ''}
                <div class="hardware-item">
                    <span class="hardware-label">Judge Output Truncated</span>
                    <span class="hardware-value" style="color: ${trunc.judge_truncated ? '#ef4444' : '#22c55e'};">
                        ${trunc.judge_truncated ? 'Yes' : 'No'}
                    </span>
                </div>
            </div>

            <!-- Composite Scoring Details -->
            ${r.normalized_scores ? `
            <div class="hardware-card">
                <h4><i class="fas fa-calculator"></i> Composite Score Breakdown</h4>
                <div class="hardware-item">
                    <span class="hardware-label">Profile Used</span>
                    <span class="hardware-value">${r.composite_profile_used || 'N/A'}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Quality Component <span style="font-size: 0.65rem; color: var(--muted);">(quality×10)</span></span>
                    <span class="hardware-value">${r.normalized_scores.quality?.toFixed(1) || 'N/A'}<span style="font-size: 0.65rem; color: var(--muted);"> / 100</span></span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Latency Component <span style="font-size: 0.65rem; color: var(--muted);">(faster=higher)</span></span>
                    <span class="hardware-value">${r.normalized_scores.latency?.toFixed(1) || 'N/A'}<span style="font-size: 0.65rem; color: var(--muted);"> / 100</span></span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Speed Component <span style="font-size: 0.65rem; color: var(--muted);">(tok/s, cap 100)</span></span>
                    <span class="hardware-value">${r.normalized_scores.speed?.toFixed(1) || 'N/A'}<span style="font-size: 0.65rem; color: var(--muted);"> / 100</span></span>
                </div>
                <div style="margin-top: 0.75rem; padding: 0.5rem; background: rgba(99, 102, 241, 0.1); border-radius: 4px; font-size: 0.7rem; color: var(--muted);">
                    Final score = weighted sum of components (weights vary by prompt category)
                </div>
            </div>
            ` : ''}
        </div>
    `;
}

// Helper function for score class
function getScoreClass(score) {
    if (score === null || score === undefined) return '';
    if (score >= 8) return 'positive';
    if (score >= 6) return 'warning';
    return 'negative';
}

// Helper function for score color
function getScoreColor(score) {
    if (score >= 8) return '#22c55e';
    if (score >= 6) return '#eab308';
    return '#ef4444';
}

// Rejudge a pending result
async function rejudgeResult(resultId) {
    const btn = document.querySelector('.rejudge-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Judging...';
    }

    try {
        const response = await fetch(`/api/benchmark/results/${resultId}/rejudge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Rejudge failed');
        }

        const data = await response.json();

        // Refresh the inspector with updated data
        await openTestInspector(resultId);

        // Show success message
        alert(`Judging complete! Quality Score: ${data.data.quality_score != null ? data.data.quality_score.toFixed(1) : 'N/A'}`);

    } catch (error) {
        console.error('Rejudge failed:', error);
        alert(`Rejudge failed: ${error.message}`);

        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-redo"></i> Run Judging Now';
        }
    }
}

// Expose rejudge function globally
window.rejudgeResult = rejudgeResult;

// Close Test Inspector modal
function closeTestInspector() {
    document.getElementById('testInspectorModal').style.display = 'none';
    currentInspectorResult = null;
}
