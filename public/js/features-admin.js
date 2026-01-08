// Feature Flags Store
let featureFlags = [];

let activityLog = []; // Will fetch from API if available or keep empty for now

/**
 * Helper: Get headers with workspace context
 */
function getWorkspaceHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (window.WorkspaceManager && typeof window.WorkspaceManager.addWorkspaceHeader === 'function') {
        const workspaceHeaders = window.WorkspaceManager.addWorkspaceHeader({});
        Object.assign(headers, workspaceHeaders);
    }
    return headers;
}

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    loadFlags();
    loadActivityLog();
    setupEventListeners();
});

// --- Core Functions ---

async function loadFlags() {
    try {
        const res = await fetch('/api/features/flags', { headers: getWorkspaceHeaders() });
        const json = await res.json();
        if (json.status === 'success') {
            featureFlags = json.data;
        }
    } catch (e) {
        console.error('Failed to load flags', e);
    }

    const tbody = document.getElementById('flags-table-body');
    tbody.innerHTML = '';

    featureFlags.forEach(flag => {
        const lastUpdated = flag.metadata && flag.metadata.updatedAt 
            ? new Date(flag.metadata.updatedAt).toLocaleDateString() 
            : 'Just now';
            
        const rollout = flag.config ? flag.config.rolloutPercentage : (flag.rolloutPercentage || 100);

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <strong>${flag.name}</strong><br>
                <small style="color:#64748b">${flag.description}</small>
            </td>
            <td>
                <label class="switch">
                    <input type="checkbox" ${flag.enabled ? 'checked' : ''} onchange="toggleFlag('${flag.name}', this.checked)">
                    <span class="slider"></span>
                </label>
            </td>
            <td><span class="badge scope-${flag.scope}">${capitalize(flag.scope)}</span></td>
            <td>${rollout}%</td>
            <td>${lastUpdated}</td>
            <td>
                <button class="btn btn-muted btn-icon" onclick="openEditModal('${flag.name}')" title="Edit"><i class="fas fa-edit"></i></button>
                <button class="btn btn-muted btn-icon" onclick="deleteFlag('${flag.name}')" title="Delete"><i class="fas fa-trash"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function loadActivityLog() {
    const list = document.getElementById('activity-log-list');
    list.innerHTML = '';

    activityLog.forEach(log => {
        const li = document.createElement('li');
        li.className = 'activity-item';
        li.innerHTML = `
            <div>
                <span class="activity-icon">${log.icon}</span>
                ${log.action}
            </div>
            <span class="activity-time">${log.time}</span>
        `;
        list.appendChild(li);
    });
}

// --- Actions ---

window.toggleFlag = async function(flagName, isEnabled) {
    try {
        const res = await fetch(`/api/features/flags/${flagName}/toggle`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (res.ok) {
            // Optimistic Update
            const flag = featureFlags.find(f => f.name === flagName);
            if (flag) flag.enabled = isEnabled;
            
            const action = isEnabled ? `Enabled '${flagName}' flag` : `Disabled '${flagName}' flag`;
            addLog(action, '<i class="fas fa-toggle-on"></i>');
            showToast(action, 'success');
        } else {
            showToast('Failed to toggle flag', 'error');
            loadFlags(); // Revert
        }
    } catch (e) {
        console.error(e);
        showToast('Network error toggling flag', 'error');
        loadFlags(); // Revert
    }
};

window.deleteFlag = async function(flagName) {
    if (confirm(`Are you sure you want to delete the flag '${flagName}'?`)) {
        try {
            const res = await fetch(`/api/features/flags/${flagName}`, {
                method: 'DELETE'
            });

            if (res.ok) {
                featureFlags = featureFlags.filter(f => f.name !== flagName);
                loadFlags();
                addLog(`Deleted '${flagName}' flag`, '<i class="fas fa-trash"></i>');
                showToast(`Flag '${flagName}' deleted`, 'success');
            } else {
                showToast('Failed to delete flag', 'error');
            }
        } catch (e) {
            console.error(e);
            showToast('Network error deleting flag', 'error');
        }
    }
};

window.openEditModal = function(flagName) {
    const flag = featureFlags.find(f => f.name === flagName);
    if (flag) {
        document.getElementById('modal-title').innerText = 'Edit Feature Flag';
        document.getElementById('flag-edit-original-name').value = flag.name;
        document.getElementById('flag-name').value = flag.name;
        document.getElementById('flag-desc').value = flag.description;
        document.getElementById('flag-scope').value = flag.scope;
        document.getElementById('flag-rollout').value = flag.rolloutPercentage;
        document.getElementById('flag-enabled').checked = flag.enabled;
        
        // Lock name field for edit to simplify mock logic
        document.getElementById('flag-name').disabled = true;

        showModal();
    }
};

async function saveFlag(e) {
    e.preventDefault();
    
    const originalName = document.getElementById('flag-edit-original-name').value;
    const name = document.getElementById('flag-name').value;
    const desc = document.getElementById('flag-desc').value;
    const scope = document.getElementById('flag-scope').value;
    const rollout = document.getElementById('flag-rollout').value;
    const enabled = document.getElementById('flag-enabled').checked;

    const payload = {
        name,
        description: desc,
        scope,
        rolloutPercentage: parseInt(rollout),
        enabled
    };

    try {
        // Backend handles both Create and Update via POST (Upsert logic)
        const res = await fetch('/api/features/flags', {
            method: 'POST',
            headers: getWorkspaceHeaders(),
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            loadFlags();
            hideModal();
            const action = originalName ? `Updated '${name}' flag` : `Added '${name}' flag`;
            addLog(action, '<i class="fas fa-save"></i>');
            showToast(action, 'success');
        } else {
            const err = await res.json();
            showToast(err.message || 'Failed to save flag', 'error');
        }
    } catch (error) {
        console.error(error);
        showToast('Network error saving flag', 'error');
    }
}

// --- System Actions ---

function handleSystemAction(btnId, actionName, icon, duration = 2000) {
    const btn = document.getElementById(btnId);
    if(!btn) return;
    
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Processing...`;

    // Simulate API delay
    setTimeout(() => {
        btn.disabled = false;
        btn.innerText = originalText;
        addLog(actionName, icon);
        showToast(`${actionName} completed`, 'success');
    }, duration);
}

// --- Helpers ---

function setupEventListeners() {
    // Add Flag Button
    document.getElementById('btn-add-flag').addEventListener('click', () => {
        document.getElementById('flag-form').reset();
        document.getElementById('modal-title').innerText = 'Add Feature Flag';
        document.getElementById('flag-edit-original-name').value = '';
        document.getElementById('flag-name').disabled = false;
        showModal();
    });

    // Modal Close
    const modal = document.getElementById('flag-modal');
    document.querySelector('.close-modal').addEventListener('click', hideModal);
    document.querySelector('.close-modal-btn').addEventListener('click', hideModal);
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) hideModal();
    });

    // Form Submit
    document.getElementById('flag-form').addEventListener('submit', saveFlag);

    // System Action Buttons
    document.getElementById('btn-scan').addEventListener('click', async () => {
        const btn = document.getElementById('btn-scan');
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Scanning...`;
        
        try {
            const res = await fetch('/api/features/inventory/scan', { 
                method: 'POST',
                headers: getWorkspaceHeaders()
            });
            const json = await res.json();
            if (json.status === 'success') {
                addLog('Scanned codebase', '<i class="fas fa-search-code"></i>');
                showToast('Codebase scan complete', 'success');
            } else {
                showToast('Scan failed: ' + json.message, 'error');
            }
        } catch(e) {
            console.error(e);
            showToast('Network error during scan', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    });

    document.getElementById('btn-clear-telemetry').addEventListener('click', () => {
        if(confirm('Are you sure you want to clear all telemetry data? This cannot be undone.')) {
            handleSystemAction('btn-clear-telemetry', 'Telemetry cleared', '<i class="fas fa-trash"></i>', 1000);
        }
    });

    document.getElementById('btn-export').addEventListener('click', () => {
        handleSystemAction('btn-export', 'Report exported', '<i class="fas fa-file-export"></i>', 1500);
    });

    document.getElementById('btn-sync').addEventListener('click', () => {
        handleSystemAction('btn-sync', 'Roadmap synced', '<i class="fas fa-sync-alt"></i>', 2500);
    });
}

function addLog(action, icon) {
    activityLog.unshift({ action, icon, time: 'Just now' });
    if (activityLog.length > 10) activityLog.pop();
    loadActivityLog();
}

function showModal() {
    document.getElementById('flag-modal').classList.remove('hidden');
}

function hideModal() {
    document.getElementById('flag-modal').classList.add('hidden');
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let iconClass = 'fa-info-circle';
    if (type === 'success') iconClass = 'fa-check-circle';
    if (type === 'error') iconClass = 'fa-exclamation-circle';

    toast.innerHTML = `<i class="fas ${iconClass}"></i> <span>${message}</span>`;
    
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}
