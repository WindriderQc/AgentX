const elements = {
  // Product Analytics Elements
  periodSelect: document.getElementById('periodSelect'),
  usageGroupSelect: document.getElementById('usageGroupSelect'),
  feedbackGroupSelect: document.getElementById('feedbackGroupSelect'),
  refreshBtn: document.getElementById('refreshBtn'),
  totalConversations: document.getElementById('totalConversations'),
  totalMessages: document.getElementById('totalMessages'),
  positiveFeedback: document.getElementById('positiveFeedback'),
  positiveRate: document.getElementById('positiveRate'),
  ragUsage: document.getElementById('ragUsage'),
  ragConversations: document.getElementById('ragConversations'),
  noRagConversations: document.getElementById('noRagConversations'),
  ragPositiveRate: document.getElementById('ragPositiveRate'),
  noRagPositiveRate: document.getElementById('noRagPositiveRate'),
  ragDelta: document.getElementById('ragDelta'),
  ragDonutLabel: document.getElementById('ragDonutLabel'),
  usageEmpty: document.getElementById('usageEmpty'),
  feedbackEmpty: document.getElementById('feedbackEmpty'),

  // RAG Metrics Elements
  refreshRagBtn: document.getElementById('refreshRagBtn'),
  ragTotalDocs: document.getElementById('ragTotalDocs'),
  ragTotalChunks: document.getElementById('ragTotalChunks'),
  ragAvgChunks: document.getElementById('ragAvgChunks'),
  ragHealth: document.getElementById('ragHealth'),
  ragSourcesBody: document.getElementById('ragSourcesBody'),
  ragOldest: document.getElementById('ragOldest'),
  ragNewest: document.getElementById('ragNewest'),
  ragEmpty: document.getElementById('ragEmpty'),

  // System Metrics Elements
  // clearCacheBtn: document.getElementById('clearCacheBtn'), // Removed in single-page view
  timestamp: document.getElementById('sysTimestamp'), // Updated ID
  // Cache
  cacheStatus: document.getElementById('cacheStatus'),
  cacheHitRate: document.getElementById('cacheHitRate'),
  cacheBar: document.getElementById('cacheBar'),
  cacheHits: document.getElementById('cacheHits'),
  cacheMisses: document.getElementById('cacheMisses'),
  cacheSize: document.getElementById('cacheSize'),
  cacheMem: document.getElementById('cacheMem'),
  // DB
  dbTotalDocs: document.getElementById('dbTotalDocs'),
  dbConversations: document.getElementById('dbConversations'),
  dbPrompts: document.getElementById('dbPrompts'),
  dbUsers: document.getElementById('dbUsers'),
  dbIndexes: document.getElementById('dbIndexes'),
  // Conn
  connStatus: document.getElementById('connStatus'),
  connActive: document.getElementById('connActive'),
  connMax: document.getElementById('connMax'),
  connBar: document.getElementById('connBar'),
  connAvail: document.getElementById('connAvail'),
  connWaiting: document.getElementById('connWaiting'),
  connPool: document.getElementById('connPool'),
  // System
  sysStatus: document.getElementById('sysStatus'),
  sysMem: document.getElementById('sysMem'),
  sysTotalMem: document.getElementById('sysTotalMem'),
  sysBar: document.getElementById('sysBar'),
  sysNode: document.getElementById('sysNode'),
  sysUptime: document.getElementById('sysUptime'),
  sysPlatform: document.getElementById('sysPlatform'),
  // Details
  detailCacheTotal: document.getElementById('detailCacheTotal'),
  detailCacheAvg: document.getElementById('detailCacheAvg'),
  detailCacheEvict: document.getElementById('detailCacheEvict'),
  detailDbName: document.getElementById('detailDbName'),
  detailDbHost: document.getElementById('detailDbHost'),
  detailDbCollections: document.getElementById('detailDbCollections'),
  detailHeapUsed: document.getElementById('detailHeapUsed'),
  detailHeapTotal: document.getElementById('detailHeapTotal'),
  detailRss: document.getElementById('detailRss'),
};

const charts = {
  usage: null,
  feedback: null,
  rag: null,
};

let systemInterval = null;

/* -------------------------------------------------------------------------- */
/*                                Utility Fns                                 */
/* -------------------------------------------------------------------------- */

function formatNumber(num) {
  if (num === null || num === undefined) return '–';
  return num.toLocaleString();
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return `${(value * 100).toFixed(1)}%`;
}

function formatBytes(bytes) {
  if (bytes === 0 || bytes === undefined) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function periodRange(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - Number(days));
  return { from, to };
}

async function fetchJSON(url, method = 'GET') {
  const res = await fetch(url, { method, credentials: 'include' });
  if (res.status === 401) {
    window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  
  // Check if response is actually JSON
  const contentType = res.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(`Expected JSON but got ${contentType}: ${text.substring(0, 100)}`);
  }
  
  return res.json();
}

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (!res.ok) {
      window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
      return false;
    }
    return true;
  } catch (error) {
    window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                            Product Analytics Logic                         */
/* -------------------------------------------------------------------------- */

function buildRangeQuery(days) {
  const { from, to } = periodRange(days);
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
  });
  return params.toString();
}

async function loadUsage(days, groupBy) {
  const query = buildRangeQuery(days);
  const qs = new URLSearchParams(`${query}&groupBy=${groupBy}`);
  const response = await fetchJSON(`/api/analytics/usage?${qs.toString()}`);
  return response.data;
}

async function loadFeedback(days, groupBy) {
  const query = buildRangeQuery(days);
  const qs = new URLSearchParams(`${query}&groupBy=${groupBy}`);
  const response = await fetchJSON(`/api/analytics/feedback?${qs.toString()}`);
  return response.data;
}

async function loadRag(days) {
  const query = buildRangeQuery(days);
  const response = await fetchJSON(`/api/analytics/rag-stats?${query}`);
  return response.data;
}

function renderUsageChart(data, groupBy) {
  const labels = data.breakdown.map((item) => {
    if (groupBy === 'day') return item.date;
    if (groupBy === 'model') return item.model || 'Unknown model';
    return item.promptVersion || 'No version';
  });

  const conversations = data.breakdown.map((item) => item.conversations || 0);
  const messages = data.breakdown.map((item) => item.messages || 0);

  const ctx = document.getElementById('usageChart').getContext('2d');
  if (charts.usage) charts.usage.destroy();

  charts.usage = new Chart(ctx, {
    type: groupBy === 'day' ? 'line' : 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Conversations',
          data: conversations,
          borderColor: '#7cf0ff',
          backgroundColor: 'rgba(124, 240, 255, 0.35)',
          tension: 0.3,
        },
        {
          label: 'Messages',
          data: messages,
          borderColor: '#eeb0ff',
          backgroundColor: 'rgba(238, 176, 255, 0.3)',
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'top' },
      },
      scales: {
        y: { beginAtZero: true },
      },
    },
  });
}

function renderFeedbackChart(data, groupBy) {
  const labels = data.breakdown.map((item) => {
    if (groupBy === 'model') return item.model || 'Unknown model';
    return `${item.promptName || 'Prompt'} v${item.promptVersion || '–'}`;
  });

  const positive = data.breakdown.map((item) => item.positive || 0);
  const negative = data.breakdown.map((item) => item.negative || 0);

  const ctx = document.getElementById('feedbackChart').getContext('2d');
  if (charts.feedback) charts.feedback.destroy();

  charts.feedback = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Positive',
          data: positive,
          backgroundColor: 'rgba(124, 240, 255, 0.6)',
          borderColor: '#7cf0ff',
          stack: 'feedback',
        },
        {
          label: 'Negative',
          data: negative,
          backgroundColor: 'rgba(255, 99, 132, 0.5)',
          borderColor: '#ff6384',
          stack: 'feedback',
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'top' },
      },
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true },
      },
    },
  });
}

function renderRagChart(data) {
  const ctx = document.getElementById('ragDonut').getContext('2d');
  if (charts.rag) charts.rag.destroy();

  const { ragConversations, noRagConversations } = data;
  const labels = ['RAG', 'Non-RAG'];
  const values = [ragConversations, noRagConversations];

  charts.rag = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: ['rgba(124, 240, 255, 0.7)', 'rgba(238, 176, 255, 0.35)'],
          borderColor: ['#7cf0ff', '#eeb0ff'],
          borderWidth: 1,
        },
      ],
    },
    options: {
      cutout: '70%',
      plugins: {
        legend: { position: 'bottom' },
      },
    },
  });

  elements.ragDonutLabel.textContent = formatPercent(data.ragUsageRate);
}

function updateProductSummary(usage, feedback, rag) {
  elements.totalConversations.textContent = formatNumber(usage.totalConversations);
  elements.totalMessages.textContent = formatNumber(usage.totalMessages);
  elements.positiveFeedback.textContent = formatNumber(feedback.positive);
  elements.positiveRate.textContent = feedback.totalFeedback > 0 ? `(${formatPercent(feedback.positiveRate)} positive)` : '(no feedback)';
  elements.ragUsage.textContent = formatPercent(rag.ragUsageRate);
  elements.ragConversations.textContent = formatNumber(rag.ragConversations);
  elements.noRagConversations.textContent = formatNumber(rag.noRagConversations);
  elements.ragPositiveRate.textContent = formatPercent(rag.feedback.rag.positiveRate);
  elements.noRagPositiveRate.textContent = formatPercent(rag.feedback.noRag.positiveRate);
  const delta = rag.feedback.rag.positiveRate - rag.feedback.noRag.positiveRate;
  elements.ragDelta.textContent = Number.isFinite(delta) ? `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)} pts` : '–';
}

function toggleEmptyState(container, emptyEl, hasData) {
  if (hasData) {
    container.style.display = 'block';
    emptyEl.style.display = 'none';
  } else {
    container.style.display = 'none';
    emptyEl.style.display = 'block';
  }
}

async function refreshProduct() {
  const days = elements.periodSelect.value;
  const usageGroup = elements.usageGroupSelect.value;
  const feedbackGroup = elements.feedbackGroupSelect.value;

  try {
    const [usage, feedback, rag] = await Promise.all([
      loadUsage(days, usageGroup),
      loadFeedback(days, feedbackGroup),
      loadRag(days),
    ]);

    updateProductSummary(usage, feedback, rag);

    const usageHasData = usage.breakdown && usage.breakdown.length > 0;
    toggleEmptyState(document.getElementById('usageChart'), elements.usageEmpty, usageHasData);
    if (usageHasData) renderUsageChart(usage, usageGroup);

    const feedbackHasData = feedback.breakdown && feedback.breakdown.length > 0;
    toggleEmptyState(document.getElementById('feedbackChart'), elements.feedbackEmpty, feedbackHasData);
    if (feedbackHasData) renderFeedbackChart(feedback, feedbackGroup);

    const ragHasData = rag.totalConversations > 0;
    if (ragHasData) {
      renderRagChart(rag);
    } else {
      elements.ragDonutLabel.textContent = '–';
    }
  } catch (err) {
    console.error('Analytics load failed', err);
    // Don't alert aggressively on auto-refresh or tab switches, just log
  }
}

/* -------------------------------------------------------------------------- */
/*                            System Metrics Logic                            */
/* -------------------------------------------------------------------------- */

async function refreshSystem() {
  try {
     const [cache, database, connection, system] = await Promise.all([
      fetchJSON('/api/metrics/cache'),
      fetchJSON('/api/metrics/database'),
      fetchJSON('/api/metrics/connection'),
      fetchJSON('/api/metrics/system')
    ]);

    renderSystemMetrics({ cache, database, connection, system });
    updateTimestamp();

  } catch (err) {
    console.error('System metrics load failed', err);
  }
}

function updateTimestamp() {
  const now = new Date().toLocaleTimeString();
  elements.timestamp.textContent = `Updated: ${now}`;
}

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

function renderSystemMetrics(metrics) {
    const cache = metrics.cache.data.cache;
    const db = metrics.database.data;
    const conn = metrics.connection.data;
    const sys = metrics.system.data;

    // --- Cache ---
    const hitRate = (cache.hitRate * 100);
    elements.cacheHitRate.textContent = hitRate.toFixed(1) + '%';
    elements.cacheBar.style.width = `${hitRate}%`;
    setStatus(elements.cacheStatus, hitRate, 70, 50);

    elements.cacheHits.textContent = formatNumber(cache.hitCount);
    elements.cacheMisses.textContent = formatNumber(cache.missCount);
    elements.cacheSize.textContent = `${cache.size}/${cache.maxSize || '∞'}`;
    elements.cacheMem.textContent = formatBytes(cache.memorySizeBytes);

    elements.detailCacheTotal.textContent = formatNumber(cache.hitCount + cache.missCount);
    elements.detailCacheAvg.textContent = formatBytes(cache.avgEntrySizeBytes);
    elements.detailCacheEvict.textContent = formatNumber(cache.evictions);

    // --- Database ---
    const totalDocs = Object.values(db.collections).reduce((a, b) => a + (b.count || 0), 0);
    elements.dbTotalDocs.textContent = formatNumber(totalDocs);
    elements.dbConversations.textContent = formatNumber(db.collections.conversations?.count);
    elements.dbPrompts.textContent = formatNumber(db.collections.promptConfigs?.count);
    elements.dbUsers.textContent = formatNumber(db.collections.userProfiles?.count);
    elements.dbIndexes.textContent = db.database.indexes;

    elements.detailDbName.textContent = db.database.name;
    elements.detailDbHost.textContent = conn.host; // Conn has host info
    elements.detailDbCollections.textContent = Object.keys(db.collections).length;

    // --- Connections ---
    const activeConn = conn.activeConnections || 0;
    const maxConn = conn.poolSize || 100;
    const connUsage = (activeConn / maxConn) * 100;

    elements.connActive.textContent = activeConn;
    elements.connMax.textContent = maxConn;
    elements.connBar.style.width = `${connUsage}%`;
    setStatus(elements.connStatus, connUsage, 70, 90, true); // Reverse: lower usage is better/healthy until 70%

    elements.connAvail.textContent = conn.availableConnections;
    elements.connWaiting.textContent = conn.waitingConnections;
    elements.connPool.textContent = `${conn.minPoolSize}-${conn.poolSize}`;

    // --- System ---
    // Use heap metrics consistently for the Memory (Heap) display
    elements.sysMem.textContent = formatBytes(sys.memory.heapUsed);
    elements.sysTotalMem.textContent = formatBytes(sys.memory.heapTotal);
    const memUsagePercent = (sys.memory.heapUsed / sys.memory.heapTotal) * 100;
    elements.sysBar.style.width = `${memUsagePercent}%`;
    setStatus(elements.sysStatus, memUsagePercent, 80, 90, true);

    // Safe access to optional elements
    if (elements.sysNode) elements.sysNode.textContent = sys.nodeVersion || 'v18+';
    if (elements.sysUptime) elements.sysUptime.textContent = sys.uptime.formatted;
    if (elements.sysPlatform) elements.sysPlatform.textContent = sys.platform || 'Linux';

    if (elements.detailHeapUsed) elements.detailHeapUsed.textContent = sys.memory.formatted.heapUsed;
    if (elements.detailHeapTotal) elements.detailHeapTotal.textContent = sys.memory.formatted.heapTotal;
    if (elements.detailRss) elements.detailRss.textContent = sys.memory.formatted.rss;
}

async function clearCache() {
    if (!confirm('Clear embedding cache? This will reset all cache statistics.')) return;
    try {
        await fetchJSON('/api/metrics/cache/clear', 'POST');
        refreshSystem();
    } catch (e) {
        alert('Failed to clear cache');
    }
}

/* -------------------------------------------------------------------------- */
/*                              RAG Metrics                                   */
/* -------------------------------------------------------------------------- */

async function refreshRagMetrics() {
    try {
        const data = await fetchJSON('/api/rag/metrics');
        
        if (!data || !data.stats) {
            if (elements.ragEmpty) elements.ragEmpty.style.display = 'block';
            return;
        }
        
        if (elements.ragEmpty) elements.ragEmpty.style.display = 'none';
        
        const stats = data.stats;
        
        // Update stats cards
        if (elements.ragTotalDocs) {
            elements.ragTotalDocs.textContent = formatNumber(stats.totalDocuments || 0);
        }
        if (elements.ragTotalChunks) {
            elements.ragTotalChunks.textContent = formatNumber(stats.totalChunks || 0);
        }
        if (elements.ragAvgChunks) {
            elements.ragAvgChunks.textContent = stats.avgChunksPerDoc || '0';
        }
        if (elements.ragHealth) {
            const healthIcon = data.healthy ? '✓' : '✗';
            const healthColor = data.healthy ? 'var(--success)' : 'var(--danger)';
            elements.ragHealth.innerHTML = `<span style="color: ${healthColor}">${healthIcon} ${data.healthy ? 'Healthy' : 'Offline'}</span>`;
        }
        
        // Update source breakdown table
        if (elements.ragSourcesBody && stats.sourceBreakdown) {
            const sources = Object.entries(stats.sourceBreakdown);
            
            if (sources.length === 0) {
                elements.ragSourcesBody.innerHTML = `
                    <tr>
                        <td colspan="4" style="padding: 16px; text-align: center; color: var(--muted);">
                            No documents ingested yet
                        </td>
                    </tr>
                `;
            } else {
                elements.ragSourcesBody.innerHTML = sources.map(([source, data]) => {
                    const avgChunks = data.count > 0 ? (data.chunks / data.count).toFixed(1) : '0';
                    const avgNum = parseFloat(avgChunks);
                    
                    // Color code avg chunks based on typical range (12-20)
                    let avgColor = 'var(--text)';
                    let avgIcon = '';
                    if (avgNum < 8) {
                        avgColor = '#f59e0b'; // amber - low chunks
                        avgIcon = '<i class="fas fa-exclamation-triangle" style="font-size: 10px; margin-left: 4px;" title="Low chunk count - document may be very short"></i>';
                    } else if (avgNum >= 12 && avgNum <= 25) {
                        avgColor = '#10b981'; // green - optimal
                        avgIcon = '<i class="fas fa-check-circle" style="font-size: 10px; margin-left: 4px;" title="Optimal chunk count"></i>';
                    } else if (avgNum > 30) {
                        avgColor = '#3b82f6'; // blue - large docs
                        avgIcon = '<i class="fas fa-info-circle" style="font-size: 10px; margin-left: 4px;" title="Large documents"></i>';
                    }
                    
                    return `
                        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                            <td style="padding: 8px;">
                                <i class="fas fa-folder" style="color: var(--muted); margin-right: 6px;"></i>${source}
                            </td>
                            <td style="padding: 8px; text-align: right;">${formatNumber(data.count)}</td>
                            <td style="padding: 8px; text-align: right;">${formatNumber(data.chunks)}</td>
                            <td style="padding: 8px; text-align: right; color: ${avgColor}; font-weight: 500;">
                                ${avgChunks}${avgIcon}
                            </td>
                        </tr>
                    `;
                }).join('');
            }
        }
        
        // Update date info
        if (elements.ragOldest) {
            elements.ragOldest.textContent = stats.oldestDocument 
                ? new Date(stats.oldestDocument).toLocaleString()
                : '—';
        }
        if (elements.ragNewest) {
            elements.ragNewest.textContent = stats.newestDocument 
                ? new Date(stats.newestDocument).toLocaleString()
                : '—';
        }
        
    } catch (error) {
        console.error('Failed to fetch RAG metrics:', error);
        
        // Show more helpful error in the UI
        if (elements.ragEmpty) {
            elements.ragEmpty.innerHTML = `
                <div style="color: var(--danger); padding: 20px; text-align: center;">
                    <i class="fas fa-exclamation-triangle"></i><br>
                    <strong>Failed to load RAG metrics</strong><br>
                    <small style="color: var(--muted);">${error.message}</small>
                </div>
            `;
            elements.ragEmpty.style.display = 'block';
        }
        
        // Set all fields to error state
        if (elements.ragTotalDocs) elements.ragTotalDocs.textContent = 'Error';
        if (elements.ragTotalChunks) elements.ragTotalChunks.textContent = 'Error';
        if (elements.ragAvgChunks) elements.ragAvgChunks.textContent = 'Error';
        if (elements.ragHealth) {
            elements.ragHealth.innerHTML = '<span style="color: var(--danger)">✗ Error</span>';
        }
    }
}

/* -------------------------------------------------------------------------- */
/*                                Initialization                              */
/* -------------------------------------------------------------------------- */

async function refreshAll() {
    elements.refreshBtn.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> Refreshing...';
    elements.refreshBtn.disabled = true;
    
    try {
        await Promise.all([
            refreshProduct(),
            refreshSystem(),
            refreshRagMetrics()
        ]);
    } catch (e) {
        console.error('Refresh failed:', e);
    } finally {
        elements.refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh';
        elements.refreshBtn.disabled = false;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
  const isAuthenticated = await checkAuth();
  if (!isAuthenticated) return;
  
  // Event Listeners
  if (elements.refreshBtn) elements.refreshBtn.addEventListener('click', refreshAll);
  if (elements.refreshRagBtn) {
    elements.refreshRagBtn.addEventListener('click', async () => {
      elements.refreshRagBtn.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> Refreshing...';
      elements.refreshRagBtn.disabled = true;
      try {
        await refreshRagMetrics();
      } finally {
        elements.refreshRagBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh';
        elements.refreshRagBtn.disabled = false;
      }
    });
  }
  
  // Toggle RAG help panel
  const toggleRagHelpBtn = document.getElementById('toggleRagHelp');
  const ragHelpPanel = document.getElementById('ragHelpPanel');
  if (toggleRagHelpBtn && ragHelpPanel) {
    toggleRagHelpBtn.addEventListener('click', () => {
      const isVisible = ragHelpPanel.style.display !== 'none';
      ragHelpPanel.style.display = isVisible ? 'none' : 'block';
    });
  }
  if (elements.periodSelect) elements.periodSelect.addEventListener('change', refreshProduct);
  if (elements.usageGroupSelect) elements.usageGroupSelect.addEventListener('change', refreshProduct);
  if (elements.feedbackGroupSelect) elements.feedbackGroupSelect.addEventListener('change', refreshProduct);
  
  // Initial Load
  refreshAll();
  
  // Poll system metrics
  systemInterval = setInterval(refreshSystem, 5000);
});
