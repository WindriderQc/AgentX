// Backup & Recovery Dashboard JavaScript

const API_BASE = window.location.origin;

// Show toast notification
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toast-message');
    const icon = toast.querySelector('i');

    toastMessage.textContent = message;

    // Update icon based on type
    if (type === 'error') {
        icon.className = 'fas fa-exclamation-circle';
        toast.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
    } else if (type === 'warning') {
        icon.className = 'fas fa-exclamation-triangle';
        toast.style.background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
    } else {
        icon.className = 'fas fa-check-circle';
        toast.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
    }

    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// MongoDB Backup Operations
async function backupMongo() {
    try {
        showToast('Starting MongoDB backup...', 'warning');
        const response = await fetch(`${API_BASE}/api/backup/mongodb`, {
            method: 'POST'
        });

        const data = await response.json();

        if (data.success) {
            showToast('MongoDB backup completed successfully!');
            updateBackupStats('mongo', data.backup);
        } else {
            showToast(data.message || 'Backup failed', 'error');
        }
    } catch (error) {
        console.error('Backup error:', error);
        showToast('Failed to create backup: ' + error.message, 'error');
    }
}

async function listMongoBackups() {
    try {
        const response = await fetch(`${API_BASE}/api/backup/mongodb/list`);
        const data = await response.json();

        if (data.success) {
            displayBackupList('MongoDB Backups', data.backups, 'mongo');
        } else {
            showToast('Failed to load backups', 'error');
        }
    } catch (error) {
        console.error('List error:', error);
        showToast('Failed to load backups: ' + error.message, 'error');
    }
}

async function restoreMongo(filename) {
    if (!confirm(`Restore MongoDB from backup: ${filename}?\n\nThis will overwrite current data!`)) {
        return;
    }

    try {
        showToast('Restoring MongoDB...', 'warning');
        const response = await fetch(`${API_BASE}/api/backup/mongodb/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
        });

        const data = await response.json();

        if (data.success) {
            showToast('MongoDB restored successfully!');
        } else {
            showToast(data.message || 'Restore failed', 'error');
        }
    } catch (error) {
        console.error('Restore error:', error);
        showToast('Failed to restore: ' + error.message, 'error');
    }
}

// Qdrant Backup Operations
async function backupQdrant() {
    try {
        showToast('Creating Qdrant snapshot...', 'warning');
        const response = await fetch(`${API_BASE}/api/backup/qdrant`, {
            method: 'POST'
        });

        const data = await response.json();

        if (data.success) {
            showToast('Qdrant snapshot created successfully!');
            updateBackupStats('qdrant', data.backup);
        } else {
            showToast(data.message || 'Snapshot failed', 'error');
        }
    } catch (error) {
        console.error('Snapshot error:', error);
        showToast('Failed to create snapshot: ' + error.message, 'error');
    }
}

async function listQdrantBackups() {
    try {
        const response = await fetch(`${API_BASE}/api/backup/qdrant/list`);
        const data = await response.json();

        if (data.success) {
            displayBackupList('Qdrant Snapshots', data.backups, 'qdrant');
        } else {
            showToast('Failed to load snapshots', 'error');
        }
    } catch (error) {
        console.error('List error:', error);
        showToast('Failed to load snapshots: ' + error.message, 'error');
    }
}

async function restoreQdrant(filename) {
    if (!confirm(`Restore Qdrant from snapshot: ${filename}?\n\nThis will overwrite current vector data!`)) {
        return;
    }

    try {
        showToast('Restoring Qdrant...', 'warning');
        const response = await fetch(`${API_BASE}/api/backup/qdrant/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
        });

        const data = await response.json();

        if (data.success) {
            showToast('Qdrant restored successfully!');
        } else {
            showToast(data.message || 'Restore failed', 'error');
        }
    } catch (error) {
        console.error('Restore error:', error);
        showToast('Failed to restore: ' + error.message, 'error');
    }
}

// Workflow Version Control
async function commitWorkflows() {
    try {
        showToast('Committing workflows to Git...', 'warning');
        const response = await fetch(`${API_BASE}/api/backup/workflows/commit`, {
            method: 'POST'
        });

        const data = await response.json();

        if (data.success) {
            showToast('Workflows committed successfully!');
            updateWorkflowStats(data);
        } else {
            showToast(data.message || 'Commit failed', 'error');
        }
    } catch (error) {
        console.error('Commit error:', error);
        showToast('Failed to commit: ' + error.message, 'error');
    }
}

async function viewWorkflowHistory() {
    try {
        const response = await fetch(`${API_BASE}/api/backup/workflows/history`);
        const data = await response.json();

        if (data.success) {
            displayWorkflowHistory(data.commits);
        } else {
            showToast('Failed to load history', 'error');
        }
    } catch (error) {
        console.error('History error:', error);
        showToast('Failed to load history: ' + error.message, 'error');
    }
}

// Cron Automation
async function setupCron() {
    if (!confirm('Install automated backup cron jobs?\n\nThis will set up:\n• MongoDB backup (daily 2AM)\n• Qdrant snapshot (daily 3AM)\n• Workflow commits (every 6 hours)')) {
        return;
    }

    try {
        showToast('Installing cron jobs...', 'warning');
        const response = await fetch(`${API_BASE}/api/backup/cron/install`, {
            method: 'POST'
        });

        const data = await response.json();

        if (data.success) {
            showToast('Cron jobs installed successfully!');
            displayCronLog(data.output);
            updateCronStatus();
        } else {
            showToast(data.message || 'Installation failed', 'error');
        }
    } catch (error) {
        console.error('Cron error:', error);
        showToast('Failed to install cron: ' + error.message, 'error');
    }
}

async function checkCronStatus() {
    try {
        const response = await fetch(`${API_BASE}/api/backup/cron/status`);
        const data = await response.json();

        if (data.success) {
            updateCronStatus(data.status);
            displayCronLog(data.cronJobs || 'No cron jobs found');
        } else {
            showToast('Failed to check status', 'error');
        }
    } catch (error) {
        console.error('Status error:', error);
        showToast('Failed to check status: ' + error.message, 'error');
    }
}

async function removeCron() {
    if (!confirm('Remove all automated backup cron jobs?')) {
        return;
    }

    try {
        showToast('Removing cron jobs...', 'warning');
        const response = await fetch(`${API_BASE}/api/backup/cron/remove`, {
            method: 'POST'
        });

        const data = await response.json();

        if (data.success) {
            showToast('Cron jobs removed successfully!');
            updateCronStatus({ installed: false });
        } else {
            showToast(data.message || 'Removal failed', 'error');
        }
    } catch (error) {
        console.error('Remove error:', error);
        showToast('Failed to remove cron: ' + error.message, 'error');
    }
}

// UI Update Functions
function updateBackupStats(type, backup) {
    if (type === 'mongo') {
        document.getElementById('mongo-last-backup').textContent = formatDate(backup.date);
        document.getElementById('mongo-backup-size').textContent = formatSize(backup.size);
    } else if (type === 'qdrant') {
        document.getElementById('qdrant-last-backup').textContent = formatDate(backup.date);
        document.getElementById('qdrant-backup-size').textContent = formatSize(backup.size);
    }
}

function updateWorkflowStats(data) {
    if (data.lastCommit) {
        document.getElementById('workflow-last-commit').textContent = formatDate(data.lastCommit);
    }
    if (data.changes !== undefined) {
        document.getElementById('workflow-changes').textContent = data.changes;
    }
}

function updateCronStatus(status) {
    const statusEl = document.getElementById('cron-status');
    const nextBackupEl = document.getElementById('next-backup');

    if (status && status.installed) {
        statusEl.textContent = 'Active';
        statusEl.style.color = '#22c55e';
        if (status.nextBackup) {
            nextBackupEl.textContent = formatDate(status.nextBackup);
        }
    } else {
        statusEl.textContent = 'Not Installed';
        statusEl.style.color = '#ef4444';
        nextBackupEl.textContent = 'Not scheduled';
    }
}

function displayCronLog(output) {
    const logEl = document.getElementById('cron-log');
    logEl.textContent = output;
    logEl.style.display = 'block';
}

function displayBackupList(title, backups, type) {
    const container = document.getElementById('backup-list-container');
    const titleEl = document.getElementById('backup-list-title');
    const listEl = document.getElementById('backup-list');

    titleEl.textContent = title;

    if (!backups || backups.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><i class="fas fa-folder-open"></i><p>No backups found</p></div>';
    } else {
        listEl.innerHTML = backups.map(backup => `
            <div class="backup-item">
                <div class="backup-info">
                    <div class="backup-name">${backup.name}</div>
                    <div class="backup-meta">
                        <i class="fas fa-calendar"></i> ${formatDate(backup.date)}
                        <i class="fas fa-hdd" style="margin-left: 1rem;"></i> ${formatSize(backup.size)}
                    </div>
                </div>
                <div class="backup-item-actions">
                    <button class="icon-btn" onclick="restore${type === 'mongo' ? 'Mongo' : 'Qdrant'}('${backup.name}')" title="Restore">
                        <i class="fas fa-undo"></i>
                    </button>
                    <button class="icon-btn danger" onclick="deleteBackup('${type}', '${backup.name}')" title="Delete">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }

    container.style.display = 'block';
}

function displayWorkflowHistory(commits) {
    const container = document.getElementById('backup-list-container');
    const titleEl = document.getElementById('backup-list-title');
    const listEl = document.getElementById('backup-list');

    titleEl.textContent = 'Workflow Commit History';

    if (!commits || commits.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><i class="fas fa-history"></i><p>No commit history</p></div>';
    } else {
        listEl.innerHTML = commits.map(commit => `
            <div class="backup-item">
                <div class="backup-info">
                    <div class="backup-name">${commit.message}</div>
                    <div class="backup-meta">
                        <i class="fas fa-code-branch"></i> ${commit.hash}
                        <i class="fas fa-calendar" style="margin-left: 1rem;"></i> ${formatDate(commit.date)}
                    </div>
                </div>
                <div class="backup-item-actions">
                    <button class="icon-btn" onclick="viewCommitDiff('${commit.hash}')" title="View Changes">
                        <i class="fas fa-code"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }

    container.style.display = 'block';
}

async function deleteBackup(type, filename) {
    if (!confirm(`Delete backup: ${filename}?`)) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/backup/${type}/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
        });

        const data = await response.json();

        if (data.success) {
            showToast('Backup deleted successfully!');
            // Refresh the list
            if (type === 'mongo') {
                listMongoBackups();
            } else {
                listQdrantBackups();
            }
        } else {
            showToast(data.message || 'Delete failed', 'error');
        }
    } catch (error) {
        console.error('Delete error:', error);
        showToast('Failed to delete: ' + error.message, 'error');
    }
}

async function viewCommitDiff(hash) {
    try {
        const response = await fetch(`${API_BASE}/api/backup/workflows/diff/${hash}`);
        const data = await response.json();

        if (data.success) {
            alert(`Commit: ${hash}\n\n${data.diff}`);
        } else {
            showToast('Failed to load diff', 'error');
        }
    } catch (error) {
        console.error('Diff error:', error);
        showToast('Failed to load diff: ' + error.message, 'error');
    }
}

// Utility Functions
function formatDate(dateString) {
    if (!dateString) return 'Unknown';
    const date = new Date(dateString);
    return date.toLocaleString();
}

function formatSize(bytes) {
    if (!bytes) return '-';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    console.log('Backup dashboard initialized');

    // Load initial stats
    checkCronStatus();

    // Load backup counts
    fetch(`${API_BASE}/api/backup/stats`)
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                if (data.mongo) {
                    document.getElementById('mongo-backup-count').textContent = data.mongo.count;
                    document.getElementById('mongo-last-backup').textContent = formatDate(data.mongo.lastBackup);
                }
                if (data.qdrant) {
                    document.getElementById('qdrant-backup-count').textContent = data.qdrant.count;
                    document.getElementById('qdrant-last-backup').textContent = formatDate(data.qdrant.lastBackup);
                }
                if (data.workflows) {
                    document.getElementById('workflow-last-commit').textContent = formatDate(data.workflows.lastCommit);
                    document.getElementById('workflow-changes').textContent = data.workflows.uncommitted;
                }
            }
        })
        .catch(err => console.error('Failed to load stats:', err));
});
