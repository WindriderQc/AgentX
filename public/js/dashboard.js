// AgentX Unified Operations Center Logic
// Single-page dashboard - no tabs, all sections visible
import { API } from './utils/index.js';

let metricsInterval = null;
let healthInterval = null;
let eventsInterval = null;

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

function timeAgo(date) {
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
}

// --- HEALTH LOGIC ---

async function updateHealthStatus() {
    try {
        // 1. AgentX Health (Local)
        const localHealth = await API.get('/health');
        const agentxDot = document.querySelector('#health-agentx .dot');
        if (agentxDot) {
            agentxDot.classList.toggle('online', localHealth.status === 'ok');
            agentxDot.classList.toggle('offline', localHealth.status !== 'ok');
        }

        // 2. MongoDB Health (via /api/dashboard/health)
        const dashHealth = await API.get('/api/dashboard/health');
        const mongoDot = document.querySelector('#health-mongodb .dot');
        if (mongoDot) {
            const mongoOk = dashHealth.data?.mongodb?.status === 'connected';
            mongoDot.classList.toggle('online', mongoOk);
            mongoDot.classList.toggle('offline', !mongoOk);
        }

        // 3. External Health (Ollama, DataAPI, n8n via aggregated endpoint)
        const externalHealth = await API.get('/api/health/external');

        const map = {
            ollama: '#health-ollama',
            dataapi: '#health-dataapi',
            n8n: '#health-n8n'
        };

        for (const [key, selector] of Object.entries(map)) {
            const dot = document.querySelector(`${selector} .dot`);
            if (dot) {
                const isOk = externalHealth[key]?.status === 'ok';
                dot.classList.toggle('online', isOk);
                dot.classList.toggle('offline', !isOk);
            }
        }

    } catch (error) {
        console.error('Health check failed:', error);
    }
}

// --- OVERVIEW / QUICK STATS LOGIC ---

async function updateQuickStats() {
    try {
        // Get collection stats for document count
        const stats = await API.get('/api/dashboard/stats');
        const totalDocs = stats.data.reduce((sum, s) => sum + s.count, 0);

        const elTotal = document.getElementById('db-total-docs');
        if (elTotal) elTotal.textContent = formatNumber(totalDocs);

        // System metrics for overview cards
        const sys = await API.get('/api/metrics/system');
        const uptimeEl = document.getElementById('sys-uptime');
        
        if (uptimeEl) uptimeEl.textContent = sys.data.uptime.formatted;

        // Memory metric card with bar and status
        const memEl = document.getElementById('sys-mem');
        const sysBar = document.getElementById('sysBar');
        const sysTotalMem = document.getElementById('sysTotalMem');
        const sysStatus = document.getElementById('sysStatus');
        
        if (memEl && sys.data.memory) {
            const heapUsed = (sys.data.memory.heapUsed / (1024 * 1024)).toFixed(2);
            const heapTotal = (sys.data.memory.heapTotal / (1024 * 1024)).toFixed(2);
            const memPct = ((sys.data.memory.heapUsed / sys.data.memory.heapTotal) * 100);
            
            memEl.textContent = `${heapUsed} MB`;
            if (sysTotalMem) sysTotalMem.textContent = `${heapTotal} MB`;
            if (sysBar) sysBar.style.width = `${memPct}%`;
            if (sysStatus) {
                sysStatus.className = 'status-dot ' + (memPct > 90 ? 'error' : memPct > 80 ? 'warning' : 'healthy');
            }
        }

        // Cache hit rate metric card with bar
        const cache = await API.get('/api/metrics/cache');
        const hitRate = (cache.data.cache.hitRate * 100).toFixed(0);
        const hitRateEl = document.getElementById('cache-hit-rate');
        const cacheBar = document.getElementById('cacheBar');
        const cacheStatus = document.getElementById('cacheStatus');
        const cacheHits = document.getElementById('cacheHits');
        const cacheMisses = document.getElementById('cacheMisses');
        
        if (hitRateEl) hitRateEl.textContent = hitRate + '%';
        if (cacheBar) cacheBar.style.width = hitRate + '%';
        if (cacheStatus) {
            cacheStatus.className = 'status-dot ' + (hitRate >= 80 ? 'healthy' : hitRate >= 50 ? 'warning' : 'error');
        }
        if (cacheHits) cacheHits.textContent = formatNumber(cache.data.cache.hits || 0);
        if (cacheMisses) cacheMisses.textContent = formatNumber(cache.data.cache.misses || 0);

        // Database connections metric card with bar
        const db = await API.get('/api/metrics/database');
        const connActive = document.getElementById('connActive');
        const connMax = document.getElementById('connMax');
        const connAvail = document.getElementById('connAvail');
        const connBar = document.getElementById('connBar');
        const connStatus = document.getElementById('connStatus');
        
        if (db.data.connections && connActive && connMax) {
            const active = db.data.connections.current || 0;
            const max = db.data.connections.max || 10;
            const avail = db.data.connections.available || 0;
            const connPct = (active / max) * 100;
            
            connActive.textContent = active;
            connMax.textContent = max;
            if (connAvail) connAvail.textContent = avail;
            if (connBar) connBar.style.width = `${connPct}%`;
            if (connStatus) {
                connStatus.className = 'status-dot ' + (connPct > 90 ? 'error' : connPct > 75 ? 'warning' : 'healthy');
            }
        }

    } catch (error) {
        console.error('Quick stats refresh failed:', error);
    }
}

async function updateSystemEvents() {
    const container = document.getElementById('system-events-list');
    if (!container) return;

    try {
        const response = await API.get('/api/events/system?limit=15');
        const events = response.data;

        if (!events || events.length === 0) {
            container.innerHTML = `
                <div class="event-row">
                    <div class="event-content">
                        <div class="event-message" style="color: var(--muted);">No recent events.</div>
                    </div>
                </div>`;
            return;
        }

        container.innerHTML = events.map(event => `
            <div class="event-row">
                <div class="event-indicator ${getEventType(event.type)}"></div>
                <div class="event-content">
                    <div class="event-message">${escapeHtml(event.message)}</div>
                    <div class="event-time">${timeAgo(event.timestamp)}</div>
                </div>
            </div>
        `).join('');

    } catch (error) {
        console.error('Failed to fetch system events:', error);
        container.innerHTML = `
            <div class="event-row">
                <div class="event-indicator error"></div>
                <div class="event-content">
                    <div class="event-message">Failed to load events</div>
                    <div class="event-time">${error.message}</div>
                </div>
            </div>`;
    }
}

function getEventType(type) {
    switch (type?.toLowerCase()) {
        case 'error': return 'error';
        case 'warn':
        case 'warning': return 'warn';
        case 'success': return 'success';
        case 'info':
        default: return 'info';
    }
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// --- N8N WEBHOOK LOGIC ---

function showWebhookResult(message, isError = false) {
    const resultDiv = document.getElementById('triggerResult');
    if (!resultDiv) return;
    
    resultDiv.classList.add('visible');
    resultDiv.style.color = isError ? '#f87171' : '#4ade80';
    resultDiv.innerHTML = message;
}

// Update workflow description based on selection
function updateWorkflowDescription(workflow) {
    const descriptions = {
        'n1-3': 'Diagnose system health using AgentX (Ops Persona)',
        'n2-3': 'Trigger RAG ingestion for documents',
        'n3-2': 'Gateway for external tools to query AgentX',
        'n5-1': 'Analyze feedback and optimize prompts',
        'agentmail': 'Processes email using AI agent with Gmail integration',
        'rag-ingest': 'Ingests documents into the RAG vector store for AI knowledge',
        'chat-complete': 'Tests AI chat completion with AgentX backend',
        'analytics': 'Logs analytics events to MongoDB for tracking',
        'custom': 'Use any n8n webhook UUID or full URL'
    };
    
    const descDiv = document.getElementById('workflowDescription');
    if (descDiv) {
        descDiv.textContent = descriptions[workflow] || 'Select a workflow to see description';
    }

    // Update URL display
    const urlDiv = document.getElementById('workflowUrlDisplay');
    if (urlDiv) {
        const endpointMap = {
            'n1-3': 'sbqc-ops-diagnostic',
            'n2-3': 'sbqc-n2-3-rag-ingest',
            'n3-2': 'sbqc-ai-query',
            'n5-1': 'sbqc-n5-1-feedback-analysis'
        };
        
        let url = '';
        if (workflow === 'custom') {
            url = '(Enter custom UUID or URL below)';
        } else if (workflow === 'agentmail') {
            url = 'POST https://n8n.specialblend.icu/webhook/c1deca83-ecb4-48ad-b485-59195cee9a61';
        } else if (endpointMap[workflow]) {
            url = `POST /api/n8n/trigger/${endpointMap[workflow]}`;
        } else {
            url = `POST /api/n8n/${workflow}`;
        }
        urlDiv.textContent = url;
    }
}

// Update payload example based on workflow type
function updatePayloadExample(workflow) {
    const examples = {
        'n1-3': JSON.stringify({
            source: 'dashboard-test'
        }, null, 2),
        'n2-3': JSON.stringify({
            directories: [
                { path: '/mnt/smb/Docs', pattern: '*.md', source: 'nas-docs' }
            ]
        }, null, 2),
        'n3-2': JSON.stringify({
            body: {
                message: 'Hello AgentX, are you online?',
                model: 'qwen2.5:7b-instruct-q4_0',
                useRag: false
            }
        }, null, 2),
        'n5-1': JSON.stringify({
            source: 'manual-trigger'
        }, null, 2),
        'agentmail': JSON.stringify({
            event: 'email_check',
            source: 'ops-center',
            action: 'process_inbox'
        }, null, 2),
        'rag-ingest': JSON.stringify({
            event: 'document_ingest',
            source: '/mnt/smb/Docs',
            fileTypes: ['md', 'txt', 'pdf']
        }, null, 2),
        'chat-complete': JSON.stringify({
            message: 'What is the SBQC stack?',
            model: 'llama3.1',
            stream: false
        }, null, 2),
        'analytics': JSON.stringify({
            event: 'user_action',
            action: 'dashboard_view',
            timestamp: new Date().toISOString()
        }, null, 2),
        'custom': JSON.stringify({
            event: 'test_trigger',
            source: 'ops-center'
        }, null, 2)
    };
    
    const textarea = document.getElementById('webhookPayload');
    if (textarea) {
        textarea.value = examples[workflow] || examples['custom'];
    }
}

async function handleWebhookTrigger() {
    const selector = document.getElementById('workflowSelector');
    const payloadRaw = document.getElementById('webhookPayload').value;

    let payload;
    try {
        payload = JSON.parse(payloadRaw);
    } catch (e) {
        showWebhookResult('Invalid JSON payload', true);
        return;
    }

    showWebhookResult('Triggering...');

    try {
        let endpoint;
        
        // Map friendly names to webhook IDs/Paths
        const endpointMap = {
            'n1-3': 'sbqc-ops-diagnostic',
            'n2-3': 'sbqc-n2-3-rag-ingest',
            'n3-2': 'sbqc-ai-query',
            'n5-1': 'sbqc-n5-1-feedback-analysis'
        };

        if (selector.value === 'agentmail') {
            endpoint = 'https://n8n.specialblend.icu/webhook/c1deca83-ecb4-48ad-b485-59195cee9a61';
        } else if (selector.value === 'custom') {
            const customId = document.getElementById('customWebhookId').value.trim();
            endpoint = customId.startsWith('http') ? customId : `/api/n8n/trigger/${customId}`;
        } else if (endpointMap[selector.value]) {
            endpoint = `/api/n8n/trigger/${endpointMap[selector.value]}`;
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
            showWebhookResult(`✓ Success\n${JSON.stringify(result, null, 2)}`);
        } else {
            showWebhookResult(`✗ Error ${response.status}\n${JSON.stringify(result, null, 2)}`, true);
        }
    } catch (error) {
        showWebhookResult(`Network Error: ${error.message}`, true);
    }
}

// --- SYSTEM METRICS LOGIC ---

function setStatusDot(el, val, healthyThreshold = 70, warningThreshold = 90, reverse = false) {
    if (!el) return;
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
        const [cache, conn, sys] = await Promise.all([
            API.get('/api/metrics/cache'),
            API.get('/api/metrics/connection'),
            API.get('/api/metrics/system')
        ]);

        // --- Cache ---
        const cacheData = cache.data.cache;
        const hitRate = (cacheData.hitRate * 100);
        
        const elHitRate = document.getElementById('cacheHitRate');
        if (elHitRate) {
            elHitRate.textContent = hitRate.toFixed(0) + '%';
            const barEl = document.getElementById('cacheBar');
            if (barEl) barEl.style.width = hitRate + '%';
            setStatusDot(document.getElementById('cacheStatus'), hitRate, 70, 50);
        }

        const hitsEl = document.getElementById('cacheHits');
        const missEl = document.getElementById('cacheMisses');
        if (hitsEl) hitsEl.textContent = formatNumber(cacheData.hitCount);
        if (missEl) missEl.textContent = formatNumber(cacheData.missCount);

        // --- Connections ---
        const activeConn = conn.data.activeConnections || 0;
        const maxConn = conn.data.poolSize || 100;
        const connUsage = (activeConn / maxConn) * 100;

        const connActiveEl = document.getElementById('connActive');
        const connMaxEl = document.getElementById('connMax');
        const connAvailEl = document.getElementById('connAvail');
        const connBarEl = document.getElementById('connBar');

        if (connActiveEl) connActiveEl.textContent = activeConn;
        if (connMaxEl) connMaxEl.textContent = maxConn;
        if (connBarEl) connBarEl.style.width = connUsage + '%';
        if (connAvailEl) connAvailEl.textContent = conn.data.availableConnections || '0';
        setStatusDot(document.getElementById('connStatus'), connUsage, 70, 90, true);

        // --- System ---
        const sysData = sys.data;
        const heapUsedMB = Math.round(sysData.memory.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.round(sysData.memory.heapTotal / 1024 / 1024);
        const memUsagePercent = (sysData.memory.heapUsed / sysData.memory.heapTotal) * 100;

        const heapUsedEl = document.getElementById('heapUsed');
        const heapTotalEl = document.getElementById('heapTotal');
        const sysBarEl = document.getElementById('sysBar');
        const sysNodeEl = document.getElementById('sysNode');
        const sysPlatformEl = document.getElementById('sysPlatform');

        if (heapUsedEl) heapUsedEl.textContent = heapUsedMB + ' MB';
        if (heapTotalEl) heapTotalEl.textContent = heapTotalMB + ' MB';
        if (sysBarEl) sysBarEl.style.width = memUsagePercent + '%';
        if (sysNodeEl) sysNodeEl.textContent = sysData.nodeVersion || 'v18+';
        if (sysPlatformEl) sysPlatformEl.textContent = sysData.platform || 'Linux';
        setStatusDot(document.getElementById('sysStatus'), memUsagePercent, 80, 90, true);

    } catch (error) {
        console.error('Metrics refresh failed:', error);
    }
}

async function loadCollections() {
    const container = document.getElementById('collections-list');
    if (!container) return;

    try {
        const stats = await API.get('/api/dashboard/stats');
        
        if (!stats.data || stats.data.length === 0) {
            container.innerHTML = '<div class="collection-item"><span style="color: var(--muted);">No collections</span></div>';
            return;
        }

        container.innerHTML = stats.data.map(coll => `
            <div class="collection-item">
                <div class="collection-info">
                    <span class="name">${coll.collection}</span>
                    <span class="db">${coll.database || 'agentx'}</span>
                </div>
                <span class="count">${formatNumber(coll.count)}</span>
            </div>
        `).join('');
    } catch (error) {
        console.error('Failed to load collections:', error);
        container.innerHTML = '<div class="collection-item"><span style="color: #f87171;">Failed to load</span></div>';
    }
}

// --- INITIALIZATION ---

document.addEventListener('DOMContentLoaded', () => {
    // Initial data load
    updateHealthStatus();
    updateQuickStats();
    updateSystemEvents();
    refreshSystemMetrics();
    loadCollections();

    // Periodic updates
    healthInterval = setInterval(updateHealthStatus, 30000);
    eventsInterval = setInterval(updateSystemEvents, 60000);
    metricsInterval = setInterval(refreshSystemMetrics, 10000);

    // n8n Webhook Listeners
    const triggerBtn = document.getElementById('triggerWebhookBtn');
    if (triggerBtn) triggerBtn.addEventListener('click', handleWebhookTrigger);

    const workflowSelector = document.getElementById('workflowSelector');
    if (workflowSelector) {
        workflowSelector.addEventListener('change', (e) => {
            const customDiv = document.getElementById('customWebhookDiv');
            if (customDiv) customDiv.style.display = e.target.value === 'custom' ? 'block' : 'none';
            updateWorkflowDescription(e.target.value);
            updatePayloadExample(e.target.value);
        });
    }

    // n8n Help toggle
    const n8nHelpBtn = document.getElementById('n8nHelpBtn');
    const n8nHelpBanner = document.getElementById('n8nHelpBanner');
    if (n8nHelpBtn && n8nHelpBanner) {
        n8nHelpBtn.addEventListener('click', () => {
            const isVisible = n8nHelpBanner.style.display !== 'none';
            n8nHelpBanner.style.display = isVisible ? 'none' : 'block';
        });
    }

    // Payload action buttons
    const formatJsonBtn = document.getElementById('formatJsonBtn');
    if (formatJsonBtn) {
        formatJsonBtn.addEventListener('click', () => {
            const textarea = document.getElementById('webhookPayload');
            try {
                const parsed = JSON.parse(textarea.value);
                textarea.value = JSON.stringify(parsed, null, 2);
            } catch (e) {
                alert('Invalid JSON - cannot format');
            }
        });
    }

    const examplePayloadBtn = document.getElementById('examplePayloadBtn');
    if (examplePayloadBtn) {
        examplePayloadBtn.addEventListener('click', () => {
            const workflow = document.getElementById('workflowSelector').value;
            updatePayloadExample(workflow);
        });
    }

    const clearPayloadBtn = document.getElementById('clearPayloadBtn');
    if (clearPayloadBtn) {
        clearPayloadBtn.addEventListener('click', () => {
            document.getElementById('webhookPayload').value = '{}';
        });
    }

    // Refresh buttons
    const refreshEventsBtn = document.getElementById('refreshEventsBtn');
    if (refreshEventsBtn) refreshEventsBtn.addEventListener('click', updateSystemEvents);

    const refreshMetricsBtn = document.getElementById('refreshMetricsBtn');
    if (refreshMetricsBtn) {
        refreshMetricsBtn.addEventListener('click', () => {
            refreshSystemMetrics();
            loadCollections();
        });
    }
});
