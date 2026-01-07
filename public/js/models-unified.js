// Unified Models Catalog Dashboard
// Aggregates models from Ollama hosts, n8n webhooks, custom models, and registry
const API_BASE = window.location.origin;

let allModels = [];
let filteredModels = [];
let modelSources = {};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    loadModels();
});

/**
 * Load all models from unified API
 */
async function loadModels() {
    try {
        const response = await fetch(`${API_BASE}/api/models/all`);
        const data = await response.json();

        if (data.status === 'success') {
            allModels = data.data.models || [];
            modelSources = data.data.sources || {};
            filteredModels = [...allModels];

            updateSourcesSummary();
            populateCategoryFilter();
            renderModels();
        } else {
            showError('Failed to load models: ' + data.message);
        }
    } catch (error) {
        console.error('Error loading models:', error);
        showError('Failed to load models from server');
    }
}

/**
 * Update sources summary panel
 */
function updateSourcesSummary() {
    document.getElementById('ollamaCount').textContent = modelSources.ollama?.count || 0;
    document.getElementById('n8nCount').textContent = modelSources.n8n?.count || 0;
    document.getElementById('customCount').textContent = modelSources.custom?.count || 0;
    document.getElementById('totalCount').textContent = allModels.length;
}

/**
 * Populate category filter dropdown
 */
function populateCategoryFilter() {
    const filterSelect = document.getElementById('filterCategory');
    const categories = new Set();

    allModels.forEach(model => {
        if (model.categories && Array.isArray(model.categories)) {
            model.categories.forEach(cat => categories.add(cat));
        }
    });

    // Clear and rebuild
    filterSelect.innerHTML = '<option value="">All Categories</option>';

    [...categories].sort().forEach(category => {
        const option = document.createElement('option');
        option.value = category;
        option.textContent = category;
        filterSelect.appendChild(option);
    });
}

/**
 * Apply filters to model list
 */
function applyFilters() {
    const providerFilter = document.getElementById('filterProvider').value;
    const statusFilter = document.getElementById('filterStatus').value;
    const categoryFilter = document.getElementById('filterCategory').value;
    const searchQuery = document.getElementById('searchQuery').value.toLowerCase();

    filteredModels = allModels.filter(model => {
        const matchesProvider = !providerFilter || model.provider === providerFilter;
        const matchesStatus = !statusFilter || model.deployment?.status === statusFilter;
        const matchesCategory = !categoryFilter || (model.categories && model.categories.includes(categoryFilter));
        const matchesSearch = !searchQuery ||
            model.name.toLowerCase().includes(searchQuery) ||
            model.displayName.toLowerCase().includes(searchQuery) ||
            (model.source?.metadata && JSON.stringify(model.source.metadata).toLowerCase().includes(searchQuery));

        return matchesProvider && matchesStatus && matchesCategory && matchesSearch;
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
                <p>Try adjusting your filters or add models from various sources</p>
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
 * Render individual model card (provider-specific layouts)
 */
function renderModelCard(model) {
    const provider = model.provider;
    const status = model.deployment?.status || 'unknown';
    const capabilities = model.capabilities || {};
    const benchmarkStats = model.benchmarkStats || {};

    // Provider icon
    const providerIcon = {
        'ollama': 'fa-server',
        'n8n-webhook': 'fa-cloud',
        'custom': 'fa-cube'
    }[provider] || 'fa-question';

    return `
        <div class="model-card">
            <div class="model-header">
                <div class="model-title">
                    <h3>
                        <i class="fas ${providerIcon}" style="color: #64748b; margin-right: 0.5rem;"></i>
                        ${escapeHtml(model.displayName)}
                    </h3>
                    <div class="model-id">${escapeHtml(model.name)}</div>
                </div>
                <span class="model-status status-${status}">
                    ${getStatusIcon(status)} ${status}
                </span>
            </div>

            <div class="model-meta">
                <div class="meta-item">
                    <span class="meta-label">Provider</span>
                    <span class="meta-value">${escapeHtml(provider)}</span>
                </div>
                ${provider === 'ollama' ? `
                <div class="meta-item">
                    <span class="meta-label">Host</span>
                    <span class="meta-value">${escapeHtml(model.deployment?.ollamaHost || 'N/A')}</span>
                </div>
                <div class="meta-item">
                    <span class="meta-label">Size</span>
                    <span class="meta-value">${formatBytes(model.source?.metadata?.size || 0)}</span>
                </div>
                ` : ''}
                ${provider === 'n8n-webhook' ? `
                <div class="meta-item">
                    <span class="meta-label">Webhook Provider</span>
                    <span class="meta-value">${escapeHtml(model.source?.metadata?.n8nProvider || 'N/A')}</span>
                </div>
                <div class="meta-item">
                    <span class="meta-label">Last Tested</span>
                    <span class="meta-value">${model.source?.metadata?.lastTested ? formatDate(model.source.metadata.lastTested) : 'Never'}</span>
                </div>
                ` : ''}
                ${provider === 'custom' ? `
                <div class="meta-item">
                    <span class="meta-label">Base Model</span>
                    <span class="meta-value">${escapeHtml(model.source?.metadata?.baseModel || 'N/A')}</span>
                </div>
                ` : ''}
            </div>

            ${model.categories && model.categories.length > 0 ? `
            <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem;">
                ${model.categories.map(cat => `
                    <span style="font-size: 0.75rem; padding: 0.25rem 0.5rem; background: rgba(59, 130, 246, 0.1); color: #3b82f6; border-radius: 4px;">
                        ${escapeHtml(cat)}
                    </span>
                `).join('')}
            </div>
            ` : ''}

            <div class="model-stats">
                <div class="stat-box">
                    <span class="stat-value">${capabilities.maxContext || 0}</span>
                    <span class="stat-label">Max Context</span>
                </div>
                <div class="stat-box">
                    <span class="stat-value">${capabilities.supportsStreaming ? 'Yes' : 'No'}</span>
                    <span class="stat-label">Streaming</span>
                </div>
                <div class="stat-box">
                    <span class="stat-value">${capabilities.supportsThinking ? 'Yes' : 'No'}</span>
                    <span class="stat-label">Thinking</span>
                </div>
                ${benchmarkStats?.avgCompositeScore ? `
                <div class="stat-box">
                    <span class="stat-value">${benchmarkStats.avgCompositeScore.toFixed(1)}</span>
                    <span class="stat-label">Benchmark</span>
                </div>
                ` : `
                <div class="stat-box">
                    <span class="stat-value">${capabilities.avgLatencyMs ? capabilities.avgLatencyMs.toFixed(0) : 'N/A'}</span>
                    <span class="stat-label">Latency (ms)</span>
                </div>
                `}
            </div>

            <div class="model-actions">
                ${renderModelActions(model)}
            </div>
        </div>
    `;
}

/**
 * Render model-specific actions
 */
function renderModelActions(model) {
    const provider = model.provider;
    const modelId = encodeURIComponent(model.id);

    if (provider === 'ollama') {
        return `
            <button class="btn-action" onclick="viewModelDetail('${modelId}')">
                <i class="fas fa-info-circle"></i> Details
            </button>
        `;
    } else if (provider === 'n8n-webhook') {
        const n8nId = model.id.replace('n8n:', '');
        return `
            <button class="btn-action success" onclick="testN8nWebhook('${n8nId}')">
                <i class="fas fa-vial"></i> Test
            </button>
            <button class="btn-action" onclick="editN8nWebhook('${n8nId}')">
                <i class="fas fa-edit"></i> Edit
            </button>
            <button class="btn-action danger" onclick="deleteN8nWebhook('${n8nId}')">
                <i class="fas fa-trash"></i> Delete
            </button>
        `;
    } else if (provider === 'custom') {
        const customId = model.id.replace('custom:', '');
        return `
            <button class="btn-action success" onclick="deployCustomModel('${customId}')">
                <i class="fas fa-rocket"></i> Deploy
            </button>
            <button class="btn-action" onclick="viewCustomModelStats('${customId}')">
                <i class="fas fa-chart-line"></i> Stats
            </button>
        `;
    }

    return '<span style="color: #64748b; font-size: 0.875rem;">No actions available</span>';
}

/**
 * Get status icon
 */
function getStatusIcon(status) {
    const icons = {
        available: '<i class="fas fa-check-circle"></i>',
        deployed: '<i class="fas fa-rocket"></i>',
        inactive: '<i class="fas fa-times-circle"></i>',
        ready: '<i class="fas fa-check-circle"></i>',
        training: '<i class="fas fa-spinner fa-spin"></i>',
        failed: '<i class="fas fa-exclamation-circle"></i>',
        unknown: '<i class="fas fa-question-circle"></i>'
    };
    return icons[status] || icons.unknown;
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
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
    if (!text) return '';
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
            <p>Refreshing models from all sources...</p>
        </div>
    `;
    loadModels();
}

// ========================================
// n8n Webhook LLM Management
// ========================================

/**
 * Open n8n webhook registration modal
 */
function openN8nModal() {
    document.getElementById('n8nModal').classList.add('active');
    document.getElementById('n8nForm').reset();

    // Set default body template
    document.getElementById('n8nBodyTemplate').value = '{"prompt": "{{prompt}}", "max_tokens": {{maxTokens}}}';
}

/**
 * Close n8n webhook modal
 */
function closeN8nModal() {
    document.getElementById('n8nModal').classList.remove('active');
}

/**
 * Test n8n connection before registration
 */
async function testN8nConnection() {
    const webhookUrl = document.getElementById('n8nWebhookUrl').value.trim();
    const bodyTemplate = document.getElementById('n8nBodyTemplate').value.trim();
    const responsePath = document.getElementById('n8nResponsePath').value.trim();

    if (!webhookUrl || !bodyTemplate || !responsePath) {
        showError('Please fill in webhook URL, body template, and response path first');
        return;
    }

    try {
        showSuccess('Testing connection... please wait');

        // Build test request
        const body = bodyTemplate
            .replace(/\{\{prompt\}\}/g, 'Test: What is 2+2?')
            .replace(/\{\{maxTokens\}\}/g, '50')
            .replace(/\{\{temperature\}\}/g, '0.7');

        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body
        });

        if (!response.ok) {
            throw new Error(`Webhook returned ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log('Test response:', data);

        showSuccess('Connection successful! Check console for response');
    } catch (error) {
        console.error('Connection test failed:', error);
        showError('Connection test failed: ' + error.message);
    }
}

/**
 * Register new n8n webhook LLM
 */
async function registerN8nWebhook(event) {
    event.preventDefault();

    const webhookData = {
        name: document.getElementById('n8nName').value.trim(),
        provider: document.getElementById('n8nProvider').value,
        webhookUrl: document.getElementById('n8nWebhookUrl').value.trim(),
        authentication: {
            type: document.getElementById('n8nAuthType').value,
            keyName: document.getElementById('n8nAuthKeyName').value.trim() || undefined,
            encryptedKey: document.getElementById('n8nAuthKey').value.trim() || undefined
        },
        capabilities: {
            maxContext: parseInt(document.getElementById('n8nMaxContext').value) || 4096,
            supportsStreaming: document.getElementById('n8nSupportsStreaming').value === 'true'
        },
        requestFormat: {
            method: 'POST',
            bodyTemplate: document.getElementById('n8nBodyTemplate').value.trim(),
            responseExtractor: document.getElementById('n8nResponsePath').value.trim()
        }
    };

    try {
        const response = await fetch(`${API_BASE}/api/models/sources/n8n`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(webhookData),
            credentials: 'include'
        });

        const data = await response.json();

        if (data.status === 'success') {
            showSuccess('n8n Webhook LLM registered successfully!');
            closeN8nModal();
            loadModels();
        } else {
            showError('Failed to register webhook: ' + data.message);
        }
    } catch (error) {
        console.error('Error registering webhook:', error);
        showError('Failed to register webhook: ' + error.message);
    }
}

/**
 * Test existing n8n webhook
 */
async function testN8nWebhook(id) {
    try {
        showSuccess('Testing webhook... please wait');

        const response = await fetch(`${API_BASE}/api/models/sources/n8n/${id}/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: 'Test: What is 2+2?' })
        });

        const data = await response.json();

        if (data.status === 'success') {
            showSuccess(`Connection successful! Latency: ${data.data.latencyMs}ms`);
            loadModels(); // Refresh to show updated test results
        } else {
            showError('Connection test failed: ' + data.message);
        }
    } catch (error) {
        console.error('Error testing webhook:', error);
        showError('Failed to test webhook: ' + error.message);
    }
}

/**
 * Edit n8n webhook (placeholder)
 */
function editN8nWebhook(id) {
    showError('Edit functionality coming soon. ID: ' + id);
    // TODO: Implement edit modal
}

/**
 * Delete n8n webhook
 */
async function deleteN8nWebhook(id) {
    if (!confirm('Are you sure you want to delete this n8n webhook LLM?')) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/models/sources/n8n/${id}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        const data = await response.json();

        if (data.status === 'success') {
            showSuccess('Webhook deleted successfully');
            loadModels();
        } else {
            showError('Failed to delete webhook: ' + data.message);
        }
    } catch (error) {
        console.error('Error deleting webhook:', error);
        showError('Failed to delete webhook: ' + error.message);
    }
}

// ========================================
// Custom Model Management
// ========================================

/**
 * Open custom model registration modal
 */
function openRegisterModal() {
    // Reuse existing register modal from models.html
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
 * Register custom model (existing functionality)
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
        parameters: {
            num_ctx: document.getElementById('numCtx').value ? parseInt(document.getElementById('numCtx').value) : undefined,
            num_gpu: document.getElementById('numGpu').value ? parseInt(document.getElementById('numGpu').value) : undefined,
            num_thread: document.getElementById('numThread').value ? parseInt(document.getElementById('numThread').value) : undefined,
            keep_alive: document.getElementById('keepAlive').value.trim() || undefined
        },
        tags: document.getElementById('tags').value.split(',').map(t => t.trim()).filter(t => t)
    };

    try {
        const response = await fetch(`${API_BASE}/api/custom-models`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(modelData),
            credentials: 'include'
        });

        const data = await response.json();

        if (data.success) {
            showSuccess('Custom model registered successfully!');
            closeRegisterModal();
            loadModels();
        } else {
            showError('Failed to register model: ' + data.error);
        }
    } catch (error) {
        console.error('Error registering model:', error);
        showError('Failed to register model: ' + error.message);
    }
}

// ========================================
// Model Detail & Actions
// ========================================

/**
 * View model detail
 */
function viewModelDetail(modelId) {
    console.log('View detail for model:', modelId);
    // TODO: Implement detail modal
    showError('Detail view coming soon');
}

/**
 * Deploy custom model
 */
function deployCustomModel(customId) {
    // Reuse existing deploy modal
    document.getElementById('deployModelId').value = customId;
    document.getElementById('deployModal').classList.add('active');
}

/**
 * View custom model stats
 */
function viewCustomModelStats(customId) {
    console.log('View stats for custom model:', customId);
    // TODO: Implement stats view
    showError('Stats view coming soon');
}

// ========================================
// Toast Notifications
// ========================================

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
window.openN8nModal = openN8nModal;
window.closeN8nModal = closeN8nModal;
window.testN8nConnection = testN8nConnection;
window.registerN8nWebhook = registerN8nWebhook;
window.testN8nWebhook = testN8nWebhook;
window.editN8nWebhook = editN8nWebhook;
window.deleteN8nWebhook = deleteN8nWebhook;
window.openRegisterModal = openRegisterModal;
window.closeRegisterModal = closeRegisterModal;
window.registerModel = registerModel;
window.refreshModels = refreshModels;
window.applyFilters = applyFilters;
window.viewModelDetail = viewModelDetail;
window.deployCustomModel = deployCustomModel;
window.viewCustomModelStats = viewCustomModelStats;
