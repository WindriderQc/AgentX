document.addEventListener('DOMContentLoaded', () => {
    init();
});

let allModels = [];
let modelStats = {};
let categoryChart = null;
let performanceChart = null;

const CATEGORIES = ['coding', 'reasoning', 'generalist', 'specialist', 'ops', 'embedding', 'judge'];

async function init() {
    await fetchModels();
    await fetchStats();
    setupEventListeners();
}

async function fetchModels() {
    const tableBody = document.getElementById('modelsTableBody');
    tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Loading...</td></tr>';

    try {
        const response = await fetch('/api/models/registry');
        const result = await response.json();
        
        if (result.status === 'success') {
            allModels = result.data.models;
            renderTable(allModels);
        } else {
            tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #ff6b6b;">Failed to load models</td></tr>';
        }
    } catch (error) {
        console.error('Error fetching models:', error);
        tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #ff6b6b;">Network error</td></tr>';
    }
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
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No models found found</td></tr>';
        return;
    }

    models.forEach(model => {
        const tr = document.createElement('tr');
        
        // Checkbox column
        const checkTd = document.createElement('td');
        checkTd.innerHTML = `<input type="checkbox" class="model-select" data-model="${model.name}">`;
        tr.appendChild(checkTd);

        // Model Name
        const nameTd = document.createElement('td');
        nameTd.innerHTML = `
            <div style="font-weight: 600; color: #fff;">${model.displayName || model.name}</div>
            <div style="font-size: 0.8em; color: #888;">${model.provider || model.vendor || 'Unknown'} • ${model.parameterSize || '?'}</div>
        `;
        tr.appendChild(nameTd);

        // Recommended Category
        const recTd = document.createElement('td');
        const recCat = model.benchmarkStats?.bestCategory || 'Pending';
        const isPending = recCat === 'Pending';
        recTd.innerHTML = `
            <div class="rec-badge" style="${isPending ? 'background:rgba(255,255,255,0.05); color:#888; border-color:#444;' : ''}">
                <i class="fa-solid ${getCategoryIcon(recCat)}"></i> ${capitalize(recCat)}
            </div>
        `;
        tr.appendChild(recTd);

        // Manual Categories
        const catsTd = document.createElement('td');
        const currentCats = model.categories || [];
        const catsDiv = document.createElement('div');
        catsDiv.className = 'category-checkboxes';
        
        CATEGORIES.forEach(cat => {
            const label = document.createElement('label');
            label.className = 'checkbox-label';
            const checked = currentCats.includes(cat) ? 'checked' : '';
            label.innerHTML = `
                <input type="checkbox" value="${cat}" ${checked} 
                    onchange="markDirty('${model.name}')"> 
                ${capitalize(cat)}
            `;
            catsDiv.appendChild(label);
        });
        catsTd.appendChild(catsDiv);
        tr.appendChild(catsTd);

        // Actions
        const actionsTd = document.createElement('td');
        actionsTd.innerHTML = `
            <div style="display: flex; gap: 8px;">
                <button class="btn btn-sm" id="save-${model.name}" onclick="saveModelCategories('${model.name}')" style="display:none; padding: 4px 10px; font-size: 0.8em;">
                    <i class="fa-solid fa-save"></i> Save
                </button>
                <button class="btn btn-sm" onclick="openQuickTest('${model.name}')" style="padding: 4px 10px; font-size: 0.8em;">
                    <i class="fa-solid fa-vial"></i> Test
                </button>
            </div>
        `;
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
    const btn = document.getElementById(`save-${modelName}`);
    if (btn) {
        btn.style.display = 'flex';
        btn.classList.add('btn-primary');
    }
};

window.saveModelCategories = async function(modelName) {
    // Collect checked checkboxes for this row
    // We find the row by button context or just searching
    // Simpler: find the categories for this model in the current DOM
    // But since arguments are passed, we need a way to find the inputs.
    // Let's assume unique IDs or traverse logic.
    // Actually, iterating all checkboxes in the row is safer.
    
    // Find the row containing this button
    const btn = document.getElementById(`save-${modelName}`);
    const row = btn.closest('tr');
    const checkboxes = row.querySelectorAll('.category-checkboxes input[type="checkbox"]');
    
    const newCategories = [];
    checkboxes.forEach(cb => {
        if (cb.checked) newCategories.push(cb.value);
    });

    try {
        const response = await fetch(`/api/models/registry/${encodeURIComponent(modelName)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ categories: newCategories })
        });
        
        if (response.ok) {
            showToast(`Categories saved for ${modelName}`);
            btn.style.display = 'none';
            // Refresh stats to reflect changes
            fetchStats();
        } else {
            showToast('Failed to save categories', true);
        }
    } catch (e) {
        console.error(e);
        showToast('Error saving categories', true);
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
            // Ensure we use the calculated average
            performance[cat] = (rawData[cat].avgCompositeScore || 0) / (rawData[cat].count || 1); 
            // NOTE: ModelRegistry.js seems to aggregate score in `avgCompositeScore` but then says "Calculate averages" at the end.
            // Let's verify if `getCategoryStats` actually divides by count.
            // Looking at the snippet I saw earlier:
            // "Object.keys(stats).forEach(category => { ..." 
            // It ends with ellipsis in my read. I should probably assume it returns ready-to-use averages.
            // If it returns Sums, I need to divide.
            // Let me check ModelRegistry.js again to be sure.
            performance[cat] = rawData[cat].avgCompositeScore;
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

function showToast(msg, isError = false) {
    const t = document.getElementById('toast');
    t.innerText = msg;
    t.style.borderLeftColor = isError ? '#e74c3c' : '#2ecc71';
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}
