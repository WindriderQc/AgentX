// Mock Data Store
let featureFlags = [
    {
        name: "voice-input",
        enabled: false,
        description: "Voice input feature (speech-to-text)",
        scope: "global",
        rolloutPercentage: 0,
        updated: "2h ago"
    },
    {
        name: "new-dashboard-ui",
        enabled: true,
        description: "New card-based dashboard layout",
        scope: "beta",
        rolloutPercentage: 25,
        updated: "1d ago"
    },
    {
        name: "rag-integration",
        enabled: true,
        description: "RAG document processing",
        scope: "global",
        rolloutPercentage: 100,
        updated: "3d ago"
    },
    {
        name: "analytics-v2",
        enabled: false,
        description: "Advanced analytics charts",
        scope: "user",
        rolloutPercentage: 0,
        updated: "5h ago"
    }
];

let activityLog = [
    { action: "Disabled 'voice-input' flag", time: "2h ago", icon: '<i class="fas fa-toggle-off"></i>' },
    { action: "Updated 'new-dashboard-ui' rollout to 25%", time: "1d ago", icon: '<i class="fas fa-sliders-h"></i>' },
    { action: "Scanned codebase", time: "2d ago", icon: '<i class="fas fa-search-code"></i>' },
    { action: "Added 'rag-integration' flag", time: "3d ago", icon: '<i class="fas fa-plus-circle"></i>' }
];

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    loadFlags();
    loadActivityLog();
    setupEventListeners();
});

// --- Core Functions ---

function loadFlags() {
    const tbody = document.getElementById('flags-table-body');
    tbody.innerHTML = '';

    featureFlags.forEach(flag => {
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
            <td>${flag.rolloutPercentage}%</td>
            <td>${flag.updated}</td>
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

window.toggleFlag = function(flagName, isEnabled) {
    // Optimistic Update
    const flag = featureFlags.find(f => f.name === flagName);
    if (flag) {
        flag.enabled = isEnabled;
        const action = isEnabled ? `Enabled '${flagName}' flag` : `Disabled '${flagName}' flag`;
        addLog(action, '<i class="fas fa-toggle-on"></i>');
        showToast(action, 'success');
        // In real app, we would make an API call here
    }
};

window.deleteFlag = function(flagName) {
    if (confirm(`Are you sure you want to delete the flag '${flagName}'?`)) {
        featureFlags = featureFlags.filter(f => f.name !== flagName);
        loadFlags();
        addLog(`Deleted '${flagName}' flag`, '<i class="fas fa-trash"></i>');
        showToast(`Flag '${flagName}' deleted`, 'success');
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

function saveFlag(e) {
    e.preventDefault();
    
    const originalName = document.getElementById('flag-edit-original-name').value;
    const name = document.getElementById('flag-name').value;
    const desc = document.getElementById('flag-desc').value;
    const scope = document.getElementById('flag-scope').value;
    const rollout = document.getElementById('flag-rollout').value;
    const enabled = document.getElementById('flag-enabled').checked;

    if (originalName) {
        // Edit existing
        const flag = featureFlags.find(f => f.name === originalName);
        if (flag) {
            flag.description = desc;
            flag.scope = scope;
            flag.rolloutPercentage = rollout;
            flag.enabled = enabled;
            flag.updated = 'Just now';
            addLog(`Updated '${name}' flag`, '<i class="fas fa-edit"></i>');
        }
    } else {
        // Add new
        if (featureFlags.some(f => f.name === name)) {
            showToast('Flag already exists!', 'error');
            return;
        }
        featureFlags.push({
            name: name,
            description: desc,
            scope: scope,
            rolloutPercentage: rollout,
            enabled: enabled,
            updated: 'Just now'
        });
        addLog(`Added '${name}' flag`, '<i class="fas fa-plus"></i>');
    }

    loadFlags();
    hideModal();
    showToast(`Flag '${name}' saved successfully`, 'success');
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
    document.getElementById('btn-scan').addEventListener('click', () => {
        handleSystemAction('btn-scan', 'Codebase scan', '<i class="fas fa-search-code"></i>', 3000);
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
