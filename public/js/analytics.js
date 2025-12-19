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

  // System Metrics Elements
  clearCacheBtn: document.getElementById('clearCacheBtn'),
  timestamp: document.getElementById('timestamp'),
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

let activeTab = 'product';
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
  if (!bytes || bytes === 0) return '0 B';
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
    const hasActiveConnMetric = typeof conn.activeConnections === 'number';
    const activeConn = hasActiveConnMetric ? conn.activeConnections : 0;
    const maxConn = conn.poolSize || 100;
    const connUsage = maxConn > 0 ? (activeConn / maxConn) * 100 : 0;

    // Only show numeric count if valid
    elements.connActive.textContent = hasActiveConnMetric ? activeConn : 'N/A';
    elements.connMax.textContent = maxConn;
    elements.connBar.style.width = `${connUsage}%`;
    setStatus(elements.connStatus, connUsage, 70, 90, true);

    elements.connAvail.textContent = typeof conn.availableConnections === 'number' ? conn.availableConnections : 'N/A';
    elements.connWaiting.textContent = typeof conn.waitingConnections === 'number' ? conn.waitingConnections : 'N/A';
    elements.connPool.textContent = `${conn.minPoolSize}-${conn.poolSize}`;

    // --- System ---
    const usedMemMB = Math.round(sys.memory.rss / 1024 / 1024);

    elements.sysMem.textContent = formatBytes(sys.memory.rss);
    elements.sysTotalMem.textContent = formatBytes(sys.memory.heapTotal);
    const memUsagePercent = (sys.memory.heapUsed / sys.memory.heapTotal) * 100;
    elements.sysBar.style.width = `${memUsagePercent}%`;
    setStatus(elements.sysStatus, memUsagePercent, 70, 85, true);

    elements.sysNode.textContent = sys.nodeVersion || 'v18+';
    elements.sysUptime.textContent = sys.uptime.formatted;
    elements.sysPlatform.textContent = sys.platform || 'Unknown';

    elements.detailHeapUsed.textContent = sys.memory.formatted.heapUsed;
    elements.detailHeapTotal.textContent = sys.memory.formatted.heapTotal;
    elements.detailRss.textContent = sys.memory.formatted.rss;
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
/*                                Initialization                              */
/* -------------------------------------------------------------------------- */

function handleTabSwitch(tabName) {
    activeTab = tabName;

    // UI Update
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-content').forEach(c => {
        c.classList.toggle('active', c.id === `${tabName}-tab`);
    });

    // Logic Switch
    if (tabName === 'product') {
        if (systemInterval) clearInterval(systemInterval);
        refreshProduct();
    } else {
        refreshSystem();
        // Clear old interval if exists (defensive), then set new one
        if (systemInterval) clearInterval(systemInterval);
        systemInterval = setInterval(refreshSystem, 5000); // 5s poll for system stats
    }
}

async function refreshAll() {
    if (activeTab === 'product') {
        elements.refreshBtn.textContent = 'Refreshing...';
        elements.refreshBtn.disabled = true;
        await refreshProduct();
        elements.refreshBtn.textContent = 'Refresh data';
        elements.refreshBtn.disabled = false;
    } else {
        await refreshSystem();
    }
}

document.addEventListener('DOMContentLoaded', async () => {
  const isAuthenticated = await checkAuth();
  if (!isAuthenticated) return;
  
  // Event Listeners
  elements.refreshBtn.addEventListener('click', refreshAll);
  elements.periodSelect.addEventListener('change', refreshProduct);
  elements.usageGroupSelect.addEventListener('change', refreshProduct);
  elements.feedbackGroupSelect.addEventListener('change', refreshProduct);
  elements.clearCacheBtn.addEventListener('click', clearCache);

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => handleTabSwitch(e.target.dataset.tab));
  });

  // Initial Load
  handleTabSwitch('product');
});
