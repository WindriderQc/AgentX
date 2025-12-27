// AgentX Unified Operations Center Logic
import { API } from './utils/index.js';

let activeTab = 'overview';
let metricsInterval = null;
let healthInterval = null;

// --- UTILITIES ---

function formatBytes(bytes) {
    if (bytes === 0 || bytes === undefined) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function formatNumber(num) {
    if (num === null || num === undefined) return '0';
    return num.toLocaleString();
}

// --- HEALTH LOGIC ---

async function updateHealthStatus() {
    try {
        // AgentX Health (Local)
        const localHealth = await API.get('/health');
        const agentxDot = document.querySelector('#health-agentx .status-dot');
        if (agentxDot) {
            agentxDot.className = `status-dot status-${localHealth.status === 'ok' ? 'online' : 'offline'}`;
        }

        // External Health (Ollama & n8n via aggregated endpoint)
        const externalHealth = await API.get('/api/health/external');

        const map = {
            ollama99: '#health-ollama99',
            ollama12: '#health-ollama12',
            n8n: '#health-n8n'
        };

        for (const [key, selector] of Object.entries(map)) {
            const dot = document.querySelector(`${selector} .status-dot`);
            if (dot) {
                const status = externalHealth[key] === 'online' || externalHealth[key]?.status === 'success' || externalHealth[key]?.status === 'ok' ? 'online' : 'offline';
                dot.className = `status-dot status-${status}`;
            }
        }

        // MongoDB Health (via /api/dashboard/health)
        const dashHealth = await API.get('/api/dashboard/health');
        const mongoDot = document.querySelector('#health-mongodb .status-dot');
        if (mongoDot) {
            mongoDot.className = `status-dot status-${dashHealth.data?.mongodb?.status === 'connected' ? 'online' : 'offline'}`;
        }

    } catch (error) {
        console.error('Health check failed:', error);
    }
}

// --- TAB: OVERVIEW LOGIC ---

async function updateOverviewStats() {
    try {
        const stats = await API.get('/api/dashboard/stats');
        const totalDocs = stats.data.reduce((sum, s) => sum + s.count, 0);

        const elTotal = document.getElementById('db-total-docs');
        if (elTotal) elTotal.textContent = formatNumber(totalDocs);

        // System metrics for overview cards
        const sys = await API.get('/api/metrics/system');
        document.getElementById('sys-uptime').textContent = sys.data.uptime.formatted;
        document.getElementById('sys-mem').textContent = sys.data.memory.formatted.rss;

    } catch (error) {
        console.error('Overview stats refresh failed:', error);
    }
}

// --- TAB: N8N OPS LOGIC ---

function logEvent(message, type = 'info') {
    const logContainer = document.getElementById('eventLog');
    if (!logContainer) return;

    const eventDiv = document.createElement('div');
    eventDiv.className = `event-entry ${type}`;
    const time = new Date().toLocaleTimeString();

    eventDiv.innerHTML = `
        <strong>${message}</strong><br>
        <code>${time}</code>
    `;

    logContainer.insertBefore(eventDiv, logContainer.firstChild);

    // Trim log
    while (logContainer.children.length > 50) {
        logContainer.removeChild(logContainer.lastChild);
    }
}

async function handleWebhookTrigger() {
    const selector = document.getElementById('workflowSelector');
    const payloadRaw = document.getElementById('webhookPayload').value;
    const resultDiv = document.getElementById('triggerResult');

    let payload;
    try {
        payload = JSON.parse(payloadRaw);
    } catch (e) {
        logEvent('Invalid JSON payload', 'error');
        return;
    }

    logEvent(`Triggering ${selector.value}...`, 'info');
    resultDiv.classList.remove('hidden');
    resultDiv.innerHTML = 'Connecting...';

    try {
        let endpoint;
        if (selector.value === 'agentmail') {
            endpoint = 'https://n8n.specialblend.icu/webhook/c1deca83-ecb4-48ad-b485-59195cee9a61';
        } else if (selector.value === 'custom') {
            const customId = document.getElementById('customWebhookId').value.trim();
            endpoint = customId.startsWith('http') ? customId : `/api/n8n/trigger/${customId}`;
        } else {
            endpoint = `/api/n8n/${selector.value}`;
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        if (response.ok) {
            logEvent(`✓ ${selector.value} success`, 'success');
            resultDiv.innerHTML = `<div class="text-success">Success</div><pre>${JSON.stringify(result, null, 2)}</pre>`;
        } else {
            logEvent(`✗ ${selector.value} failed (${response.status})`, 'error');
            resultDiv.innerHTML = `<div class="text-danger">Error ${response.status}</div><pre>${JSON.stringify(result, null, 2)}</pre>`;
        }
    } catch (error) {
        logEvent(`Network error: ${error.message}`, 'error');
        resultDiv.innerHTML = `<div class="text-danger">Network Error</div><pre>${error.message}</pre>`;
    }
}

// --- TAB: SYSTEM METRICS LOGIC ---

function setStatus(el, val, healthyThreshold = 70, warningThreshold = 90, reverse = false) {
    let status = 'healthy';
    if (!reverse) {
        if (val >= healthyThreshold) status = 'healthy';
        else if (val >= 50) status = 'warning';
        else status = 'error';
    } else {
        // Lower is better (e.g. usage)
        if (val < healthyThreshold) status = 'healthy';
        else if (val < warningThreshold) status = 'warning';
        else status = 'error';
    }
    el.className = `status-dot ${status}`;
}

async function refreshSystemMetrics() {
    try {
        const [cache, database, conn, sys] = await Promise.all([
            API.get('/api/metrics/cache'),
            API.get('/api/metrics/database'),
            API.get('/api/metrics/connection'),
            API.get('/api/metrics/system')
        ]);

        // --- Cache ---
        const cacheData = cache.data.cache;
        const hitRate = (cacheData.hitRate * 100);
        const elHitRate = document.getElementById('cacheHitRate');
        if (elHitRate) {
            elHitRate.textContent = hitRate.toFixed(1) + '%';
            document.getElementById('cacheBar').style.width = hitRate + '%';
            setStatus(document.getElementById('cacheStatus'), hitRate, 70, 50);
        }

        document.getElementById('cacheHits').textContent = formatNumber(cacheData.hitCount);
        document.getElementById('cacheMisses').textContent = formatNumber(cacheData.missCount);
        document.getElementById('cacheSize').textContent = `${cacheData.size}/${cacheData.maxSize || '∞'}`;
        document.getElementById('cacheMem').textContent = formatBytes(cacheData.memorySizeBytes);

        document.getElementById('detailCacheTotal').textContent = formatNumber(cacheData.hitCount + cacheData.missCount);
        document.getElementById('detailCacheAvg').textContent = formatBytes(cacheData.avgEntrySizeBytes);
        document.getElementById('detailCacheEvict').textContent = formatNumber(cacheData.evictions);

        // --- Database ---
        const dbData = database.data;
        const totalDocs = Object.values(dbData.collections).reduce((a, b) => a + (b.count || 0), 0);
        document.getElementById('dbTotalDocs').textContent = formatNumber(totalDocs);
        document.getElementById('dbConversations').textContent = formatNumber(dbData.collections.conversations?.count);
        document.getElementById('dbPrompts').textContent = formatNumber(dbData.collections.promptconfigs?.count);
        document.getElementById('dbUsers').textContent = formatNumber(dbData.collections.userprofiles?.count);
        document.getElementById('dbIndexes').textContent = dbData.database.indexes;

        document.getElementById('detailDbName').textContent = dbData.database.name;
        document.getElementById('detailDbHost').textContent = conn.data.host;
        document.getElementById('detailDbCollections').textContent = Object.keys(dbData.collections).length;

        // --- Connections ---
        const activeConn = conn.data.activeConnections || 0;
        const maxConn = conn.data.poolSize || 100;
        const connUsage = (activeConn / maxConn) * 100;

        document.getElementById('connActive').textContent = activeConn;
        document.getElementById('connMax').textContent = maxConn;
        document.getElementById('connBar').style.width = connUsage + '%';
        setStatus(document.getElementById('connStatus'), connUsage, 70, 90, true);

        document.getElementById('connAvail').textContent = conn.data.availableConnections || '0';
        document.getElementById('connWaiting').textContent = conn.data.waitingConnections || '0';
        document.getElementById('connPool').textContent = `${conn.data.minPoolSize || 0}-${conn.data.poolSize || 0}`;

        // --- System ---
        const sysData = sys.data;
        const usedMemMB = Math.round(sysData.memory.rss / 1024 / 1024);
        const totalMemMB = Math.round(sysData.memory.heapTotal / 1024 / 1024);

        document.getElementById('sysMem').textContent = formatBytes(sysData.memory.rss);
        document.getElementById('sysTotalMem').textContent = formatBytes(sysData.memory.heapTotal);
        const memUsagePercent = (sysData.memory.heapUsed / sysData.memory.heapTotal) * 100;
        document.getElementById('sysBar').style.width = memUsagePercent + '%';
        setStatus(document.getElementById('sysStatus'), memUsagePercent, 70, 85, true);

        document.getElementById('sysNode').textContent = 'v18+';
        document.getElementById('sysUptime').textContent = sysData.uptime.formatted;
        document.getElementById('sysPlatform').textContent = 'Linux';

        document.getElementById('detailHeapUsed').textContent = sysData.memory.formatted.heapUsed;
        document.getElementById('detailHeapTotal').textContent = sysData.memory.formatted.heapTotal;
        document.getElementById('detailRss').textContent = sysData.memory.formatted.rss;

        // Update timestamp
        const now = new Date().toLocaleTimeString();
        const tsEl = document.getElementById('timestamp');
        if (tsEl) tsEl.textContent = `Updated: ${now}`;

    } catch (error) {
        console.error('Metrics refresh failed:', error);
    }
}

async function clearCache() {
    if (!confirm('Clear embedding cache? This will reset all cache statistics.')) return;
    try {
        await fetch('/api/metrics/cache/clear', { method: 'POST' });
        logEvent('Cache cleared successfully', 'success');
        refreshSystemMetrics();
    } catch (e) {
        logEvent('Failed to clear cache', 'error');
    }
}

// --- INITIALIZATION ---

function handleTabSwitch(tabId) {
    activeTab = tabId;

    // UI Update
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.toggle('active', content.id === `${tabId}-tab`));

    // Interval Management
    if (metricsInterval) clearInterval(metricsInterval);

    if (tabId === 'overview') {
        updateOverviewStats();
    } else if (tabId === 'system') {
        refreshSystemMetrics();
        metricsInterval = setInterval(refreshSystemMetrics, 5000);
    } else if (tabId === 'n8n') {
        document.getElementById('initTime').textContent = new Date().toLocaleTimeString();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Health checks are global (sidebar)
    updateHealthStatus();
    healthInterval = setInterval(updateHealthStatus, 30000);

    // Tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => handleTabSwitch(btn.dataset.tab));
    });

    // n8n Listeners
    const triggerBtn = document.getElementById('triggerWebhookBtn');
    if (triggerBtn) triggerBtn.addEventListener('click', handleWebhookTrigger);

    const clearLogBtn = document.getElementById('clearEventLogBtn');
    if (clearLogBtn) clearLogBtn.addEventListener('click', () => {
        const log = document.getElementById('eventLog');
        if (log) log.innerHTML = '';
        logEvent('Log cleared', 'info');
    });

    const workflowSelector = document.getElementById('workflowSelector');
    if (workflowSelector) {
        workflowSelector.addEventListener('change', (e) => {
            const customDiv = document.getElementById('customWebhookDiv');
            customDiv.style.display = e.target.value === 'custom' ? 'block' : 'none';
        });
    }

    // System Metrics Listeners
    const clearCacheBtn = document.getElementById('clearCacheBtn');
    if (clearCacheBtn) clearCacheBtn.addEventListener('click', clearCache);

    // Default tab
    handleTabSwitch('overview');
});

// Setup function for the sidebar collections
window.setupDashboardInteractions = function () {
    const cards = document.querySelectorAll('.summary-card');
    cards.forEach(card => {
        card.addEventListener('click', function () {
            cards.forEach(c => c.classList.remove('selected'));
            this.classList.add('selected');
            // In the unified dashboard, clicking a card could show collection details if we implement it.
            logEvent(`Navigating to collection: ${this.dataset.collection}`, 'info');
        });
    });
};
