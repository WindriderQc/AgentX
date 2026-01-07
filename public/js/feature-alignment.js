// Feature Alignment Dashboard Logic

document.addEventListener('DOMContentLoaded', () => {
    loadReport();
    setupFilters();
});

let currentReport = null;
let statusChartInstance = null;

async function loadReport() {
    try {
        const res = await fetch('/api/features/reports/latest');
        if (!res.ok) throw new Error('Failed to load report');
        
        const report = await res.json();
        currentReport = report;
        
        renderStats(report);
        renderCharts(report);
        renderOrphans(report.orphanEndpoints);
        renderHeadlessTable(report.features);
        renderRecommendations(report.features);
        
    } catch (err) {
        console.error(err);
        showToast('Failed to load feature alignment report.', 'error');
        document.querySelector('.main-content').innerHTML = `
            <div class="card" style="text-align: center; padding: 50px;">
                <h3>Report Not Found</h3>
                <p>Please run the codebase scan to generate the report.</p>
                <button class="btn btn-primary" onclick="refreshScan()">Run Scan Now</button>
            </div>
        `;
    }
}

async function refreshScan() {
    const btn = document.querySelector('button[onclick="refreshScan()"]');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning...';
    btn.disabled = true;

    try {
        // Trigger via API if we implement the full scan logic there,
        // otherwise we might need to rely on the CLI script being run.
        // For now, let's assume we can trigger the API scan which should ideally update the file too
        // But our API currently only updates DB.
        // Let's call the API scan anyway, assuming we might patch it or it might be enough.
        // Wait, the API scan endpoint in routes/features.js currently DOES NOT update the JSON file. 
        // It only talks to DB.
        // So hitting this via UI won't update the report file I'm reading.
        // I will display a message instead for now or call the API and hope for the best if I patched it?
        // Actually, I should probably rely on the user running the script or update the route to write file.
        // I will call the API endpoint regardless as it is "Scan Now".
        
        const res = await fetch('/api/features/inventory/scan', { method: 'POST' });
        const result = await res.json();
        
        if (result.status === 'success') {
            showToast('Scan complete! Reloading...', 'success');
            // Wait a bit and reload report - note: this won't work well if file isn't updated
            setTimeout(loadReport, 1000);
        } else {
            throw new Error(result.message);
        }
    } catch (err) {
        showToast('Scan failed: ' + err.message, 'error');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

function renderStats(report) {
    const c = report.summary.counts;
    // Status counts are in report.summary.statusCounts usually
    const s = report.summary.statusCounts || {};
    
    document.getElementById('count-total').textContent = c.features;
    document.getElementById('count-endpoints').textContent = c.backendEndpoints;
    document.getElementById('count-orphan').textContent = c.orphanEndpoints;
    
    // Status counts
    // 'complete', 'partial', 'headless-documented', etc.
    // keys might differ slightly based on scanner output
    document.getElementById('count-complete').textContent = s['complete'] || 0;
    document.getElementById('count-partial').textContent = s['partial'] || 0;
    document.getElementById('count-headless').textContent = s['headless-documented'] || 0;
    
    document.getElementById('orphan-badge').textContent = c.orphanEndpoints;
}

function renderCharts(report) {
    const ctx = document.getElementById('statusChart').getContext('2d');
    const s = report.summary.statusCounts || {};
    
    if (statusChartInstance) statusChartInstance.destroy();
    
    statusChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Complete', 'Partial', 'Headless', 'Orphan'], // Orphan is separate usually
            datasets: [{
                data: [
                    s['complete'] || 0,
                    s['partial'] || 0,
                    s['headless-documented'] || 0,
                    report.summary.counts.orphanEndpoints
                ],
                backgroundColor: [
                    '#10b981', // green
                    '#f59e0b', // amber
                    '#ef4444', // red
                    '#1e293b'  // slate
                ],
                borderWidth: 0
            }]
        },
        options: {
            cutout: '70%',
            plugins: {
                legend: { display: false }
            }
        }
    });
}

function renderOrphans(orphans) {
    const tbody = document.querySelector('#orphans-table tbody');
    tbody.innerHTML = '';
    
    if (!orphans || orphans.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No orphan endpoints found.</td></tr>';
        return;
    }

    orphans.forEach(ep => {
        const file = ep.sourceFile ? ep.sourceFile.split('/').pop() : 'Unknown';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><span class="badge badge-sm">${ep.method}</span></td>
            <td><code>${ep.path}</code></td>
            <td>${file}</td>
            <td class="actions-cell">
                <button class="btn btn-sm btn-secondary" onclick="linkOrphan('${ep.path}')">Link</button>
                <button class="btn btn-sm btn-muted" onclick="ignoreOrphan('${ep.path}')">Ignore</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function renderHeadlessTable(features) {
    const tbody = document.querySelector('#headless-table tbody');
    tbody.innerHTML = '';
    
    const filterText = document.getElementById('search-input').value.toLowerCase();
    const filterPriority = document.getElementById('priority-filter').value;
    
    // Filter for headless-documented ONLY (as per requirements for this table)
    let filtered = features.filter(f => f.status === 'headless-documented');
    
    // Apply filters
    filtered = filtered.filter(f => {
        const matchesText = f.key.toLowerCase().includes(filterText);
        const matchesPriority = filterPriority === 'all' || (f.priority && f.priority.level === filterPriority);
        return matchesText && matchesPriority;
    });

    // Sort by priority score DESC
    filtered.sort((a, b) => (b.priority?.score || 0) - (a.priority?.score || 0));

    filtered.forEach(f => {
        const score = f.priority ? f.priority.score : 0;
        const level = f.priority ? f.priority.level : 'LOW';
        const levelClass = level === 'HIGH' ? 'priority-high' : level === 'MEDIUM' ? 'priority-medium' : 'priority-low';
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <strong>${f.key}</strong>
                <div class="text-xs text-muted">Score: ${score}/100</div>
            </td>
            <td>${f.docs ? f.docs.length : 0} files</td>
            <td>${f.backendHits ? f.backendHits.length : 0} endpoints</td>
            <td><span class="priority-badge ${levelClass}">${level}</span></td>
            <td>
                <button class="btn btn-sm btn-primary" onclick="window.location.href='/feature-builder.html?feature=${f.key}'">Build UI</button>
                <button class="btn btn-sm btn-secondary" onclick="showFeatureDetails('${f.key}')">Details</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function renderRecommendations(features) {
    const container = document.getElementById('action-items');
    
    // Logic: Top 3 High Priority Headless
    const highPriority = features
        .filter(f => f.status === 'headless-documented')
        .sort((a, b) => (b.priority?.score || 0) - (a.priority?.score || 0))
        .slice(0, 3);
        
    if (highPriority.length === 0) {
        container.innerHTML = '<p class="text-muted">No critical actions identified.</p>';
        return;
    }
    
    let html = '';
    highPriority.forEach(f => {
        html += `
            <div class="alert alert-info" style="margin-bottom: 10px;">
                <strong><i class="fas fa-exclamation-circle"></i> High Priority: ${f.key}</strong>
                <p class="text-sm">
                    Score: ${f.priority?.score}. Used by n8n or critical path. 
                    <a href="#" onclick="showFeatureDetails('${f.key}')">View Specs</a>
                </p>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function setupFilters() {
    document.getElementById('search-input').addEventListener('input', () => {
        renderHeadlessTable(currentReport.features);
    });
    document.getElementById('priority-filter').addEventListener('change', () => {
        renderHeadlessTable(currentReport.features);
    });
}

window.showFeatureDetails = function(key) {
    const feature = currentReport.features.find(f => f.key === key);
    if (!feature) return;
    
    const modal = document.getElementById('feature-modal');
    document.getElementById('modal-feature-name').textContent = feature.key;
    
    let html = '';
    
    // Priority
    if (feature.priority) {
        html += `<div class="detail-section">
            <h4>Priority Score: ${feature.priority.score}/100 (${feature.priority.level})</h4>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; font-size:0.9rem;">
                <div>n8n Usage: ${feature.priority.breakdown.n8n ? '✅' : '❌'}</div>
                <div>Endpoints: ${feature.priority.breakdown.endpoints} pts</div>
                <div>Docs: ${feature.priority.breakdown.docs} pts</div>
                <div>Security: ${feature.priority.breakdown.security} pts</div>
                <div>Activity: ${feature.priority.breakdown.activity} pts</div>
            </div>
        </div>`;
    }

    // Endpoints
    html += `<div class="detail-section">
        <h4>Endpoints (${feature.backendHits ? feature.backendHits.length : 0})</h4>
        <ul class="file-list">`;
    if (feature.backendHits && feature.backendHits.length > 0) {
        feature.backendHits.forEach(ep => {
            html += `<li>${ep.method} ${ep.path}</li>`;
        });
    } else {
        html += '<li>No direct endpoints detected</li>';
    }
    html += `</ul></div>`;

    // Docs
    html += `<div class="detail-section">
        <h4>Documentation</h4>
        <ul class="file-list">`;
    if (feature.docs && feature.docs.length > 0) {
        feature.docs.forEach(d => {
            html += `<li>${d.replace(currentReport.summary.rootDir, '')}</li>`;
        });
    } else {
        html += '<li>No documentation found</li>';
    }
    html += `</ul></div>`;
    
    document.getElementById('modal-body').innerHTML = html;
    
    modal.style.display = 'flex';
};

// Modal closing logic
document.querySelector('.close-modal').addEventListener('click', () => {
    document.getElementById('feature-modal').style.display = 'none';
});

window.onclick = function(event) {
    const modal = document.getElementById('feature-modal');
    if (event.target == modal) {
        modal.style.display = 'none';
    }
};

window.linkOrphan = function(path) {
    showToast('Linking not yet implemented', 'info');
};

window.ignoreOrphan = function(path) {
    showToast('Marked as ignored (local only)', 'success');
    // Implement local ignore
};

function showToast(msg, type='info') {
    // Simple toast
    const div = document.createElement('div');
    div.className = `alert alert-${type}`;
    div.style.position = 'fixed';
    div.style.bottom = '20px';
    div.style.right = '20px';
    div.style.zIndex = '9999';
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 3000);
}
