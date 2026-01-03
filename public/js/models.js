// Custom Models Management Dashboard
const API_BASE = window.location.origin;

let allModels = [];
let filteredModels = [];

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    loadModels();
});

/**
 * Load all custom models
 */
async function loadModels() {
    try {
        const response = await fetch(`${API_BASE}/api/custom-models`);
        const data = await response.json();

        if (data.success) {
            allModels = data.models;
            filteredModels = [...allModels];
            populateBaseModelFilter();
            renderModels();
        } else {
            showError('Failed to load models: ' + data.error);
        }
    } catch (error) {
        console.error('Error loading models:', error);
        showError('Failed to load models');
    }
}

/**
 * Populate base model filter dropdown
 */
function populateBaseModelFilter() {
    const filterSelect = document.getElementById('filterBaseModel');
    const baseModels = [...new Set(allModels.map(m => m.baseModel))];

    // Clear existing options (except "All")
    filterSelect.innerHTML = '<option value="">All Base Models</option>';

    baseModels.forEach(baseModel => {
        const option = document.createElement('option');
        option.value = baseModel;
        option.textContent = baseModel;
        filterSelect.appendChild(option);
    });
}

/**
 * Apply filters to model list
 */
function applyFilters() {
    const statusFilter = document.getElementById('filterStatus').value;
    const baseModelFilter = document.getElementById('filterBaseModel').value;
    const searchQuery = document.getElementById('searchQuery').value.toLowerCase();

    filteredModels = allModels.filter(model => {
        const matchesStatus = !statusFilter || model.status === statusFilter;
        const matchesBaseModel = !baseModelFilter || model.baseModel === baseModelFilter;
        const matchesSearch = !searchQuery ||
            model.modelId.toLowerCase().includes(searchQuery) ||
            model.displayName.toLowerCase().includes(searchQuery) ||
            (model.description && model.description.toLowerCase().includes(searchQuery));

        return matchesStatus && matchesBaseModel && matchesSearch;
    });

    renderModels();
}

/**
 * Render models grid
 */
function renderModels() {
    const container = document.getElementById('modelsContainer');

    if (filteredModels.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-cube"></i>
                <h3>No models found</h3>
                <p>Register your first custom model to get started</p>
            </div>
        `;
        return;
    }

    const html = `
        <div class="models-grid">
            ${filteredModels.map(model => renderModelCard(model)).join('')}
        </div>
    `;

    container.innerHTML = html;
}

/**
 * Render individual model card
 */
function renderModelCard(model) {
    const stats = model.stats || {};
    const abConfig = model.abTestConfig || {};

    return `
        <div class="model-card">
            <div class="model-header">
                <div class="model-title">
                    <h3>${escapeHtml(model.displayName)}</h3>
                    <div class="model-id">${escapeHtml(model.modelId)}</div>
                </div>
                <span class="model-status status-${model.status}">
                    ${getStatusIcon(model.status)} ${model.status}
                </span>
            </div>

            <div class="model-meta">
                <div class="meta-item">
                    <span class="meta-label">Base Model</span>
                    <span class="meta-value">${escapeHtml(model.baseModel)}</span>
                </div>
                <div class="meta-item">
                    <span class="meta-label">Version</span>
                    <span class="meta-value">${escapeHtml(model.version)}</span>
                </div>
                ${model.deployedAt ? `
                <div class="meta-item">
                    <span class="meta-label">Deployed</span>
                    <span class="meta-value">${formatDate(model.deployedAt)}</span>
                </div>
                ` : ''}
                ${abConfig.enabled ? `
                <div class="meta-item">
                    <span class="meta-label">A/B Test Weight</span>
                    <span class="meta-value">${abConfig.trafficWeight}%</span>
                </div>
                ` : ''}
            </div>

            <div class="model-stats">
                <div class="stat-box">
                    <span class="stat-value">${stats.totalInferences || 0}</span>
                    <span class="stat-label">Inferences</span>
                </div>
                <div class="stat-box">
                    <span class="stat-value">${stats.avgResponseTime ? stats.avgResponseTime.toFixed(0) : 0}ms</span>
                    <span class="stat-label">Avg Response</span>
                </div>
                <div class="stat-box">
                    <span class="stat-value">${stats.avgTokensPerSecond ? stats.avgTokensPerSecond.toFixed(1) : 0}</span>
                    <span class="stat-label">Tokens/sec</span>
                </div>
                <div class="stat-box">
                    <span class="stat-value">${stats.positiveRate ? (stats.positiveRate * 100).toFixed(0) : 0}%</span>
                    <span class="stat-label">Positive Rate</span>
                </div>
            </div>

            <div class="model-actions">
                ${model.status === 'ready' || model.status === 'deployed' ? `
                    <button class="btn-action success" onclick="openDeployModal('${model.modelId}')">
                        <i class="fas fa-rocket"></i> Deploy
                    </button>
                ` : ''}
                <button class="btn-action" onclick="viewStats('${model.modelId}')">
                    <i class="fas fa-chart-line"></i> Stats
                </button>
                <button class="btn-action" onclick="viewHistory('${model.modelId}')">
                    <i class="fas fa-history"></i> History
                </button>
                ${model.status !== 'archived' ? `
                    <button class="btn-action danger" onclick="archiveModel('${model.modelId}')">
                        <i class="fas fa-archive"></i> Archive
                    </button>
                ` : ''}
            </div>
        </div>
    `;
}

/**
 * Get status icon
 */
function getStatusIcon(status) {
    const icons = {
        ready: '<i class="fas fa-check-circle"></i>',
        deployed: '<i class="fas fa-rocket"></i>',
        training: '<i class="fas fa-spinner fa-spin"></i>',
        failed: '<i class="fas fa-exclamation-circle"></i>',
        deprecated: '<i class="fas fa-ban"></i>',
        archived: '<i class="fas fa-archive"></i>'
    };
    return icons[status] || '<i class="fas fa-circle"></i>';
}

/**
 * Format date
 */
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Refresh models
 */
function refreshModels() {
    const container = document.getElementById('modelsContainer');
    container.innerHTML = `
        <div class="loading">
            <div class="spinner"></div>
            <p>Refreshing models...</p>
        </div>
    `;
    loadModels();
}

/**
 * Open register modal
 */
function openRegisterModal() {
    document.getElementById('registerModal').classList.add('active');
    document.getElementById('registerForm').reset();
}

/**
 * Close register modal
 */
function closeRegisterModal() {
    document.getElementById('registerModal').classList.remove('active');
}

/**
 * Register new model
 */
async function registerModel(event) {
    event.preventDefault();

    const modelData = {
        modelId: document.getElementById('modelId').value.trim(),
        displayName: document.getElementById('displayName').value.trim(),
        baseModel: document.getElementById('baseModel').value.trim(),
        version: document.getElementById('version').value.trim() || '1.0.0',
        description: document.getElementById('description').value.trim(),
        modelfileContent: document.getElementById('modelfileContent').value.trim(),
        tags: document.getElementById('tags').value.split(',').map(t => t.trim()).filter(t => t)
    };

    try {
        const response = await fetch(`${API_BASE}/api/custom-models`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(modelData)
        });

        const data = await response.json();

        if (data.success) {
            showSuccess('Model registered successfully!');
            closeRegisterModal();
            loadModels();
        } else {
            showError('Failed to register model: ' + data.error);
        }
    } catch (error) {
        console.error('Error registering model:', error);
        showError('Failed to register model');
    }
}

/**
 * Open deploy modal
 */
function openDeployModal(modelId) {
    document.getElementById('deployModelId').value = modelId;
    document.getElementById('deployModal').classList.add('active');
    document.getElementById('deployForm').reset();
}

/**
 * Close deploy modal
 */
function closeDeployModal() {
    document.getElementById('deployModal').classList.remove('active');
}

/**
 * Deploy model
 */
async function deployModel(event) {
    event.preventDefault();

    const modelId = document.getElementById('deployModelId').value;
    const ollamaHost = document.getElementById('ollamaHost').value.trim();

    try {
        const response = await fetch(`${API_BASE}/api/custom-models/${modelId}/deploy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ollamaHost: ollamaHost || undefined })
        });

        const data = await response.json();

        if (data.success) {
            showSuccess('Model deployed successfully!');
            closeDeployModal();
            loadModels();
        } else {
            showError('Failed to deploy model: ' + data.error);
        }
    } catch (error) {
        console.error('Error deploying model:', error);
        showError('Failed to deploy model');
    }
}

/**
 * View model stats
 */
async function viewStats(modelId) {
    document.getElementById('statsModal').classList.add('active');
    const statsContent = document.getElementById('statsContent');
    statsContent.innerHTML = `
        <div class="loading">
            <div class="spinner"></div>
            <p>Loading statistics...</p>
        </div>
    `;

    try {
        const response = await fetch(`${API_BASE}/api/custom-models/${modelId}/stats`);
        const data = await response.json();

        if (data.success) {
            renderStats(data.stats);
        } else {
            statsContent.innerHTML = `<p style="color: #ef4444;">Failed to load statistics</p>`;
        }
    } catch (error) {
        console.error('Error loading stats:', error);
        statsContent.innerHTML = `<p style="color: #ef4444;">Failed to load statistics</p>`;
    }
}

/**
 * Render stats content
 */
function renderStats(stats) {
    const statsContent = document.getElementById('statsContent');
    const modelStats = stats.stats || {};

    statsContent.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; margin-bottom: 2rem;">
            <div class="stat-box" style="background: rgba(15, 23, 42, 0.5); padding: 1.5rem; border-radius: 8px;">
                <span class="stat-value" style="font-size: 2rem;">${modelStats.totalInferences || 0}</span>
                <span class="stat-label">Total Inferences</span>
            </div>
            <div class="stat-box" style="background: rgba(15, 23, 42, 0.5); padding: 1.5rem; border-radius: 8px;">
                <span class="stat-value" style="font-size: 2rem;">${modelStats.avgResponseTime ? modelStats.avgResponseTime.toFixed(0) : 0}ms</span>
                <span class="stat-label">Avg Response Time</span>
            </div>
            <div class="stat-box" style="background: rgba(15, 23, 42, 0.5); padding: 1.5rem; border-radius: 8px;">
                <span class="stat-value" style="font-size: 2rem;">${modelStats.avgTokensPerSecond ? modelStats.avgTokensPerSecond.toFixed(1) : 0}</span>
                <span class="stat-label">Tokens per Second</span>
            </div>
            <div class="stat-box" style="background: rgba(15, 23, 42, 0.5); padding: 1.5rem; border-radius: 8px;">
                <span class="stat-value" style="font-size: 2rem;">${modelStats.positiveRate ? (modelStats.positiveRate * 100).toFixed(0) : 0}%</span>
                <span class="stat-label">Positive Rate</span>
            </div>
        </div>

        <div style="padding: 1rem; background: rgba(15, 23, 42, 0.3); border-radius: 8px;">
            <h3 style="margin: 0 0 1rem 0; color: #94a3b8;">Model Information</h3>
            <div style="display: grid; gap: 0.75rem; font-size: 0.875rem;">
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: #64748b;">Model ID:</span>
                    <span style="color: #f1f5f9; font-family: 'Courier New', monospace;">${escapeHtml(stats.modelId)}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: #64748b;">Display Name:</span>
                    <span style="color: #f1f5f9;">${escapeHtml(stats.displayName)}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: #64748b;">Version:</span>
                    <span style="color: #f1f5f9;">${escapeHtml(stats.version)}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: #64748b;">Status:</span>
                    <span class="model-status status-${stats.status}">${getStatusIcon(stats.status)} ${stats.status}</span>
                </div>
                ${stats.abTestConfig && stats.abTestConfig.enabled ? `
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: #64748b;">A/B Test Weight:</span>
                    <span style="color: #f1f5f9;">${stats.abTestConfig.trafficWeight}%</span>
                </div>
                ` : ''}
                ${modelStats.lastInferenceAt ? `
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: #64748b;">Last Inference:</span>
                    <span style="color: #f1f5f9;">${formatDate(modelStats.lastInferenceAt)}</span>
                </div>
                ` : ''}
            </div>
        </div>
    `;
}

/**
 * Close stats modal
 */
function closeStatsModal() {
    document.getElementById('statsModal').classList.remove('active');
}

/**
 * View model history
 */
async function viewHistory(modelId) {
    try {
        const response = await fetch(`${API_BASE}/api/custom-models/${modelId}/history`);
        const data = await response.json();

        if (data.success) {
            if (data.history.length === 0) {
                showError('No version history available');
                return;
            }

            // Show history in console for now (could be expanded to modal)
            console.log('Version History:', data.history);
            showSuccess(`Found ${data.history.length} version(s) - check console for details`);
        } else {
            showError('Failed to load history: ' + data.error);
        }
    } catch (error) {
        console.error('Error loading history:', error);
        showError('Failed to load history');
    }
}

/**
 * Archive model
 */
async function archiveModel(modelId) {
    if (!confirm('Are you sure you want to archive this model? It will be hidden from the active list.')) {
        return;
    }

    const reason = prompt('Reason for archiving (optional):') || 'User requested';

    try {
        const response = await fetch(`${API_BASE}/api/custom-models/${modelId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason })
        });

        const data = await response.json();

        if (data.success) {
            showSuccess('Model archived successfully');
            loadModels();
        } else {
            showError('Failed to archive model: ' + data.error);
        }
    } catch (error) {
        console.error('Error archiving model:', error);
        showError('Failed to archive model');
    }
}

/**
 * Show success toast
 */
function showSuccess(message) {
    showToast(message, 'success');
}

/**
 * Show error toast
 */
function showError(message) {
    showToast(message, 'error');
}

/**
 * Show toast notification
 */
function showToast(message, type = 'success') {
    // Remove existing toasts
    document.querySelectorAll('.toast').forEach(t => t.remove());

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <i class="fas fa-${type === 'success' ? 'check-circle' : 'exclamation-circle'}"></i>
        ${message}
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s reverse';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Export for global access
window.openRegisterModal = openRegisterModal;
window.closeRegisterModal = closeRegisterModal;
window.registerModel = registerModel;
window.openDeployModal = openDeployModal;
window.closeDeployModal = closeDeployModal;
window.deployModel = deployModel;
window.viewStats = viewStats;
window.closeStatsModal = closeStatsModal;
window.viewHistory = viewHistory;
window.archiveModel = archiveModel;
window.refreshModels = refreshModels;
window.applyFilters = applyFilters;
