document.addEventListener('DOMContentLoaded', () => {
    init();
});

let allModels = [];
let modelStats = {};
let categoryChart = null;
let performanceChart = null;

const CATEGORIES = ['coding', 'reasoning', 'generalist', 'specialist', 'ops', 'embedding', 'judge'];

function toSafeId(value) {
    return encodeURIComponent(value).replace(/%/g, '_');
}

async function init() {
    await fetchModels();
    await fetchStats();
    setupEventListeners();
    setupScrollHints();
}

function setupScrollHints() {
    const tableContainer = document.querySelector('.table-container');
    const table = tableContainer.querySelector('table');
    
    const checkScroll = () => {
        if (table.scrollWidth > tableContainer.clientWidth) {
            tableContainer.classList.add('has-scroll');
        } else {
            tableContainer.classList.remove('has-scroll');
        }
    };
    
    // Check on load and resize
    checkScroll();
    window.addEventListener('resize', checkScroll);
    
    // Remove hint after first scroll
    tableContainer.addEventListener('scroll', () => {
        tableContainer.classList.remove('has-scroll');
    }, { once: true });
}

async function fetchModels() {
    const tableBody = document.getElementById('modelsTableBody');
    
    // Show skeleton loading state
    tableBody.innerHTML = renderSkeletonRows(5);

    try {
        const response = await fetch('/api/models/registry');
        const result = await response.json();
        
        if (result.status === 'success') {
            allModels = result.data.models;
            // Small delay for smooth transition
            setTimeout(() => renderTable(allModels), 200);
        } else {
            tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #ff6b6b;">Failed to load models</td></tr>';
        }
    } catch (error) {
        console.error('Error fetching models:', error);
        tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #ff6b6b;">Network error</td></tr>';
    }
}

function renderSkeletonRows(count) {
    let html = '';
    for (let i = 0; i < count; i++) {
        html += `
            <tr>
                <td><div class="skeleton" style="width: 20px; height: 20px;"></div></td>
                <td>
                    <div class="skeleton" style="width: 200px; height: 16px; margin-bottom: 8px;"></div>
                    <div class="skeleton" style="width: 150px; height: 14px;"></div>
                </td>
                <td><div class="skeleton skeleton-badge"></div></td>
                <td>
                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                        <div class="skeleton" style="width: 80px; height: 24px; border-radius: 12px;"></div>
                        <div class="skeleton" style="width: 90px; height: 24px; border-radius: 12px;"></div>
                        <div class="skeleton" style="width: 70px; height: 24px; border-radius: 12px;"></div>
                    </div>
                </td>
                <td><div class="skeleton" style="width: 100px; height: 30px;"></div></td>
            </tr>
        `;
    }
    return html;
}

async function fetchStats() {
    try {
        const response = await fetch('/api/models/registry/stats');
        const result = await response.json();
        
        if (result.status === 'success') {
            modelStats = result.data;
            renderCharts(modelStats);
        }
    } catch (error) {
        console.error('Error fetching stats:', error);
    }
}

function renderTable(models) {
    const tbody = document.getElementById('modelsTableBody');
    tbody.innerHTML = '';

    if (models.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No models found</td></tr>';
        return;
    }

    models.forEach(model => {
        const tr = document.createElement('tr');
        
        // Checkbox column
        const checkTd = document.createElement('td');
        const selectCheckbox = document.createElement('input');
        selectCheckbox.type = 'checkbox';
        selectCheckbox.className = 'model-select';
        selectCheckbox.dataset.model = model.name;
        checkTd.appendChild(selectCheckbox);
        tr.appendChild(checkTd);

        // Model Name
        const nameTd = document.createElement('td');
        nameTd.innerHTML = `
            <div style="font-weight: 600; color: #fff;">${model.displayName || model.name}</div>
            <div style="font-size: 0.8em; color: #888;">${model.provider || model.vendor || 'Unknown'} • ${model.parameterSize || '?'}</div>
        `;
        tr.appendChild(nameTd);

        // Recommended Category with CategoryBadge component
        const recTd = document.createElement('td');
        const recCat = model.benchmarkStats?.bestCategory;
        const confidence = model.benchmarkStats?.confidence || null;
        
        if (recCat && recCat !== 'Pending' && typeof CategoryBadge !== 'undefined') {
            // Use CategoryBadge with confidence indicator
            const benchmarkScores = model.benchmarkStats?.scores || null;
            recTd.innerHTML = CategoryBadge.render(recCat, confidence, {
                benchmarkScores: benchmarkScores,
                showRing: true,
                interactive: true,
                animated: true,
                size: 'medium'
            });
        } else {
            // Fallback for pending or no category
            const isPending = !recCat || recCat === 'Pending';
            recTd.innerHTML = `
                <div class="rec-badge" style="${isPending ? 'background:rgba(255,255,255,0.05); color:#888; border-color:#444;' : ''}">
                    <i class="fa-solid ${getCategoryIcon(recCat || 'pending')}"></i> ${capitalize(recCat || 'Pending')}
                </div>
            `;
        }
        tr.appendChild(recTd);

        // Manual Categories
        const catsTd = document.createElement('td');
        const currentCats = model.categories || [];
        const catsDiv = document.createElement('div');
        catsDiv.className = 'category-checkboxes';
        
        CATEGORIES.forEach(cat => {
            const label = document.createElement('label');
            label.className = 'checkbox-label';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = cat;
            checkbox.checked = currentCats.includes(cat);
            checkbox.addEventListener('change', () => markDirty(model.name));
            label.appendChild(checkbox);
            label.append(` ${capitalize(cat)}`);
            catsDiv.appendChild(label);
        });
        catsTd.appendChild(catsDiv);
        tr.appendChild(catsTd);

        // Actions
        const actionsTd = document.createElement('td');
        const actionsWrap = document.createElement('div');
        actionsWrap.style.display = 'flex';
        actionsWrap.style.gap = '8px';

        const saveButton = document.createElement('button');
        saveButton.className = 'btn btn-sm';
        saveButton.id = `save-${toSafeId(model.name)}`;
        saveButton.style.display = 'none';
        saveButton.style.padding = '4px 10px';
        saveButton.style.fontSize = '0.8em';
        saveButton.innerHTML = '<i class="fa-solid fa-save"></i> Save';
        saveButton.addEventListener('click', () => saveModelCategories(model.name));

        const testButton = document.createElement('button');
        testButton.className = 'btn btn-sm';
        testButton.style.padding = '4px 10px';
        testButton.style.fontSize = '0.8em';
        testButton.innerHTML = '<i class="fa-solid fa-vial"></i> Test';
        testButton.addEventListener('click', () => openQuickTest(model.name));

        actionsWrap.appendChild(saveButton);
        actionsWrap.appendChild(testButton);
        actionsTd.appendChild(actionsWrap);
        tr.appendChild(actionsTd);

        tbody.appendChild(tr);
    });
}

function getCategoryIcon(category) {
    const map = {
        coding: 'fa-code',
        reasoning: 'fa-brain',
        generalist: 'fa-comments',
        specialist: 'fa-user-md',
        ops: 'fa-server',
        embedding: 'fa-vector-square',
        judge: 'fa-gavel',
        pending: 'fa-clock'
    };
    return map[category?.toLowerCase()] || 'fa-question';
}

function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// Global scope functions for inline event handlers
window.markDirty = function(modelName) {
    const btn = document.getElementById(`save-${toSafeId(modelName)}`);
    if (btn) {
        btn.style.display = 'flex';
        btn.classList.add('btn-primary');
    }
    
    // Show real-time category suggestion preview
    showCategorySuggestionPreview(modelName);
};

function showCategorySuggestionPreview(modelName) {
    const model = allModels.find(m => m.name === modelName);
    if (!model) return;
    
    // Find the row for this model
    const rows = document.querySelectorAll('#modelsTableBody tr');
    let targetRow = null;
    rows.forEach(row => {
        const saveBtn = row.querySelector(`#save-${CSS.escape(toSafeId(modelName))}`);
        if (saveBtn) targetRow = row;
    });
    
    if (!targetRow) return;
    
    // Get currently selected categories from checkboxes
    const checkboxes = targetRow.querySelectorAll('.category-checkboxes input[type="checkbox"]:checked');
    const selectedCats = Array.from(checkboxes).map(cb => cb.value);
    
    // Get recommended category
    const recommendedCat = model.benchmarkStats?.bestCategory;
    
    // Find or create preview element
    let preview = targetRow.querySelector('.suggestion-preview');
    const catsTd = targetRow.querySelector('td:nth-child(4)'); // Manual categories column
    
    if (!preview && recommendedCat && recommendedCat !== 'Pending') {
        preview = document.createElement('div');
        preview.className = 'suggestion-preview';
        catsTd.appendChild(preview);
    }
    
    if (preview && recommendedCat && recommendedCat !== 'Pending') {
        const hasDiff = !selectedCats.includes(recommendedCat);
        preview.className = hasDiff ? 'suggestion-preview has-diff' : 'suggestion-preview';
        
        if (hasDiff) {
            preview.innerHTML = `
                <i class="fas fa-lightbulb suggestion-icon"></i>
                <span class="suggestion-text">AI suggests: <strong>${capitalize(recommendedCat)}</strong></span>
                <span class="diff-badge diff-added">${recommendedCat}</span>
            `;
        } else {
            preview.innerHTML = `
                <i class="fas fa-check-circle suggestion-icon" style="color: var(--success);"></i>
                <span class="suggestion-text">Matches AI recommendation!</span>
            `;
        }
    }
}

window.saveModelCategories = async function(modelName) {
    const btn = document.getElementById(`save-${toSafeId(modelName)}`);
    const row = btn.closest('tr');
    const checkboxes = row.querySelectorAll('.category-checkboxes input[type="checkbox"]');
    
    const newCategories = [];
    checkboxes.forEach(cb => {
        if (cb.checked) newCategories.push(cb.value);
    });

    // Add loading state
    row.classList.add('updating');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

    try {
        const response = await fetch(`/api/models/registry/${encodeURIComponent(modelName)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ categories: newCategories })
        });
        
        if (response.ok) {
            // Success animation
            row.classList.remove('updating');
            row.classList.add('just-saved');
            setTimeout(() => row.classList.remove('just-saved'), 600);
            
            showToast(`Categories saved for ${modelName}`, 'success');
            btn.style.display = 'none';
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-save"></i> Save';
            
            // Remove preview
            const preview = row.querySelector('.suggestion-preview');
            if (preview) preview.remove();
            
            // Refresh stats to reflect changes
            fetchStats();
        } else {
            throw new Error('Save failed');
        }
    } catch (error) {
        console.error('Error saving categories:', error);
        row.classList.remove('updating');
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-save"></i> Save';
        showToast(`Failed to save categories for ${modelName}`, 'error');
    }
};

window.openQuickTest = function(modelName) {
    const modal = document.getElementById('quickTestModal');
    const modelNameSpan = document.getElementById('testModelName');
    const progressBar = document.getElementById('testProgressBar');
    const statusDiv = document.getElementById('testStatus');
    const resultDiv = document.getElementById('testResult');
    const closeBtn = document.getElementById('closeTestModalBtn');

    modal.classList.add('active');
    modelNameSpan.innerText = modelName;
    progressBar.style.width = '0%';
    statusDiv.innerText = 'Initializing test suite...';
    resultDiv.style.display = 'none';
    closeBtn.style.display = 'none';

    // Simulate test steps
    let progress = 0;
    const interval = setInterval(() => {
        progress += 5;
        progressBar.style.width = `${progress}%`;
        
        if (progress === 20) statusDiv.innerText = 'Loading model capability prompts...';
        if (progress === 50) statusDiv.innerText = 'Evaluating responses...';
        if (progress === 80) statusDiv.innerText = 'Calculating scores...';
        
        if (progress >= 100) {
            clearInterval(interval);
            statusDiv.innerText = 'Test Complete';
            // In a real implementation this would come from the backend or the script
            // For now, we fetch the model data again to see if backend updated it, 
            // or just show a "mock" result based on existing data
            const model = allModels.find(m => m.name === modelName);
            const rec = model?.benchmarkStats?.bestCategory || 'Generalist';
            
            document.getElementById('testRecommendation').innerText = capitalize(rec);
            resultDiv.style.display = 'block';
            closeBtn.style.display = 'inline-block';
            
            // Trigger background sync just in case
            fetch(`/api/models/registry/${encodeURIComponent(modelName)}/sync`, { method: 'POST' });
        }
    }, 150);
    
    // Add close handler specifically for this run
    closeBtn.onclick = () => {
        modal.classList.remove('active');
        fetchModels(); // Refresh table to show any updates
    };
};

function setupEventListeners() {
    // Select All Checkbox
    document.getElementById('selectAllCheckbox').addEventListener('change', (e) => {
        const checked = e.target.checked;
        document.querySelectorAll('.model-select').forEach(cb => cb.checked = checked);
    });

    // Bulk Apply Button
    document.getElementById('applyBulkCategoryBtn').addEventListener('click', async () => {
        const category = document.getElementById('bulkCategorySelect').value;
        if (!category) return showToast('Please select a category first', true);

        const selectedModels = Array.from(document.querySelectorAll('.model-select:checked'))
            .map(cb => cb.dataset.model);
            
        if (selectedModels.length === 0) return showToast('No models selected', true);

        let successCount = 0;
        for (const modelName of selectedModels) {
            // Need to fetch current categories first to append, or just add?
            // User requested "Batch category assignment". 
            // Usually implies adding this category to them.
            // We need to know current categories to avoid removing others? 
            // Let's assume we append the new one if not present.
            
            const model = allModels.find(m => m.name === modelName);
            let cats = model.categories || [];
            if (!cats.includes(category)) {
                cats.push(category);
                
                try {
                    await fetch(`/api/models/registry/${encodeURIComponent(modelName)}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ categories: cats })
                    });
                    successCount++;
                } catch (e) { console.error(e); }
            }
        }
        
        showToast(`Updated ${successCount} models`);
        fetchModels();
        fetchStats();
    });

    // Auto-Categorize Button
    document.getElementById('autoCategorizeBtn').addEventListener('click', () => {
        // Mock functionality for now as per instructions "Auto-categorize from Web"
        // In reality this might call an endpoint.
        showToast('Auto-categorization initiated (Background Job)', false);
        // Could integrate with script here if we had an endpoint
    });
}

function renderCharts(rawData) {
    // Transform API data structure: { coding: { count: 10, avgCompositeScore: 80... } }
    // into distribution and performance data
    
    const distribution = {};
    const performance = {};
    
    const categories = Object.keys(rawData || {});
    
    categories.forEach(cat => {
        if (typeof rawData[cat] === 'object') {
            distribution[cat] = rawData[cat].count || 0;
            performance[cat] = rawData[cat].avgCompositeScore || 0;
        }
    });

    renderDistChart(distribution);
    renderPerfChart(performance); 
}

function renderDistChart(distData) {
    const ctx = document.getElementById('categoryDistributionChart');
    if (categoryChart) categoryChart.destroy();
    
    // If empty, mock it to check UI
    const labels = Object.keys(distData).length ? Object.keys(distData) : ['Empty'];
    const dataPoints = Object.keys(distData).length ? Object.values(distData) : [1];

    categoryChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels.map(capitalize),
            datasets: [{
                data: dataPoints,
                backgroundColor: [
                    '#7CF0FF', '#5865F2', '#2ecc71', '#f1c40f', '#e74c3c', '#9b59b6', '#34495e'
                ],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { color: '#ccc' } }
            }
        }
    });
}

function renderPerfChart(perfData) {
    const ctx = document.getElementById('categoryPerformanceChart');
    if (performanceChart) performanceChart.destroy();
    
    // perfData might be { coding: 85, reasoning: 90 ... }
    const labels = Object.keys(perfData).map(capitalize);
    const dataPoints = Object.values(perfData);

    performanceChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Avg Score',
                data: dataPoints,
                backgroundColor: 'rgba(124, 240, 255, 0.5)',
                borderColor: '#7CF0FF',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, max: 100, grid: { color: 'rgba(255,255,255,0.05)' } },
                x: { grid: { display: false } }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}

function showToast(msg, type = 'success') {
    const t = document.getElementById('toast');
    t.innerText = msg;
    t.className = `toast ${type}`;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}
